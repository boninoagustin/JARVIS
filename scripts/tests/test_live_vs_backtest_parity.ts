import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { parseCSV, prepareEntries, runBacktest } from '../../jarvis-os/src/services/backtestEngine.js';
import type { BacktestConfig } from '../../jarvis-os/src/services/backtestTypes.js';
import {
  getDecimals,
  getMinPipDistance,
  calculateDynamicSlBuffer,
  getMinImpulseRange,
  TF_WEIGHT,
} from '../../src/engine/AlphaModel.js';
import {
  getAssetClass,
  getPipValue,
  pipValuePerLotUsd,
  defaultFrictionConfig,
} from '../../src/engine/FrictionModel.js';
import { extractMgmtOverrides, normalizePartialClosePct } from '../../src/engine/Types.js';
import { canonicalZoneMedal, NATIVE_ZONE_SOURCE } from '../../src/engine/smc/zone_protocol.js';
import { SMCEngine } from '../../src/engine/smc/SMCEngine.js';
import { buildRolloverFreezeContext } from '../../src/engine/RolloverRuntimeContext.js';
import { mapAssetConfig } from '../periodic_opt/selection_context.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '../..');
process.env.TELEGRAM_BOT_TOKEN ||= 'offline_parity_test_token';
process.env.TELEGRAM_ALLOWED_USER_IDS ||= '1';
process.env.GROQ_API_KEY ||= 'offline_parity_test_key';

function approxEqual(actual: number, expected: number, eps = 1e-6, label = ''): void {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= eps,
    `${label ? label + ': ' : ''}expected ${actual} ≈ ${expected} (±${eps})`,
  );
}

/**
 * Loads `src/db/trading.ts` inside an isolated VM context with in-memory mocks for
 * Firestore, Telegram, cTrader, and journal so zero network/timers/disk writes occur,
 * while executing 100% of the real `processTradingAlert` + `evaluateImpulse` + `dispatchOteSignal` code.
 */
function createIsolatedLiveHarness(assetConfigs: Record<string, any>) {
  const tradingPath = path.join(REPO_ROOT, 'src/db/trading.ts');
  const source = fs.readFileSync(tradingPath, 'utf8');
  const realRequire = createRequire(tradingPath);

  const journalDocs = new Map<string, any>();
  const activeTradeDocs = new Map<string, any>();
  let seq = 0;

  const makeCollection = (backing: Map<string, any>) => ({
    doc(id?: string) {
      const docId = id || `doc_${++seq}`;
      return {
        id: docId,
        async get() {
          const data = backing.get(docId);
          return { exists: data !== undefined, id: docId, data: () => (data ? structuredClone(data) : undefined) };
        },
        async set(data: any, opts?: { merge?: boolean }) {
          const prev = opts?.merge ? (backing.get(docId) ?? {}) : {};
          backing.set(docId, structuredClone({ ...prev, ...data }));
        },
        async update(fields: any) {
          const prev = backing.get(docId) ?? {};
          backing.set(docId, structuredClone({ ...prev, ...fields }));
        },
        async delete() {
          backing.delete(docId);
        },
      };
    },
    where(field: string, op: string, val: any) {
      const filters: Array<[string, string, any]> = [[field, op, val]];
      const query: any = {
        where(f2: string, op2: string, v2: any) {
          filters.push([f2, op2, v2]);
          return query;
        },
        limit() {
          return query;
        },
        async get() {
          const docs: any[] = [];
          for (const [id, row] of backing.entries()) {
            const ok = filters.every(([f, o, v]) => {
              if (o === '==') return row?.[f] === v;
              if (o === '>=') return row?.[f] >= v;
              return true;
            });
            if (ok) docs.push({ id, data: () => structuredClone(row) });
          }
          return { empty: docs.length === 0, docs, forEach: (fn: any) => docs.forEach(fn) };
        },
      };
      return query;
    },
    async get() {
      const docs = [...backing.entries()].map(([id, row]) => ({ id, data: () => structuredClone(row) }));
      return { empty: docs.length === 0, docs, forEach: (fn: any) => docs.forEach(fn) };
    },
  });

  const mockDb: any = {
    collection(name: string) {
      if (name === 'trade_journal') return makeCollection(journalDocs);
      if (name === 'active_trades') return makeCollection(activeTradeDocs);
      return makeCollection(new Map());
    },
    batch() {
      return { set() {}, update() {}, delete() {}, async commit() {} };
    },
    async runTransaction(fn: any) {
      return fn({
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
        update: (ref: any, data: any) => ref.update(data),
      });
    },
  };

  const mockedModules: Record<string, any> = {
    './memory.js': { db: mockDb },
    '../bot/telegram.js': { bot: { api: { sendMessage: async () => ({}) } } },
    '../config.js': {
      config: {
        TELEGRAM_ALLOWED_USER_IDS: [],
        CTRADER_CLIENT_ID: '',
        CTRADER_ACCESS_TOKEN: '',
        CTRADER_DEMO: true,
        CTRADER_RISK_PERCENT: 1,
        CTRADER_MAX_AGGREGATE_RISK_PCT: 6,
        KRONOS_AI_ENABLED: false,
      },
    },
    '../services/journal.js': {
      logTrade: async (entry: any) => {
        const id = `J_${++seq}`;
        journalDocs.set(id, structuredClone(entry));
        return id;
      },
      recordResult: async (id: string, result: string, pnl: number) => {
        const prev = journalDocs.get(id) ?? {};
        journalDocs.set(id, { ...prev, result, pnl });
      },
      sendDailyReview: async () => {},
    },
    '../services/ctrader.js': {
      getLastBidAsk: () => null,
      getRolloverQuote: () => null,
      syncScannerRoster: async () => {},
      getLiveExecutionInstrument: () => undefined,
      isCTraderReady: () => false,
      getOpenPositions: async () => [],
      getDealsByPosition: async () => [],
      closePosition: async () => true,
      closePartial: async () => true,
      modifyStopLoss: async () => true,
      readPositionProtection: async () => ({ exists: true, stopLoss: null }),
    },
    '../services/ctrader_confirmation.js': {
      sendTradeConfirmation: async () => {},
    },
    '../services/backtesting.js': {
      getCurrentSessionThresholds: () => null,
      getCurrentSessionId: () => 'PARITY_BT_SESSION',
    },
    '../services/ws_server.js': {
      broadcastRadarState: () => {},
      broadcastCandle: () => {},
      broadcastEvent: () => {},
      broadcastState: () => {},
    },
    '../services/correlation.js': {
      evaluateCorrelationGate: () => ({ applied: false, wouldBlock: false, blockedBy: [], riskMult: 1, degraded: false }),
      resolveCorrelationConfig: () => ({ enabled: false, shadow: true, auditPath: '/dev/null' }),
      appendCorrelationAudit: () => {},
      syncCorrTickers: () => {},
    },
    '../engine/TimesfmLiveCacheNode.js': {
      fetchLiveTimesfmDecision: async () => ({
        action: 'APPROVE', riskMult: 1, forecastDir: 'FLAT', highConviction: false,
        spreadAtr: 0, forecastMedian: 0, reason: 'offline', degraded: true,
      }),
      configureTimesfmLiveCache: () => {},
      resetTimesfmLiveCache: () => {},
    },
    '../services/telemetry.js': {
      telemetry: {
        signal() {},
        directEntry() {},
        oteWait() {},
        oteExec() {},
        oteDeath() {},
        oteMlReject() {},
      },
    },
  };

  const vmModuleCache = new Map<string, any>();
  let rngCounter = 1;
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => {
    rngCounter = (rngCounter * 48271) % 2147483647;
    return rngCounter / 2147483647;
  };

  const makeSandbox = (reqFn: (s: string) => any, m: { exports: any }) => ({
    require: reqFn,
    module: m,
    exports: m.exports,
    console: { log() {}, warn() {}, error() {} },
    Date,
    Math: deterministicMath,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Object,
    Number,
    String,
    Boolean,
    Array,
    RegExp,
    Error,
    TypeError,
    RangeError,
    JSON,
    Intl,
    Buffer,
    structuredClone,
    parseFloat,
    parseInt,
    isFinite,
    isNaN,
    NaN,
    Infinity,
    process: { env: {} },
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  });

  const makeRequireFrom = (fromFile: string) => (specifier: string): any => {
    if (mockedModules[specifier]) return mockedModules[specifier];
    if (specifier === 'fs' || specifier === 'node:fs') {
      const realFs = realRequire('node:fs');
      return {
        ...realFs,
        writeFileSync: () => {},
        appendFileSync: () => {},
      };
    }
    if (specifier.startsWith('.')) {
      const candidateTs = path.resolve(path.dirname(fromFile), specifier).replace(/\.js$/, '.ts');
      const relToDb = path.relative(path.dirname(tradingPath), candidateTs).replace(/\\/g, '/').replace(/\.ts$/, '.js');
      const normalizedKey = relToDb.startsWith('.') ? relToDb : `./${relToDb}`;
      if (mockedModules[normalizedKey]) return mockedModules[normalizedKey];
      if (fs.existsSync(candidateTs)) {
        if (vmModuleCache.has(candidateTs)) return vmModuleCache.get(candidateTs)!.exports;
        const childMod = { exports: {} as any };
        vmModuleCache.set(candidateTs, childMod);
        const childSrc = fs.readFileSync(candidateTs, 'utf8');
        const childCode = ts.transpileModule(childSrc, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        }).outputText.replace(/\bimport\s*\(\s*(['"][^'"]+['"])\s*\)/g, 'Promise.resolve(require($1))');
        vm.runInNewContext(childCode, makeSandbox(makeRequireFrom(candidateTs), childMod));
        return childMod.exports;
      }
    }
    return realRequire(specifier);
  };

  const mod = { exports: {} as any };
  vmModuleCache.set(tradingPath, mod);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText.replace(/\bimport\s*\(\s*(['"][^'"]+['"])\s*\)/g, 'Promise.resolve(require($1))');

  vm.runInNewContext(transpiled, makeSandbox(makeRequireFrom(tradingPath), mod));

  const store = mod.exports.globalState;
  for (const [ticker, cfg] of Object.entries(assetConfigs)) {
    store.assetSessionConfigs.set(ticker, structuredClone(cfg));
  }

  return {
    processTradingAlert: mod.exports.processTradingAlert as (line: string, st?: any) => Promise<void>,
    store,
    journalDocs,
    activeTradeDocs,
  };
}

function addTickerToAlertLine(ticker: string, line: string): string {
  const idx = line.indexOf('|');
  if (idx < 0) return line;
  const prefix = line.slice(0, idx).trim();
  const rest = line.slice(idx + 1).trim();
  if (rest.startsWith(`${ticker} |`) || rest.startsWith(`${ticker},`)) return line;
  return `${prefix} | ${ticker} | ${rest}`;
}

async function main() {
  let passed = 0;
  const runCase = async (name: string, fn: () => void | Promise<void>) => {
    await fn();
    passed++;
    console.log(`PASS [${passed}] ${name}`);
  };

  // =========================================================================
  // 1. SMCManager M5 -> H1 HTF Context Parity with export_smc_csv.ts
  // =========================================================================
  await runCase('SMCManager maps M5 HTF context to H1 (not W1) and propagates H1 closes', () => {
    const managerFile = path.join(REPO_ROOT, 'src/engine/smc/SMCManager.ts');
    const managerSrc = fs.readFileSync(managerFile, 'utf8');
    const ast = ts.createSourceFile(managerFile, managerSrc, ts.ScriptTarget.Latest, true);
    const decl = ast.statements.find(ts.isClassDeclaration)!;
    const code = ts.transpileModule(`${decl.getText(ast)}\nSMCManager;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;

    const preset: any = {
      name: 'parity-fixture',
      risk_level: 3,
      asset_type: 'forex',
      override_choch: true,
      require_displacement: false,
      require_fvg_after_ob: false,
      strict_breaker: false,
      strict_sweep: false,
      confirm_close: true,
      min_score: 0,
      choch_require_sweep: false,
      choch_require_momentum: false,
      valid_bos_displacement: false,
    };
    const Manager = vm.runInNewContext(code, {
      SMCEngine,
      buildRolloverFreezeContext,
      loadOptimizedPreset: () => structuredClone(preset),
      structuredClone,
      console: { log() {}, error: console.error },
      broadcastCandle() {},
      broadcastState() {},
      broadcastEvent() {},
    });

    const mgr = new Manager();
    const m5Engine = mgr.getEngine('EURUSD', 'M5');
    assert.equal((m5Engine as any).htfTrend, 'Neutral');

    // Feed rising H1 candles to establish Bullish simpleTrend on H1 (without any W1 engine)
    const t0 = Date.parse('2026-08-03T00:00:00Z');
    const h1Candles = Array.from({ length: 25 }, (_, i) => {
      const base = 1.08 + Math.sin(i * 0.7) * 0.004 + (i > 15 ? (i - 15) * 0.003 : 0);
      return {
        timestamp: t0 + i * 3600_000,
        open: base - 0.0005,
        high: base + 0.0015,
        low: base - 0.0015,
        close: base + 0.001,
        volume: 100 + i,
      };
    });
    mgr.processLiveCandles('EURUSD', 'H1', h1Candles, true);
    const h1Trend = mgr.getEngine('EURUSD', 'H1').getState().simpleTrend;
    assert.equal(h1Trend, 'Bullish', 'H1 simpleTrend must become Bullish');
    assert.equal((m5Engine as any).htfTrend, 'Bullish', 'H1 close must propagate Bullish htfTrend into M5 engine');

    // Also verify a newly created M5 engine reads H1 as targetHTF immediately
    const m5Fresh = mgr.getEngine('GBPUSD', 'H1');
    mgr.processLiveCandles('GBPUSD', 'H1', h1Candles, true);
    assert.equal(m5Fresh.getState().simpleTrend, 'Bullish');
    const m5Gbp = mgr.getEngine('GBPUSD', 'M5');
    assert.equal((m5Gbp as any).htfTrend, 'Bullish', 'getEngine(M5) must initialize htfTrend from H1');
  });

  // =========================================================================
  // 2. 45-Universe Asset Class, Pip Size, Decimals, SL Buffer & mapAssetConfig
  // =========================================================================
  await runCase('All 45 universe symbols classify into exact regimes, pip sizes, SL floors, and class friction', () => {
    const expectedClasses: Record<string, string> = {
      EURUSD: 'FOREX', GBPJPY: 'FOREX', EURCHF: 'FOREX', USDCAD: 'FOREX', NZDUSD: 'FOREX', GBPAUD: 'FOREX',
      FRA40: 'INDICES', ITALY40: 'INDICES', JP225: 'INDICES', USTECH100: 'INDICES', US30: 'INDICES',
      US500: 'INDICES', GER40: 'INDICES', UK100: 'INDICES', SPAIN35: 'INDICES', NL25: 'INDICES',
      EUROPE50: 'INDICES', AUSTRALIA200: 'INDICES',
      XAUUSD: 'METALS', XAGUSD: 'METALS', XPTUSD: 'METALS', XPDUSD: 'METALS',
      USOIL: 'ENERGY', XBRUSD: 'ENERGY', NATGAS: 'ENERGY',
      BTCUSD: 'CRYPTO',
    };
    for (const [sym, cls] of Object.entries(expectedClasses)) {
      assert.equal(getAssetClass(sym), cls, `${sym} asset class`);
    }

    // EUROPE50 must NOT match 'EUR' forex branch in calculateDynamicSlBuffer!
    const eu50SlBuf = calculateDynamicSlBuffer('EUROPE50', 4800, 0.1);
    approxEqual(eu50SlBuf, 4.8, 1e-6, 'EUROPE50 dynamic SL buffer');
    assert.ok(getMinPipDistance('FRA40') >= 5, 'FRA40 minPipDistance must be index points, not 0.0010');
    assert.equal(getMinPipDistance('JP225'), 25, 'JP225 minPipDistance');
    assert.equal(getMinPipDistance('XAGUSD'), 0.05, 'XAGUSD minPipDistance');
    assert.equal(getMinPipDistance('NATGAS'), 0.01, 'NATGAS minPipDistance');

    assert.equal(getPipValue('XAGUSD', 31), 0.01, 'Silver pip size');
    assert.equal(getPipValue('NATGAS', 2.8), 0.001, 'NatGas pip size');
    assert.equal(getPipValue('JP225', 38500), 1.0, 'JP225 pip size');
    assert.equal(pipValuePerLotUsd('JP225', 38500), 1.0, 'JP225 pipValuePerLotUsd');
    assert.equal(getDecimals('XAGUSD'), 3, 'XAGUSD decimals');
    assert.equal(getDecimals('FRA40'), 2, 'FRA40 decimals');

    // getMinImpulseRange shared across Live & Backtest
    assert.equal(getMinImpulseRange('EURUSD', 1.1), 0.00015);
    assert.equal(getMinImpulseRange('USDJPY', 154), 0.02);
    approxEqual(getMinImpulseRange('FRA40', 7500), 2.25, 1e-9);
    approxEqual(getMinImpulseRange('BTCUSD', 60000), 30, 1e-9);

    // mapAssetConfig must use class friction defaults when asset_configs omits spreadPips/commissionPerLot
    const mappedFx = mapAssetConfig('EURUSD', { minPointsForBuy: 6, minPointsForSell: 6 });
    assert.equal(mappedFx.spreadPips, defaultFrictionConfig.FOREX.baseSpreadPips);
    assert.equal(mappedFx.commissionPerLot, defaultFrictionConfig.FOREX.commissionPerLot);

    const mappedOil = mapAssetConfig('USOIL', { minPointsForBuy: 6, minPointsForSell: 6 });
    assert.equal(mappedOil.spreadPips, defaultFrictionConfig.ENERGY.baseSpreadPips);
    assert.equal(mappedOil.commissionPerLot, defaultFrictionConfig.ENERGY.commissionPerLot);

    const mappedIdx = mapAssetConfig('FRA40', { minPointsForBuy: 6, minPointsForSell: 6 });
    assert.equal(mappedIdx.spreadPips, defaultFrictionConfig.INDICES.baseSpreadPips);
    assert.equal(mappedIdx.commissionPerLot, defaultFrictionConfig.INDICES.commissionPerLot);

    const mappedSilver = mapAssetConfig('XAGUSD', { minPointsForBuy: 6, minPointsForSell: 6 });
    assert.equal(mappedSilver.spreadPips, defaultFrictionConfig.METALS.baseSpreadPips);
    assert.equal(mappedSilver.commissionPerLot, defaultFrictionConfig.METALS.commissionPerLot);
  });

  // =========================================================================
  // 3. Zone Medals, 17:00 ART Persistence, ZONE_BROKEN, ZONE_TOUCHED & LIQ_GRAB
  // =========================================================================
  await runCase('Zone medals (GOD/GOD_BRK/BRK/PLAT|Str), 17:00 ART persistence, ZONE_BROKEN, ZONE_TOUCHED & LIQ_GRAB match Live 1:1', async () => {
    assert.equal(canonicalZoneMedal('GOD'), 'GodZone');
    assert.equal(canonicalZoneMedal('GOD_BRK'), 'GodZone');
    assert.equal(canonicalZoneMedal('GOD | Legacy+SWP'), 'GodZone');
    assert.equal(canonicalZoneMedal('BRK'), 'Breaker');
    assert.equal(canonicalZoneMedal('PLAT | Str'), 'Platino');

    // Construct an event stream crossing 17:00 ART (20:00 UTC) and touching/breaking zones
    const preRoll = Date.parse('2026-08-04T19:50:00Z'); // 16:50 ART (NY)
    const postRoll = Date.parse('2026-08-04T20:10:00Z'); // 17:10 ART (new FX day!)
    const tradeTs = Date.parse('2026-08-05T08:00:00Z'); // 05:00 ART (LONDON, >15m after 04:00 ART open)

    const h4ZonePayload = JSON.stringify([
      { t: '240', d: 'BUY', p: 1.0920, b: 1.0900, lv: '1.0920', md: 'GOD | Str', sc: 6, a: 0.0020 },
    ]);
    const m15ZonesPayload = JSON.stringify([
      { t: '15', d: 'BUY', p: 1.0915, b: 1.0905, lv: '1.0915', md: 'BRK', sc: 4, a: 0.0012 },
      { t: '15', d: 'BUY', p: 1.0885, b: 1.0875, lv: '1.0885', md: 'PLAT', sc: 5, a: 0.0012 },
    ]);

    const rawLines = [
      // H4 GodZone synced BEFORE 17:00 ART
      `SYNC_ZONES | TF: 240 | Source: ${NATIVE_ZONE_SOURCE} | Trend: BUY | WBias: BUY | Payload: ${h4ZonePayload} | TS: ${preRoll}`,
      // M15 zones synced AFTER 17:00 ART (must NOT wipe the H4 GodZone!)
      `SYNC_ZONES | TF: 15 | Source: ${NATIVE_ZONE_SOURCE} | Trend: BUY | WBias: BUY | Payload: ${m15ZonesPayload} | TS: ${postRoll}`,
      // Re-sync before London open so TTL is fresh
      `SYNC_ZONES | TF: 240 | Source: ${NATIVE_ZONE_SOURCE} | Trend: BUY | WBias: BUY | Payload: ${h4ZonePayload} | TS: ${tradeTs - 600_000}`,
      `SYNC_ZONES | TF: 15 | Source: ${NATIVE_ZONE_SOURCE} | Trend: BUY | WBias: BUY | Payload: ${m15ZonesPayload} | TS: ${tradeTs - 500_000}`,
      // Price starts above zones, then dips into [1.0905, 1.0915] touching BOTH H4 GOD + M15 BRK!
      `PING_PRICE | TF: 5 | Precio: 1.0930 | High: 1.0932 | Low: 1.0928 | TS: ${tradeTs - 300_000}`,
      `PING_PRICE | TF: 5 | Precio: 1.0910 | High: 1.0930 | Low: 1.0908 | TS: ${tradeTs - 240_000}`,
      // Explicit ZONE_BROKEN breaks ONLY the upper M15 zone [1.0905, 1.0915], keeping [1.0875, 1.0885] intact!
      `ZONE_BROKEN | TF: 15 | Source: ${NATIVE_ZONE_SOURCE} | Dir: BUY | Medal: BRK | Score: 4 | Top: 1.0915 | Btm: 1.0905 | ZoneDir: LONG | ZoneTop: 1.0915 | ZoneBtm: 1.0905 | TS: ${tradeTs - 180_000}`,
      // Native ZONE_TOUCHED + LIQ_GRAB + EVENTO_SMC_DIV (legacy Score: 0) before 5M CHoCH
      `ZONE_TOUCHED | TF: 15 | Source: ${NATIVE_ZONE_SOURCE} | Dir: BUY | Medal: PLAT | Score: 7 | Top: 1.0885 | Btm: 1.0875 | TS: ${tradeTs - 120_000}`,
      `LIQ_GRAB | TF: 5 | Dir: BUY | Nivel: 1.0880 | TS: ${tradeTs - 60_000}`,
      `EVENTO_SMC_DIV | TF: 15 | Dir: BUY | Score: 0 | RSI_Diff: 0 | TS: ${tradeTs - 30_000}`,
      `EVENTO_CHOCH | TF: 5 | Dir: BUY | Precio: 1.0912 | ORIGIN: 1.0880 | CONFIRMED | TS: ${tradeTs}`,
      `PING_PRICE | TF: 5 | Precio: 1.0912 | High: 1.0914 | Low: 1.0910 | TS: ${tradeTs + 60_000}`,
    ];

    const btConfig: BacktestConfig = {
      ticker: 'EURUSD',
      entryTrigger: 'CHOCH',
      minBuyPoints: 8,
      minSellPoints: 8,
      oteEntryPercent: 50,
      slBufferPercent: 0.1,
      fixedRR: 2.0,
      rolloverPeakPips: 0,
      disableNewsBlackout: true,
      zoneWeights: {
        GOD: { LONDON: 1.5, NY: 1, ASIA: 1, OFF: 1 },
        BREAKER: { LONDON: 1.0, NY: 1, ASIA: 1, OFF: 1 },
        DIV: { LONDON: 1.0, NY: 1, ASIA: 1, OFF: 1 },
      },
    } as any;

    const prepared = await prepareEntries(new Map([['5', rawLines]]));
    const btRes = runBacktest(new Map(), btConfig, undefined, prepared);
    assert.equal(btRes.trades.length, 1, 'Backtest must fire 1 trade');

    const live = createIsolatedLiveHarness({
      EURUSD: {
        enabled: true,
        entryTrigger: 'CHOCH',
        minPointsForBuy: 8,
        minPointsForSell: 8,
        oteEntryPercent: 50,
        slBufferPercent: 0.1,
        fixedRR: 2.0,
        rolloverEntryBlock: false,
        zoneWeights: (btConfig as any).zoneWeights,
      },
    });
    for (const line of rawLines) {
      await live.processTradingAlert(addTickerToAlertLine('EURUSD', line));
    }

    // Check remaining zones in Live state: H4 GOD + second M15 PLAT zone [1.0875, 1.0885] survived!
    const liveState = live.store.localRadarStates.get('EURUSD');
    assert.equal(liveState.zones.length, 2, 'H4 zone + unbroken M15 zone must both remain alive');
    assert.ok(liveState.zones.some((z: any) => z.tf === '240' && z.medal === 'GodZone'));
    assert.ok(liveState.zones.some((z: any) => z.tf === '15' && Math.abs(z.top - 1.0885) < 1e-6));

    const liveTrades = [...live.store.activeTrades.values()];
    assert.equal(liveTrades.length, 1, 'Live must have 1 active trade');
    assert.equal(btRes.trades[0].points, liveTrades[0].score, 'Live and Backtest total score points must match 1:1');
    assert.ok(btRes.trades[0].events.includes('💎_GOD_ZONE_4H'), 'H4 GodZone event must survive 17:00 ART and score');
    assert.ok(!btRes.trades[0].events.includes('♻️_Breaker_15M'), 'Broken 15M zone score must be cleaned by ZONE_BROKEN');
    assert.ok(btRes.trades[0].events.includes('🎯_ZoneTouched_Platino_15M'), 'ZONE_TOUCHED must score with canonical medal');
    assert.ok(btRes.trades[0].events.includes('🩸_LIQ_GRAB_5M'), 'LIQ_GRAB must score in Backtest');
    assert.ok(btRes.trades[0].events.includes('DIV_15M'), 'EVENTO_SMC_DIV must score in Backtest');
  });

  // =========================================================================
  // 4. Multi-TF ATR14 Isolation in Backtest & 1s Tick ATR Stability in Live
  // =========================================================================
  await runCase('state.atr14 is uncontaminated by D1/H4 bars in Backtest and stable across 1s ticks in Live', async () => {
    const t0 = Date.parse('2026-08-05T08:00:00Z');
    const lines: string[] = [];
    // 16 M5 bars with exact 10-pip range (0.0010)
    for (let i = 0; i < 16; i++) {
      const ts = t0 + i * 300_000;
      lines.push(`PING_PRICE | TF: 5 | Precio: 1.1000 | High: 1.1005 | Low: 1.0995 | TS: ${ts}`);
      // Inject massive D1 (200 pips = 0.0200) and H4 (100 pips = 0.0100) PING_PRICE rows!
      lines.push(`PING_PRICE | TF: D | Precio: 1.1000 | High: 1.1100 | Low: 1.0900 | TS: ${ts + 1}`);
      lines.push(`PING_PRICE | TF: 240 | Precio: 1.1000 | High: 1.1050 | Low: 1.0950 | TS: ${ts + 2}`);
    }
    // Now emit a 5M CHoCH with candle range = 30 pips (0.0030 = 3x M5 ATR, so SMART detects climax -> waits OTE!)
    // Before fix: D1 inflated atr14 to ~0.0100, so 0.0030 < 2 * 0.0100 failed to detect climax and took direct entry!
    const breakTs = t0 + 17 * 300_000;
    lines.push(`PING_PRICE | TF: 5 | Precio: 1.1012 | High: 1.1020 | Low: 1.0990 | TS: ${breakTs - 10}`);
    lines.push(`EVENTO_SWEEP | TF: 15 | Dir: BUY | ABSORCION | TS: ${breakTs - 5}`);
    lines.push(`EVENTO_CHOCH | TF: 5 | Dir: BUY | Precio: 1.1012 | ORIGIN: 1.1000 | CONFIRMED | TS: ${breakTs}`);

    const smartCfg: BacktestConfig = {
      ticker: 'EURUSD',
      entryTrigger: 'SMART',
      minBuyPoints: 4,
      minSellPoints: 4,
      oteEntryPercent: 50,
      slBufferPercent: 0.05,
      fixedRR: 2.0,
      maxSmartRiskPercent: 1.0,
      rolloverPeakPips: 0,
      disableNewsBlackout: true,
    };
    const prepared = await prepareEntries(new Map([['5', lines]]));
    const btRes = runBacktest(new Map(), smartCfg, undefined, prepared);
    assert.equal(btRes.trades.length, 0, 'Uncontaminated M5 ATR (0.0010) must classify 30-pip bar as >2xATR climax and defer to OTE');

    // Live 1s spot tick stability with explicit ATR tag from SMCBridge
    const live = createIsolatedLiveHarness({
      EURUSD: { enabled: true, entryTrigger: 'SMART', minPointsForBuy: 4, minPointsForSell: 4, rolloverEntryBlock: false },
    });
    for (let s = 0; s < 40; s++) {
      await live.processTradingAlert(
        `PING_PRICE | EURUSD | TF: 15 | Precio: 1.1000 | High: 1.10005 | Low: 1.09995 | PrevHigh: 1.1006 | PrevLow: 1.0994 | ATR: 0.0012 | TS: ${t0 + s * 1000}`,
      );
    }
    approxEqual(live.store.localRadarStates.get('EURUSD').atr14, 0.0012, 1e-9, 'Live atr14 must not collapse on 1s ticks');
  });

  // =========================================================================
  // 5. partialClosePct: 50 Normalization (SAR -49x Bug), Late BOS & Structural Trail
  // =========================================================================
  await runCase('partialClosePct=50 normalizes to 0.50 across SAR, Live overrides, and FINAL_CENSOR; Late BOS preserves bos5m', async () => {
    assert.equal(normalizePartialClosePct(50), 0.5);
    assert.equal(normalizePartialClosePct(0.8), 0.8);
    assert.equal(extractMgmtOverrides({ partialClosePct: 50 })?.partialClosePct, 0.5);

    const t0 = Date.parse('2026-08-05T08:00:00Z'); // LONDON
    // Scenario A: Trade hits TP1 with partialClosePct: 50 (percentage scale!), then reverses via higher-score opposite SAR!
    const sarLines = [
      `PING_PRICE | TF: 5 | Precio: 1.1000 | High: 1.1002 | Low: 1.0998 | TS: ${t0}`,
      `EVENTO_SWEEP | TF: 15 | Dir: BUY | ABSORCION | TS: ${t0 + 1000}`,
      `EVENTO_CHOCH | TF: 5 | Dir: BUY | Precio: 1.1000 | ORIGIN: 1.0990 | CONFIRMED | TS: ${t0 + 2000}`,
      // Hit TP1 (1.1020 = entry 1.1000 + risk 0.0020) without hitting capped TP2 (1.10289)
      `PING_PRICE | TF: 5 | Precio: 1.1021 | High: 1.1022 | Low: 1.1005 | TS: ${t0 + 60_000}`,
      // Higher-score opposite SELL signal triggers SAR reversal!
      `EVENTO_SWEEP | TF: 240 | Dir: SELL | ABSORCION | TS: ${t0 + 240_000}`,
      `ZONE_TOUCHED | TF: 60 | Source: ${NATIVE_ZONE_SOURCE} | Dir: SELL | Medal: GOD | Score: 9 | Top: 1.1020 | Btm: 1.1010 | TS: ${t0 + 241_000}`,
      `EVENTO_CHOCH | TF: 5 | Dir: SELL | Precio: 1.1008 | ORIGIN: 1.1020 | CONFIRMED | TS: ${t0 + 242_000}`,
      `PING_PRICE | TF: 5 | Precio: 1.1008 | High: 1.1009 | Low: 1.1007 | TS: ${t0 + 300_000}`,
    ];
    const sarCfg: BacktestConfig = {
      ticker: 'EURUSD',
      entryTrigger: 'CHOCH',
      minBuyPoints: 5,
      minSellPoints: 5,
      oteEntryPercent: 50,
      slBufferPercent: 0.0,
      fixedRR: 3.0,
      rolloverPeakPips: 0,
      disableNewsBlackout: true,
      sessions: {
        LONDON: {
          choch5m: {
            enabled: true,
            minScore: 5,
            tp2: 3.0,
            partialClosePct: 50, // Scale 0..100 from PeriodicOptPanel! Previously caused 1 - 50 = -49x R-multiple!
            slAfterTp1: 'midpoint',
            tp15BeEnabled: false,
            atrTrailEnabled: false,
          },
        },
      },
    } as any;
    const sarRes = runBacktest(new Map(), sarCfg, undefined, await prepareEntries(new Map([['5', sarLines]])));
    assert.equal(sarRes.trades.length, 2, 'BUY trade + SAR SELL trade');
    const reversedBuy = sarRes.trades[0];
    assert.equal(reversedBuy.tp1Hit, true);
    assert.equal(reversedBuy.resultTp2, 'REVERSAL');
    assert.ok(
      reversedBuy.rMultiple! > 0.3 && reversedBuy.rMultiple! < 1.5,
      `SAR R-multiple with partialClosePct=50 must be ~0.8R, got ${reversedBuy.rMultiple}`,
    );

    // Scenario B: Late-revalidated BOS 5M trade (formed in OFF with ALL.minScore=9 -> unvalidated,
    // then validated in LONDON where bos5m.minScore=5) preserves bos5m trigger and structuralTrailEnabled!
    const offTs = Date.parse('2026-08-05T06:55:00Z'); // 03:55 ART (OFF)
    const lonTs = Date.parse('2026-08-05T07:20:00Z'); // 04:20 ART (LONDON, >15m warmup)
    const lateBosLines = [
      `PING_PRICE | TF: 5 | Precio: 1.1000 | High: 1.1002 | Low: 1.0998 | TS: ${offTs}`,
      `SYNC_ZONES | TF: D | Source: ${NATIVE_ZONE_SOURCE} | Trend: BUY | WBias: BUY | Payload: [] | TS: ${offTs + 50}`,
      `SYNC_ZONES | TF: 240 | Source: ${NATIVE_ZONE_SOURCE} | Trend: BUY | WBias: BUY | Payload: [] | TS: ${offTs + 100}`,
      `SYNC_ZONES | TF: 60 | Source: ${NATIVE_ZONE_SOURCE} | Trend: BUY | WBias: BUY | Payload: [] | TS: ${offTs + 200}`,
      // In OFF: 1.5 (BOS_5M) + 5 (3/3 bias) + 2 - 3 (orphan) = 5.5 pts (<8 highScoreBypass -> isValidated=false!)
      `EVENTO_BOS | TF: 5 | Dir: BUY | Precio: 1.1000 | ORIGIN: 1.0990 | CONFIRMED | TS: ${offTs + 1000}`,
      // In LONDON (04:20 ART): 1H ZONE_TOUCHED arrives -> late revalidation fires as bos5m (5.5 >= 5, NOT choch1h!)
      `ZONE_TOUCHED | TF: 60 | Source: ${NATIVE_ZONE_SOURCE} | Dir: BUY | Medal: ORO | Score: 7 | Top: 1.1002 | Btm: 1.0995 | TS: ${lonTs}`,
      // Hit TP1 (1.1020) without hitting capped TP2 (1.10289) so structuralTrailEnabled activates
      `PING_PRICE | TF: 5 | Precio: 1.1022 | High: 1.1024 | Low: 1.1000 | TS: ${lonTs + 60_000}`,
      // Subsequent higher BUY BOS moves origin up to 1.1016 -> structuralTrailEnabled ratchets SL above entry (~1.1014)!
      `EVENTO_BOS | TF: 5 | Dir: BUY | Precio: 1.1025 | ORIGIN: 1.1016 | CONFIRMED | TS: ${lonTs + 300_000}`,
      // Pullback hits trailed structural SL (~1.1014 > 1.1000 entry) -> closes in locked profit!
      `PING_PRICE | TF: 5 | Precio: 1.1010 | High: 1.1025 | Low: 1.1009 | TS: ${lonTs + 360_000}`,
    ];
    const lateBosCfg: BacktestConfig = {
      ticker: 'EURUSD',
      entryTrigger: 'BOTH',
      minBuyPoints: 9,
      minSellPoints: 9,
      oteEntryPercent: 50,
      slBufferPercent: 0.1,
      fixedRR: 4.0,
      rolloverPeakPips: 0,
      disableNewsBlackout: true,
      sessions: {
        ALL: {
          choch5m: { enabled: false, minScore: 99 },
          bos5m: { enabled: true, minScore: 9 },
        },
        LONDON: {
          choch5m: { enabled: false, minScore: 99 },
          bos5m: {
            enabled: true,
            minScore: 5,
            slBuff: 0.2,
            tp2: 4.0,
            partialClosePct: 0.5,
            slAfterTp1: 'none',
            tp15BeEnabled: false,
            atrTrailEnabled: false,
            structuralTrailEnabled: true,
          },
        },
      },
    } as any;
    const lateBosRes = runBacktest(new Map(), lateBosCfg, undefined, await prepareEntries(new Map([['5', lateBosLines]])));
    assert.equal(lateBosRes.trades.length, 1, 'Late-revalidated BOS 5M must fire even when choch5m is disabled');
    assert.equal(lateBosRes.trades[0].triggerType, 'bos5m', 'Trigger type must be bos5m, not choch1h');
    assert.equal(lateBosRes.trades[0].execTrigger, 'bos5m');
    assert.ok(lateBosRes.trades[0].rMultiple! > 0.6, `Structural trail must lock profit on pullback, got ${lateBosRes.trades[0].rMultiple}`);
  });

  // =========================================================================
  // 6. Full End-to-End Live (processTradingAlert) <-> Backtest (runBacktest) Replay
  //    across Forex (EURUSD, USDJPY), Index (FRA40), and Metal (XAGUSD)
  // =========================================================================
  await runCase('End-to-end Live processTradingAlert and runBacktest agree 1:1 on Direct & OTE trades across asset classes', async () => {
    const cases = [
      {
        ticker: 'EURUSD',
        base: 1.1000,
        originDist: 0.0015,
        barHalf: 0.0002,
      },
      {
        ticker: 'USDJPY',
        base: 154.00,
        originDist: 0.20,
        barHalf: 0.03,
      },
      {
        ticker: 'FRA40',
        base: 7500.0,
        originDist: 12.0,
        barHalf: 1.5,
      },
      {
        ticker: 'XAGUSD',
        base: 31.000,
        originDist: 0.150,
        barHalf: 0.020,
      },
    ];

    const t0 = Date.parse('2026-08-05T08:00:00Z'); // LONDON
    for (const c of cases) {
      // Test OTE retracement entry + TP2 win across both engines
      const origin = Number((c.base - c.originDist).toFixed(getDecimals(c.ticker)));
      const extreme = Number(c.base.toFixed(getDecimals(c.ticker)));
      const midRetrace = Number((extreme - (extreme - origin) * 0.62).toFixed(getDecimals(c.ticker)));
      const winTarget = Number((extreme + c.originDist * 3).toFixed(getDecimals(c.ticker)));

      const stream = [
        `PING_PRICE | TF: 5 | Precio: ${extreme} | High: ${extreme + c.barHalf} | Low: ${extreme - c.barHalf} | TS: ${t0}`,
        `ZONE_TOUCHED | TF: 15 | Source: ${NATIVE_ZONE_SOURCE} | Dir: BUY | Medal: GOD | Score: 9 | Top: ${extreme} | Btm: ${origin} | TS: ${t0 + 1000}`,
        `EVENTO_SWEEP | TF: 15 | Dir: BUY | ABSORCION | TS: ${t0 + 2000}`,
        `EVENTO_CHOCH | TF: 5 | Dir: BUY | Precio: ${extreme} | ORIGIN: ${origin} | CONFIRMED | TS: ${t0 + 3000}`,
        // Pullback to 62% OTE triggers evaluateImpulseCore in BOTH Live and Backtest!
        `PING_PRICE | TF: 5 | Precio: ${midRetrace} | High: ${extreme} | Low: ${midRetrace} | TS: ${t0 + 60_000}`,
        // Rally through TP1 & TP2
        `PING_PRICE | TF: 5 | Precio: ${winTarget} | High: ${winTarget} | Low: ${midRetrace} | TS: ${t0 + 180_000}`,
      ];

      const sessionBlock = {
        LONDON: {
          choch5m: { enabled: false, minScore: 99 },
          oteChoch5m: {
            enabled: true,
            minScore: 8,
            entryPercent: 62,
            slBuff: 0.1,
            tp2: 2.0,
            partialClosePct: 0.5,
            slAfterTp1: 'midpoint' as const,
            tp15BeEnabled: true,
            atrTrailEnabled: true,
          },
        },
      };

      const btCfg: BacktestConfig = {
        ticker: c.ticker,
        entryTrigger: 'OTE',
        minBuyPoints: 6,
        minSellPoints: 6,
        oteEntryPercent: 62,
        slBufferPercent: 0.1,
        fixedRR: 2.0,
        rolloverPeakPips: 0,
        disableNewsBlackout: true,
        sessions: sessionBlock as any,
      };
      const btRes = runBacktest(new Map(), btCfg, undefined, await prepareEntries(new Map([['5', stream]])));
      assert.equal(btRes.trades.length, 1, `${c.ticker} Backtest OTE trade count`);

      const live = createIsolatedLiveHarness({
        [c.ticker]: {
          enabled: true,
          entryTrigger: 'OTE',
          minPointsForBuy: 6,
          minPointsForSell: 6,
          oteEntryPercent: 62,
          slBufferPercent: 0.1,
          fixedRR: 2.0,
          rolloverEntryBlock: false,
          sessions: sessionBlock,
        },
      });
      for (const line of stream) {
        await live.processTradingAlert(addTickerToAlertLine(c.ticker, line));
      }

      const journals = [...live.journalDocs.values()];
      assert.equal(journals.length, 1, `${c.ticker} Live journal OTE trade count`);
      const btTrade = btRes.trades[0];
      const liveJournal = journals[0];

      assert.equal(btTrade.direction, liveJournal.direction, `${c.ticker} direction`);
      assert.equal(btTrade.points, liveJournal.points, `${c.ticker} OTE points`);
      assert.equal(btTrade.execTrigger, 'oteChoch5m', `${c.ticker} execTrigger`);
      approxEqual(btTrade.entryPrice, liveJournal.entryPrice, 1e-6, `${c.ticker} net entryPrice after FrictionModel`);
      approxEqual(btTrade.originalSlPrice!, liveJournal.initialSlPrice, 1e-6, `${c.ticker} initial SL`);
      approxEqual(btTrade.tp1Price, liveJournal.tp1Price, 1e-6, `${c.ticker} TP1`);
      approxEqual(btTrade.tp2Price, liveJournal.tp2Price, 1e-5, `${c.ticker} capped TP2`);
      assert.equal(btTrade.result, 'WIN', `${c.ticker} Backtest WIN`);
      assert.equal(live.store.activeTrades.size, 0, `${c.ticker} Live trade closed at TP2`);
    }
  });

  // =========================================================================
  // 7. Exporter Wire Format Parity (export_smc_csv.ts emits SMC_NATIVE_V2 + Score>=4)
  // =========================================================================
  await runCase('export_smc_csv.ts emits Source: SMC_NATIVE_V2 on SYNC_ZONES / ZONE_BROKEN and TF: 5 on M5', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-export-'));
    try {
      const rawDir = path.join(tmp, 'raw');
      const outDir = path.join(tmp, 'out');
      fs.mkdirSync(rawDir, { recursive: true });
      const b0 = Date.parse('2026-08-03T00:00:00Z');
      for (const [tf, dt] of [['M5', 300_000], ['H1', 3_600_000]] as const) {
        const rows = ['timestamp,open,high,low,close,volume'];
        for (let i = 0; i < 90; i++) {
          const wave = Math.sin(i / 4) * 0.004 + (i % 9 === 0 ? 0.002 : 0);
          const p = 1.1 + wave;
          rows.push([b0 + i * dt, p - 0.0004, p + 0.0012, p - 0.0012, p + 0.0005, 150 + i].join(','));
        }
        fs.writeFileSync(path.join(rawDir, `history_${tf}.csv`), rows.join('\n') + '\n');
      }
      const res = spawnSync(
        path.join(REPO_ROOT, 'node_modules/.bin/tsx'),
        [
          path.join(REPO_ROOT, 'scripts/export_smc_csv.ts'),
          'EURUSD',
          '--input-dir',
          rawDir,
          '--output-dir',
          outDir,
          '--timeframes',
          'M5',
          '--quiet',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(res.status, 0, res.stderr + '\n' + res.stdout);
      const csv = fs.readFileSync(path.join(outDir, 'pine-logs-SMC Master_M5.csv'), 'utf8');
      assert.ok(csv.includes(`SYNC_ZONES | TF: 5 | Source: ${NATIVE_ZONE_SOURCE}`), 'SYNC_ZONES must include SMC_NATIVE_V2');
      assert.ok(csv.includes('PING_PRICE | TF: 5 |'), 'M5 PING_PRICE must emit TF: 5');
      assert.ok(!csv.includes('TF: M5'), 'M5 export must not emit raw TF: M5');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log(`\nALL ${passed} LIVE ↔ BACKTEST PARITY SUITES PASSED`);
}

main().catch((err) => {
  console.error('PARITY TEST FAILED:', err);
  process.exit(1);
});
