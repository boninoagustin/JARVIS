import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { parseCSV, runBacktest } from '../../jarvis-os/src/services/backtestEngine';
const engineFile = new URL('../../jarvis-os/src/services/backtestEngine.ts', import.meta.url);
function loadEngine(source = fs.readFileSync(engineFile, 'utf8'), requireOverride?: any): any {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText,
    { require: requireOverride ?? createRequire(engineFile), module, exports: module.exports, console, Date, Map, Set, Math,
      process, structuredClone, Object, Number, JSON, TextEncoder, TextDecoder, atob, btoa });
  return module.exports;
}
const { testCloseModeledTrade, testManageModeledTrade } = loadEngine(fs.readFileSync(engineFile, 'utf8') + '\nexports.testCloseModeledTrade = typeof closeModeledTrade === "function" ? closeModeledTrade : undefined;\nexports.testManageModeledTrade = typeof manageModeledTrade === "function" ? manageModeledTrade : undefined;');
const routeModeledSmart = loadEngine(fs.readFileSync(engineFile, 'utf8') + '\nexports.route = typeof routeModeledSmart === "function" ? routeModeledSmart : undefined;').route;
import type { BacktestConfig } from '../../jarvis-os/src/services/backtestTypes';
import type { ExecutionInstrument, ExecutionObservation } from '../../src/engine/ExecutionTypes';
import { createExecutionPositionState } from '../../src/engine/ExecutionMicrostructure';
import { buildExecutionObservation, getExecutionSnapshot, ingestExecutionContext } from '../../src/engine/ExecutionContext';

function archivedEngine(): any {
  const archive = process.env.EXECUTION_PRE_ARCHIVE ?? '/tmp/jarvis-execution-before-d88aiwrm/source.tar';
  const names = new Set(execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n'));
  const cache = new Map<string, any>();
  function load(file: string): any {
    if (cache.has(file)) return cache.get(file);
    const source = execFileSync('tar', ['-xOf', archive, file], { encoding: 'utf8' });
    const filename = new URL(`../../${file}`, import.meta.url);
    const realRequire = createRequire(filename);
    const req = (specifier: string) => {
      if (specifier.startsWith('.')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.js$/, '.ts');
        const candidate = resolved.endsWith('.ts') ? resolved : `${resolved}.ts`;
        // Archive wrappers reference root Alpha/Friction through jarvis-os barrels.
        const root = candidate.replace(/^jarvis-os\/src\/engine\/(AlphaModel|FrictionModel)\.ts$/, 'src/engine/$1.ts');
        if (names.has(root)) return load(root);
      }
      return realRequire(specifier);
    };
    const module = { exports: {} }; cache.set(file, module.exports);
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText,
      { require: req, module, exports: module.exports, console, Date, Map, Set, Math, process, structuredClone, Object, Number, JSON });
    return module.exports;
  }
  return load('jarvis-os/src/services/backtestEngine.ts');
}

const start = Date.parse('2026-07-14T15:00:00Z');
const instrument: ExecutionInstrument = { ticker: 'EURUSD', regime: 'FOREX', pipSize: .0001,
  tickSize: .00001, pipValuePerLotUsd: 10, baseSpreadPips: 1, exitSlippagePips: .2,
  commissionPerLotSideUsd: 3, minStopDistance: 0, source: 'explicit_model' };
const config: BacktestConfig = { ticker: 'EURUSD', entryTrigger: 'CHOCH', minBuyPoints: 1,
  minSellPoints: 1, oteEntryPercent: 62, maxTradesPerDay: 1, rolloverPeakPips: 0 };
const experimental = (extra: any = {}): BacktestConfig => ({ ...config,
  executionPolicy: { profile: 'microstructure_v1' }, executionInstrument: { ...instrument }, ...extra });
const event = (prefix: string, time: number, extra = '', tf = '5', observation?: ExecutionObservation) => {
  let line = `${prefix} | TF: ${tf} | ${extra} | TS: ${time}`;
  if (observation) line += ` | EX1: ${Buffer.from(JSON.stringify(observation)).toString('base64url')}`;
  return parseCSV(line).lines[0];
};
const ping = (time: number, price = 1.1, high = price + .0002, low = price - .0002, observation?: ExecutionObservation) =>
  event('PING_PRICE', time, `Precio: ${price} | High: ${high} | Low: ${low}`, '5', observation);
const legacySetup = (time = start) => [ping(time), event('EVENTO_CHOCH', time + 1, 'BUY | ORIGIN: 1.099 | Precio: 1.1')];
// Match the historical producer: closed current OHLC, nominal close availability,
// no forming defaults or broker ticks. Fifteen contiguous closes seed fourteen TRs.
const contextWarmup = (time = start, price = 1.1, ticker = 'EURUSD', range = .001) =>
  Array.from({ length: 15 }, (_, i) => {
    const at = time - (14 - i) * 300_000;
    const observation = closedObservation(at, price, ticker, range);
    return ping(at, price, observation.bar!.high, observation.bar!.low, observation);
  });
const setup = (time = start, price = 1.1, origin = 1.099, ticker = 'EURUSD', range = .001) => [
  ...contextWarmup(time, price, ticker, range),
  event('EVENTO_CHOCH', time + 1, `BUY | ORIGIN: ${origin} | Precio: ${price}`, '5',
    { ...closedObservation(time, price, ticker, range), observedAtMs: time + 1 }),
];
function run(entries: any[], cfg: BacktestConfig = config, progress?: any): any {
  const random = Math.random; Math.random = () => .123456789;
  try { return runBacktest(new Map(), structuredClone(cfg), progress, entries); }
  finally { Math.random = random; }
}
let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  if (process.env.EXECUTION_BT_CASE && !name.includes(process.env.EXECUTION_BT_CASE)) return;
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (error) { console.error(`FAIL ${name}`, error); failed++; }
}

test('EX1 suffix is stripped before legacy parsing and preserves observation separately', () => {
  const observation: ExecutionObservation = { schema: 1, ticker: 'EURUSD', tf: '5', observedAtMs: start };
  const withContext = event('PING_PRICE', start, 'Precio: 1.1', '5', observation);
  assert.deepEqual(withContext.parsed?.executionObservation, observation);
  const without = event('PING_PRICE', start, 'Precio: 1.1');
  const { executionObservation: _, ...parsed } = withContext.parsed!;
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(without.parsed)));
  assert.ok(!withContext.line.includes('EX1:'), 'line used by prefix/scoring must be original legacy text');
});

test('experimental actual run fails closed without explicit instrument', () => {
  assert.equal(run([...setup(), ping(start + 60_000)], experimental({ executionInstrument: undefined })).trades.length, 0);
  assert.equal(run([...setup(), ping(start + 60_000)], experimental({ executionInstrument: { ...instrument, ticker: 'UNKNOWN' } })).trades.length, 0);
});

test('experimental direct entries require causal context even with SMART ablated', () => {
  const entries = [...legacySetup(), ping(start + 60_000)];
  for (const smart of [true, false]) {
    const result = run(entries, experimental({ executionPolicy: { profile: 'microstructure_v1', smart } }));
    console.log(`DIRECT_CONTEXT_ABSENT ${JSON.stringify({ smart, events: entries.length, trades: result.trades.length })}`);
    assert.equal(result.trades.length, 0, 'a modeled quote alone is not causal OHLC plus closed ATR');
  }
});

test('closed-only producer fixture seeds ATR and creates actual direct trades with SMART on or off', () => {
  const entries = setup();
  assert.equal(entries.length, 16);
  const state: any = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i], observation = entry.parsed!.executionObservation!;
    assert.ok(i === 0 || entry.ts > entries[i - 1].ts, 'fixture is chronological');
    assert.equal(observation.bar!.closed, true, 'producer does not invent a forming bar');
    assert.equal(observation.quote, undefined, 'no invented broker quote');
    assert.equal(ingestExecutionContext(state, observation, entry.ts).accepted, true);
  }
  const snapshot = getExecutionSnapshot(state, '5', start + 1)!;
  near(snapshot.atr14!, .002);
  assert.equal(snapshot.closedBar!.closeTimeMs, start);
  for (const smart of [true, false]) {
    const result = run([...entries, ping(start + 60_000, 1.1001, 1.2, 1.0)],
      experimental({ executionPolicy: { profile: 'microstructure_v1', smart } }));
    assert.equal(result.trades.length, 1);
    const trade = result.trades[0];
    assert.equal(trade.timestamp, start + 1);
    assert.equal(trade.executionBacktest.fillQuote.source, 'modeled');
    assert.equal(trade.executionState.partialConfirmed, false);
    near(trade.executionState.mfePriceDist, 0);
    console.log(`DIRECT_CONTEXT_PRESENT ${JSON.stringify({ smart, events: entries.length + 1,
      trades: result.trades.length, closedAtr: snapshot.atr14, fill: trade.entryPrice, mfe: trade.executionState.mfePriceDist })}`);
  }
});

test('experimental direct entry rejects stale closed OHLC and ATR despite a fresh modeled quote', () => {
  const result = run([...contextWarmup(start - 900_000),
    event('EVENTO_CHOCH', start + 1, 'BUY | ORIGIN: 1.099 | Precio: 1.1')], experimental());
  assert.equal(result.trades.length, 0);
});

test('experimental direct entry rejects wrong-TF context rather than borrowing M5 ATR', () => {
  const result = run([...contextWarmup(),
    event('EVENTO_CHOCH', start + 1, 'BUY | ORIGIN: 1.099 | Precio: 1.1', '15')], experimental());
  assert.equal(result.trades.length, 0);
});

test('experimental direct entry rejects insufficient closed ATR seed', () => {
  const entries = setup();
  assert.equal(run(entries.slice(1), experimental()).trades.length, 0, '14 closes provide only 13 real TRs');
  assert.equal(run(entries, experimental()).trades.length, 1, 'the 15th contiguous close supplies TR14');
});

test('experimental direct entry rejects invalid OHLC even when older context was valid', () => {
  const invalid = closedObservation(start);
  invalid.bar!.high = invalid.bar!.low - .001;
  const result = run([...contextWarmup(), event('EVENTO_CHOCH', start + 1,
    'BUY | ORIGIN: 1.099 | Precio: 1.1', '5', { ...invalid, observedAtMs: start + 1 })], experimental());
  assert.equal(result.trades.length, 0);
});

test('experimental direct entry rejects future context rather than reusing valid older ATR', () => {
  const future = closedObservation(start + 300_000);
  const result = run([...contextWarmup(), event('EVENTO_CHOCH', start + 1,
    'BUY | ORIGIN: 1.099 | Precio: 1.1', '5', future)], experimental());
  assert.equal(result.trades.length, 0);
});

test('experimental direct entry rejects wrong ticker and invalid quote provenance', () => {
  const candidate = (observation: ExecutionObservation) => event('EVENTO_CHOCH', start + 1,
    'BUY | ORIGIN: 1.099 | Precio: 1.1', '5', observation);
  const observation = { ...closedObservation(start), observedAtMs: start + 1 };
  for (const invalid of [
    { ...observation, ticker: 'XAUUSD' },
    { ...observation, quote: { bid: 1.1, ask: 1.1001, timestampMs: start + 1, source: 'synthetic' as any } },
    { ...observation, quote: { bid: 1.1, ask: 1.1001, timestampMs: start + 2, source: 'modeled' as const } },
  ]) assert.equal(run([...contextWarmup(), candidate(invalid)], experimental()).trades.length, 0);
  assert.equal(run(setup(), experimental({ spreadPips: NaN })).trades.length, 0, 'unknown modeled spread cannot fill');
  assert.equal(run(setup(), experimental({ executionInstrument: { ...instrument, source: 'broker_metadata' } })).trades.length, 0,
    'research metadata must be explicitly modeled, not mislabeled broker data');
});

test('legacy three-event fixture remains byte-identical to PRE without extra context or broker data', () => {
  const entries = [...legacySetup(), ping(start + 60_000, 1.1001)];
  assert.equal(entries.filter(e => e.parsed?.executionObservation).length, 0);
  const originalRandom = Math.random; Math.random = () => .123456789;
  let expected: any;
  try { expected = archivedEngine().runBacktest(new Map(), structuredClone(config), undefined, entries); }
  finally { Math.random = originalRandom; }
  const actual = run(entries);
  assert.equal(actual.trades.length, 1);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});

test('experimental actual direct fill is MODELED, immutable and targets are not legacy recapped', () => {
  const result = run([...setup(), ping(start + 60_000, 1.1001)], experimental());
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.executionPolicy.profile, 'microstructure_v1');
  assert.equal(trade.executionInstrument.source, 'explicit_model');
  assert.equal(trade.executionBacktest.fillSource, 'MODELED');
  near(trade.entryPrice, 1.10005);
  assert.equal(trade.executionState.entryTimestampMs, start + 1);
  assert.equal(trade.initialSlPrice, trade.originalSlPrice);
  assert.equal(trade.executionState.initialRiskDist, trade.entryPrice - trade.initialSlPrice);
  assert.ok(trade.events.some((e: string) => e.includes('MODELED')));
});

function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }

test('SMART actual router rejects absent and stale break ATR vintage', () => {
  assert.equal(typeof routeModeledSmart, 'function');
  const leg = { dir: 'BUY', origin: 1.099, extreme: 1.1, createdAt: start };
  const decision = routeModeledSmart(leg, { zones: [], marketBias: {} }, experimental(), '5', start, .002, 1.103);
  assert.equal(decision.mode, 'WAIT_DATA');
  assert.equal(decision.takeDirectNow, false);
});

test('isolated actual close ledger weights remainder and commission without 50 percent assumption', () => {
  assert.equal(typeof testCloseModeledTrade, 'function');
  const trade: any = { direction: 'BUY', entryPrice: 1.1, timestamp: start, riskMult: 1,
    executionInstrument: instrument, executionState: { initialRiskDist: .001 },
    executionBacktest: { remainingFraction: .3, realizedPriceDist: .0007,
      paidCommissionPrice: .000051, exitCommissionPerLotUsd: 3 } };
  testCloseModeledTrade(trade, 1.1005, start + 60_000, 'FINAL_CENSOR');
  near(trade.rMultiple, (.0007 + .3 * (.0005 - .00002) - .00006) / .001);
  assert.equal(trade.executionBacktest.remainingFraction, 0);
});

test('isolated actual management does not use prefill highs as MFE or fills', () => {
  assert.equal(typeof testManageModeledTrade, 'function');
  const trade = run([...setup()], experimental()).trades[0];
  trade.executionState = createExecutionPositionState({ direction: trade.direction, entryPrice: trade.entryPrice,
    initialSlPrice: trade.initialSlPrice, entryTimestampMs: trade.timestamp });
  Object.assign(trade.executionBacktest, { remainingFraction: 1, realizedPriceDist: 0,
    paidCommissionPrice: .00003, closeReason: undefined, lastProcessedMs: trade.timestamp });
  delete trade.closeTimestamp;
  const quote = { bid: trade.entryPrice, ask: trade.entryPrice + .0001, timestampMs: start + 60_000, source: 'modeled' };
  const snapshot = { atr14: .001, bar: { closed: false, openTimeMs: start - 60_000,
    high: 1.2, low: 1.0, close: trade.entryPrice, availableAtMs: start + 60_000 } };
  assert.equal(testManageModeledTrade(trade, quote, snapshot, quote.timestampMs, 'EURUSD'), false);
  assert.equal(trade.tp1Hit, undefined);
  assert.equal(trade.executionState.partialConfirmed, false);
  near(trade.executionState.mfePriceDist, 0);
});

test('experimental partial and final censor use 70 percent weight and pending costs once', () => {
  const first = run([...setup(), ping(start + 60_000)], experimental()).trades[0];
  const tp1Mid = first.tp1Price + instrument.baseSpreadPips * instrument.pipSize / 2 + .00001;
  const entries = [...setup(), ping(start + 60_000, tp1Mid, tp1Mid, 1.099), ping(start + 120_000, 1.1005)];
  const trade = run(entries, experimental()).trades[0];
  assert.equal(trade.tp1Hit, true);
  assert.equal(trade.executionState.partialConfirmed, true);
  near(trade.executionBacktest.remainingFraction, 0);
  assert.equal(trade.executionBacktest.closeReason, 'FINAL_CENSOR');
  const slip = instrument.exitSlippagePips * instrument.pipSize;
  const gross = .7 * (first.tp1Price - slip - first.entryPrice) + .3 * (1.10045 - slip - first.entryPrice);
  const commissionPrice = 2 * 3 / 10 * .0001;
  near(trade.rMultiple, (gross - commissionPrice) / first.executionState.initialRiskDist);
});

test('experimental prefill OHLC cannot create MFE or partial confirmation', () => {
  const trade = run([...setup(), ping(start + 60_000, 1.1001, 1.2, 1.099)], experimental()).trades[0];
  assert.equal(trade.tp1Hit, undefined);
  assert.equal(trade.executionState.partialConfirmed, false);
  near(trade.executionState.mfePriceDist, 0);
  // The executable close is 1.10005: no favorable distance from the 1.10005 fill.
});

test('experimental timeout and SL use common weighted ledger', () => {
  for (const [price, cfg, reason] of [
    [1.097, experimental(), 'SL'],
    [1.1005, experimental({ maxHoldMin: 1 }), 'MAX_HOLD'],
    [1.105, experimental(), 'TP2'],
  ] as const) {
    const trade = run([...setup(), ping(start + 120_000, price)], cfg).trades[0];
    assert.equal(trade.executionBacktest.closeReason, reason);
    assert.ok(Number.isFinite(trade.rMultiple));
    assert.equal(trade.executionBacktest.remainingFraction, 0);
  }
});

test('experimental net protection and trail amendments only affect next observations', () => {
  const trade = run([...setup()], experimental()).trades[0];
  trade.tp2Price = trade.entryPrice + .01;
  trade.executionState = createExecutionPositionState({ direction: trade.direction, entryPrice: trade.entryPrice,
    initialSlPrice: trade.initialSlPrice, entryTimestampMs: trade.timestamp });
  Object.assign(trade.executionBacktest, { remainingFraction: 1, realizedPriceDist: 0,
    paidCommissionPrice: .00003, closeReason: undefined, lastProcessedMs: trade.timestamp });
  delete trade.closeTimestamp;
  const quote = (i: number, dist: number) => ({ bid: trade.entryPrice + dist, ask: trade.entryPrice + dist + .0001,
    timestampMs: start + i * 60_000, source: 'modeled' });
  const snapshot = { atr14: .001, bar: { closed: false, openTimeMs: start - 60_000,
    high: trade.entryPrice + .004, low: trade.entryPrice - .0005, close: trade.entryPrice, availableAtMs: start + 60_000 } };
  assert.equal(testManageModeledTrade(trade, quote(1, .0025), snapshot, start + 60_000, 'EURUSD'), false);
  assert.equal(trade.executionState.partialConfirmed, true);
  assert.equal(trade.executionState.stage, 'NONE', 'proposal is not confirmed in the observation that created it');
  assert.equal(trade.slPrice, trade.initialSlPrice);
  assert.equal(trade.executionBacktest.pendingAmend.stage, 'NET_PROTECTION_ESTIMATE');
  assert.equal(testManageModeledTrade(trade, quote(2, .0026), snapshot, start + 120_000, 'EURUSD'), false);
  assert.equal(trade.executionState.stage, 'NET_PROTECTION_ESTIMATE');
  assert.ok(trade.slPrice > trade.entryPrice);
  const trailed = trade.executionBacktest.pendingAmend.price;
  assert.equal(testManageModeledTrade(trade, quote(3, .0014), snapshot, start + 180_000, 'EURUSD'), false,
    'already observed OHLC low cannot hit the new SL retroactively');
  near(trade.slPrice, trailed);
  assert.equal(trade.executionState.initialSlPrice, trade.initialSlPrice);
});

test('legacy byte results and management equal PRE on small frozen real OHLC replay', () => {
  const before = archivedEngine();
  const candles = JSON.parse(fs.readFileSync('/tmp/jarvis-smc-verification/C-real-candles.json', 'utf8')).slice(0, 180);
  const entries = candles.flatMap((c: any, i: number) => {
    const time = Number(c.timestamp) + 300_000, price = Number(c.close);
    const values = [ping(time, price, Number(c.high), Number(c.low))];
    // Explicit deterministic setup markers, never claimed as observed market signals.
    if (i % 30 === 0) values.push(event('EVENTO_CHOCH', time + 1, `BUY | ORIGIN: ${price - .001} | Precio: ${price}`));
    return values;
  });
  let tradeCount = 0;
  const mgmt = { enabled: true, minScore: 1, slBuff: 0, tp2: 2, partialClosePct: 70,
    slAfterTp1: 'midpoint', tp15BeEnabled: true, atrTrailEnabled: true, structuralTrailEnabled: true };
  const cfgs: any[] = [config, { ...config, maxHoldMin: 10 }, { ...config, minimal_roi: { 0: 0 } },
    { ...config, sessions: { LONDON: { choch5m: mgmt }, NY: { choch5m: mgmt }, ASIA: { choch5m: mgmt } } }];
  for (const cfg of cfgs) {
    const originalRandom = Math.random; Math.random = () => .123456789;
    let expected: any;
    try { expected = before.runBacktest(new Map(), structuredClone(cfg), undefined, entries); }
    finally { Math.random = originalRandom; }
    const actual = run(entries, cfg);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    tradeCount += actual.trades.length;
  }
  assert.ok(tradeCount > 0);
  console.log(`LEGACY_PRE_PARITY ${JSON.stringify({ realBars: candles.length, events: entries.length, configs: cfgs.length, tradesCompared: tradeCount })}`);
});

function closedObservation(time: number, price = 1.1, ticker = 'EURUSD', range = .001): ExecutionObservation {
  return buildExecutionObservation({ ticker, tf: '5', observedAtMs: time,
    bar: { tf: '5', openTimeMs: time - 300_000, closeTimeMs: time, availableAtMs: time,
      open: price, high: price + range, low: price - range, close: price, closed: true } });
}

test('actual SMART context replay falls back OTE without ticks and fills current quote not past low', () => {
  const warmup = Array.from({ length: 15 }, (_, i) => {
    const time = start - (15 - i) * 300_000;
    return ping(time, 1.1, 1.101, 1.099, closedObservation(time));
  });
  const observation = closedObservation(start);
  observation.bar = { ...observation.bar!, open: 1.0992, high: 1.10005, low: 1.09915, close: 1.1 };
  observation.breakBar = { ...observation.bar };
  const cfg = experimental({ entryTrigger: 'SMART', fixedRR: 2, slBufferPercent: .1,
    sessions: { NY: { choch5m: { enabled: true, minScore: 1 }, oteChoch5m: { enabled: true, minScore: 1, tp2: 2 } } } });
  const forming = (time: number, price: number): ExecutionObservation => ({ schema: 1, ticker: 'EURUSD', tf: '5', observedAtMs: time,
    bar: { tf: '5', openTimeMs: start, closeTimeMs: start + 300_000, availableAtMs: time,
      open: 1.1, high: Math.max(1.10005, price + .0001), low: 1.0991, close: price, closed: false } });
  const entries = [...warmup, ping(start, 1.1, 1.10005, 1.09915, observation),
    event('EVENTO_CHOCH', start + 1, 'BUY | ORIGIN: 1.099 | Precio: 1.1', '5', { ...observation, observedAtMs: start + 1 }),
    ping(start + 60_000, 1.0998, 1.10005, 1.0991, forming(start + 60_000, 1.0998)),
    ping(start + 120_000, 1.0992, 1.10005, 1.0991, forming(start + 120_000, 1.0992)),
    ping(start + 180_000, 1.1002, 1.1003, 1.0991, forming(start + 180_000, 1.1002))];
  const result = run(entries, cfg);

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.timestamp, start + 120_000, 'past forming low cannot fill the earlier high quote');
  near(trade.entryPrice, 1.09925);
  assert.equal(trade.execTrigger, 'oteChoch5m');
  assert.equal(trade.executionBacktest.fillSource, 'MODELED');
  console.log(`MODELED_SMART_OTE ${JSON.stringify({ events: entries.length, trades: result.trades.length,
    timestamp: trade.timestamp, entryPrice: trade.entryPrice, initialSl: trade.initialSlPrice, rMultiple: trade.rMultiple })}`);
});

test('SMART refuses latest ATR for an older break and does not infer tick flow from alerts', () => {
  const bar = closedObservation(start).bar!;
  const observation = { ...closedObservation(start), breakBar: { ...bar } };
  const state: any = { zones: [], marketBias: {}, executionContext: { schema: 1, ticker: 'EURUSD', lastObservedAtMs: start,
    quote: { bid: 1.09995, ask: 1.10005, timestampMs: start, source: 'modeled' },
    byTf: { '5': { atrSeed: .028, atrSamples: 14, atr14: .002, lastClosedBar: bar, breakBar: bar, observedAtMs: start } } } };
  const leg: any = { dir: 'BUY', origin: 1.099, extreme: 1.1, createdAt: start };
  const valid = routeModeledSmart(leg, state, experimental(), '5', start, .001, 1.102, observation);
  assert.notEqual(valid.mode, 'DIRECT');
  assert.notEqual(valid.mode, 'WAIT_DATA');
  assert.equal(leg.executionSnapshot.tickActivity, undefined);
  state.executionContext.byTf['5'].lastClosedBar = { ...bar, openTimeMs: bar.openTimeMs + 300_000,
    closeTimeMs: bar.closeTimeMs + 300_000, availableAtMs: start + 300_000 };
  state.executionContext.lastObservedAtMs = start + 300_000;
  state.executionContext.byTf['5'].observedAtMs = start + 300_000;
  state.executionContext.quote.timestampMs = start + 300_000;
  const stale = routeModeledSmart({ dir: 'BUY', origin: 1.099, extreme: 1.1, createdAt: start + 300_000 }, state, experimental(), '5', start + 300_000, .001, 1.102, observation);
  assert.equal(stale.mode, 'WAIT_DATA');
  const frozen = routeModeledSmart(leg, state, experimental(), '5', start + 300_000, .001, 1.102, observation);
  assert.equal(JSON.stringify(frozen), JSON.stringify(valid), 'an existing setup decision is immutable');
});

test('targets ablation is independent and new METALS target is not globally recapped', () => {
  const inst = { ...instrument, ticker: 'XAUUSD', regime: 'METALS', pipSize: .01, tickSize: .01, pipValuePerLotUsd: 1 };
  const entries = setup(start, 2000, 1990, 'XAUUSD', 1);
  const cfg = experimental({ ticker: 'XAUUSD', executionInstrument: inst,
    sessions: { NY: { choch5m: { enabled: true, minScore: 1, tp2: 4, partialClosePct: .25 } } } });
  const on = run(entries, cfg).trades[0];
  assert.ok(on);
  assert.ok((on.tp2Price - on.entryPrice) / on.executionState.initialRiskDist > 1.5);
  near(on.executionBacktest.partialClosePct, .5);
  for (const flag of ['smart', 'management', 'trailing'] as const) {
    const trade = run(entries, { ...cfg, executionPolicy: { profile: 'microstructure_v1', [flag]: false } }).trades[0];
    near(trade.tp2Price, on.tp2Price);
    assert.equal(trade.executionPolicy[flag], false);
    assert.equal(trade.executionPolicy.targets, true);
  }
  const off = run(entries, { ...cfg, executionPolicy: { profile: 'microstructure_v1', targets: false } }).trades[0];
  near(off.executionBacktest.partialClosePct, .25);
  assert.ok(off.tp2Price < on.tp2Price);
});

test('whole closed post-entry ambiguous bars are stop-first and target exits stay weighted', () => {
  const fresh = () => {
    const trade = run([...setup()], experimental()).trades[0];
    trade.executionState = createExecutionPositionState({ direction: trade.direction, entryPrice: trade.entryPrice,
      initialSlPrice: trade.initialSlPrice, entryTimestampMs: trade.timestamp });
    Object.assign(trade.executionBacktest, { remainingFraction: 1, realizedPriceDist: 0,
      paidCommissionPrice: .00003, closeReason: undefined, lastProcessedMs: trade.timestamp });
    delete trade.closeTimestamp;
    return trade;
  };
  for (const stop of [false, true]) {
    const trade = fresh();
    const quote = { bid: trade.entryPrice + .0001, ask: trade.entryPrice + .0002,
      timestampMs: start + 600_000, source: 'modeled' };
    const bar = { tf: '5', closed: true, openTimeMs: start + 300_000, closeTimeMs: start + 600_000,
      availableAtMs: start + 600_000, open: trade.entryPrice + .0001, close: trade.entryPrice + .0001,
      high: trade.tp2Price + .0001, low: stop ? trade.initialSlPrice - .0001 : trade.entryPrice - .0001 };
    assert.equal(testManageModeledTrade(trade, quote, { bar, closedBar: bar, atr14: .001 }, quote.timestampMs, 'EURUSD'), true);
    if (stop) {
      assert.equal(trade.executionBacktest.closeReason, 'SL');
      assert.equal(trade.executionState.partialConfirmed, false);
    } else {
      assert.equal(trade.executionBacktest.closeReason, 'TP2');
      assert.equal(trade.executionState.partialConfirmed, true, 'available full post-entry bar models TP1 before TP2, not all lots at TP2');
      const gross = .7 * (trade.tp1Price - .00002 - trade.entryPrice) + .3 * (trade.tp2Price - .00002 - trade.entryPrice);
      near(trade.rMultiple, (gross - .00006) / trade.executionState.initialRiskDist);
    }
  }
});

test('pending amend never retroactively stops a just-closed interval at the new level', () => {
  const trade = run([...setup()], experimental()).trades[0];
  trade.tp2Price = trade.entryPrice + .02;
  trade.executionState = createExecutionPositionState({ direction: trade.direction, entryPrice: trade.entryPrice,
    initialSlPrice: trade.initialSlPrice, entryTimestampMs: trade.timestamp });
  Object.assign(trade.executionBacktest, { remainingFraction: 1, realizedPriceDist: 0,
    paidCommissionPrice: .00003, closeReason: undefined, lastProcessedMs: start + 300_000,
    pendingAmend: { price: trade.entryPrice + .0002, stage: 'NET_PROTECTION_ESTIMATE', observedAtMs: start + 300_000 } });
  const quote = { bid: trade.entryPrice + .0005, ask: trade.entryPrice + .0006,
    timestampMs: start + 600_000, source: 'modeled' };
  const bar = { tf: '5', closed: true, openTimeMs: start + 300_000, closeTimeMs: start + 600_000,
    availableAtMs: start + 600_000, open: trade.entryPrice + .0003, close: trade.entryPrice + .0005,
    high: trade.entryPrice + .0007, low: trade.entryPrice - .0001 };
  assert.equal(testManageModeledTrade(trade, quote, { bar, closedBar: bar, atr14: .001 }, quote.timestampMs, 'EURUSD'), false,
    'new amendment is effective at this observation, not before its closed bar');
  near(trade.slPrice, trade.entryPrice + .0002);
});

test('instrument, policy and management stay frozen across progress callbacks', () => {
  const cfg = experimental({ maxHoldMin: 2 });
  const entries = [...setup(), ...Array.from({ length: 20 }, (_, i) => ping(start + 10_000 + i * 10_000, 1.1001))];
  const originalRandom = Math.random; Math.random = () => .123456789;
  let result: any;
  try {
    result = runBacktest(new Map(), cfg, (_pct, trades) => {
      if (!trades.length) return;
      cfg.executionPolicy = { profile: 'legacy_v1' };
      cfg.executionInstrument = { ...instrument, pipSize: .1, commissionPerLotSideUsd: 999 };
      cfg.maxHoldMin = 999;
      cfg.spreadPips = 999;
    }, entries);
  } finally { Math.random = originalRandom; }
  assert.equal(result.trades[0].executionPolicy.profile, 'microstructure_v1');
  assert.equal(result.trades[0].executionInstrument.pipSize, .0001);
  assert.equal(result.trades[0].executionBacktest.maxHoldMin, 2);
  assert.equal(result.trades[0].executionBacktest.closeReason, 'MAX_HOLD');
  assert.equal(result.executionReport.fillSource, 'MODELED');
  assert.equal(result.executionReport.profitabilityEvidence, false);
  const blocked = run([...setup()], experimental({ executionInstrument: undefined }));
  assert.equal(blocked.executionReport.blockedReason, 'MISSING_OR_INVALID_EXPLICIT_INSTRUMENT');
});

test('experimental malformed and future EX1 fails closed before entry instead of reusing old context', () => {
  for (const token of ['not_base64!', Buffer.from(JSON.stringify({ ...closedObservation(start + 600_000), observedAtMs: start + 600_000 })).toString('base64url')]) {
    const broken = parseCSV(`EVENTO_CHOCH | TF: 5 | BUY | ORIGIN: 1.099 | Precio: 1.1 | TS: ${start + 1} | EX1: ${token}`).lines[0];
    const result = run([ping(start), broken], experimental());
    assert.equal(result.trades.length, 0);
  }
});

console.log(`Execution backtest: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
