import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { parseCSV, runBacktest } from '../../jarvis-os/src/services/backtestEngine';
import * as context from '../../src/engine/ExecutionContext';
import * as micro from '../../src/engine/ExecutionMicrostructure';
import * as costs from '../../src/engine/ExecutionCosts';
import { capTp2Price, getAdrPrice } from '../../src/engine/tp2Cap';

// Execute real caller bodies without importing live services/broker/Firestore.
function caller(file: string, name: string): any {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)!;
  assert.ok(declaration, name);
  const box: any = { exports: {}, structuredClone, ...context, ...micro, ...costs, capTp2Price, getAdrPrice };
  vm.runInNewContext(ts.transpileModule(declaration.getText(ast) + `\nglobalThis.call = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, box);
  return box.call;
}
const liveRoute = caller('src/db/trading.ts', 'routeExecutionSetup');
const btRoute = caller('jarvis-os/src/services/backtestEngine.ts', 'routeModeledSmart');
const instrument: any = { ticker: 'EURUSD', regime: 'FOREX', pipSize: .0001, tickSize: .00001,
  pipValuePerLotUsd: 10, baseSpreadPips: 0, exitSlippagePips: 0, commissionPerLotSideUsd: 0,
  minStopDistance: 0, source: 'explicit_model' };
let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  if (process.env.EXECUTION_TARGET_CASE && !name.includes(process.env.EXECUTION_TARGET_CASE)) return;
  try { fn(); passed++; console.log('PASS', name); }
  catch (e) { failed++; console.error('FAIL', name, e); }
}
function seeded(direction: 'BUY'|'SELL') {
  const sign = direction === 'BUY' ? 1 : -1, step = 300000;
  const state: any = { zones: [], marketBias: {} };
  for (let k = 0; k < 15; k++) {
    const bar: any = { tf: '5', openTimeMs: k*step, closeTimeMs: (k+1)*step, availableAtMs: (k+1)*step,
      open: 1, high: 1.005, low: .995, close: 1, closed: true };
    assert.equal(context.ingestExecutionContext(state, context.buildExecutionObservation({ ticker: 'EURUSD', tf: '5', observedAtMs: bar.availableAtMs, bar }), bar.availableAtMs).accepted, true);
  }
  const now = 16*step+123, origin = 1-sign*.01, extreme = 1, sl = 1-sign*.001;
  const bar: any = { tf: '5', openTimeMs: 15*step, closeTimeMs: 16*step, availableAtMs: now,
    open: origin, high: direction === 'BUY' ? 1.001 : 1.01, low: direction === 'BUY' ? .99 : .999, close: 1, closed: true };
  const observation = context.buildExecutionObservation({ ticker: 'EURUSD', tf: '5', observedAtMs: now, bar, breakBar: bar,
    impulse: { direction, origin, extreme, createdAtMs: now },
    tickActivity: { ratio: 1, direction: direction === 'BUY' ? 'UP' : 'DOWN', sampleCount: 20, timestampMs: now, source: 'broker_ticks' } });
  assert.equal(context.ingestExecutionContext(state, observation, now).accepted, true);
  state.executionContext.quote = { bid: 1, ask: 1, timestampMs: now, source: 'modeled' };
  const snapshot = context.getExecutionSnapshot(state, '5', now)!;
  assert.ok(snapshot.atr14! > 0 && Number.isFinite(snapshot.atr14), 'real Wilder14 from fifteen preceding closed bars');
  const leg: any = { dir: direction, origin, extreme, createdAt: now, oteScored: false, executionSnapshot: snapshot };
  return { sign, state, now, sl, observation, leg };
}
for (const direction of ['BUY', 'SELL'] as const) for (const targets of [false, true]) {
  for (const edge of ['favorable', 'unfavorable', 'equal'] as const) test(`original directional TP2 ${direction} targets=${targets} ${edge}`, () => {
    const { sign, state, now, sl, observation, leg } = seeded(direction);
    const requested = edge === 'equal' ? 1 : 1 + sign*(edge === 'favorable' ? .01 : -.01);
    const cfg = { ticker: 'EURUSD', executionPolicy: { profile: 'microstructure_v1', targets }, executionInstrument: instrument };
    const liveLeg = structuredClone(leg), btLeg = structuredClone(leg);
    const live = liveRoute(state, liveLeg, cfg, '5', now, 1, sl, requested);
    const bt = btRoute(btLeg, state, cfg, '5', now, Math.abs(1-sl), requested, observation);
    for (const [name, decision, usedLeg] of [['live', live, liveLeg], ['BT', bt, btLeg]] as const) {
      assert.equal(decision.mode, edge === 'favorable' ? 'DIRECT' : 'WAIT_DATA', `${name} must see the original ${edge} target`);
      if (edge !== 'favorable') {
        assert.equal(decision.reason, 'WAIT_DATA_UNFAVORABLE_PLANNED_TP2', name);
        assert.equal(decision.takeDirectNow, false);
      }
      assert.equal(usedLeg.oteScored, false, `${name} routing must not consume setup`);
      assert.equal(usedLeg.origin, leg.origin); assert.equal(usedLeg.extreme, leg.extreme);
      assert.equal(usedLeg.createdAt, leg.createdAt);
    }
  });
}
for (const direction of ['BUY', 'SELL'] as const) {
  for (const variant of ['macro', 'fast-instead-of-daily', 'stale-macro'] as const) {
    test(`same fresh D/H4/H1 alignment ${direction} ${variant}`, () => {
      const { sign, state, now, sl, observation, leg } = seeded(direction);
      delete observation.tickActivity;
      delete state.executionContext.tickActivity;
      const keys = variant === 'fast-instead-of-daily' ? ['15','60','240'] : variant === 'stale-macro' ? ['D','60','240','15'] : ['D','60','240'];
      state.marketBias = Object.fromEntries(keys.map(tf => [tf, direction]));
      state.biasTs = Object.fromEntries(keys.map(tf => [tf, variant === 'stale-macro' ? now-121*3600e3 : now]));
      const cfg = { ticker: 'EURUSD', executionPolicy: { profile: 'microstructure_v1', targets: false }, executionInstrument: instrument };
      const live = liveRoute(state, structuredClone(leg), cfg, '5', now, 1, sl, 1+sign*.01);
      const bt = btRoute(structuredClone(leg), state, cfg, '5', now, Math.abs(1-sl), 1+sign*.01, observation);
      const expectedPercent = variant === 'macro' ? 50 : 62;
      assert.equal(live.mode, 'OTE_STANDARD');
      assert.equal(bt.mode, 'OTE_STANDARD');
      assert.equal(live.recommendedOtePercent, expectedPercent, 'live must count only fresh D/H4/H1, never substitute M15');
      assert.equal(bt.recommendedOtePercent, expectedPercent, 'BT uses the same macro set and freshness');
    });
  }
}
// The complete CLI-produced cohort is a real parseCSV/runBacktest control, not a helper mock.
const csvPath = process.env.EXECUTION_TARGET_CSV ?? '/tmp/jarvis-execution-verification/review-final/fresh-context/pine-logs-SMC Master_M5.csv';
function cohort(rr: number | string | undefined, legacy = false, engine = { parseCSV, runBacktest }, extra: any = {}) {
  const trigger = { enabled: true, minPoints: 1, ...(rr !== undefined ? { tp2: rr } : {}) };
  const session = { choch5m: trigger, bos5m: trigger };
  const cfg: any = { ticker: 'EURUSD', entryTrigger: 'CHOCH', minBuyPoints: 1, minSellPoints: 1,
    oteEntryPercent: 62, maxTradesPerDay: 100, rolloverPeakPips: 0,
    ...(!legacy ? { executionPolicy: { profile: 'microstructure_v1' }, executionInstrument: { ...instrument, baseSpreadPips: 1, exitSlippagePips: .2, commissionPerLotSideUsd: 3 } } : {}),
    sessions: { ASIA: session, LONDON: session, NY: session, OFF: session }, ...extra };
  const entries = engine.parseCSV(fs.readFileSync(csvPath, 'utf8')).lines;
  const random = Math.random; Math.random = () => .123456789;
  try { return engine.runBacktest(new Map(), cfg, undefined, entries); } finally { Math.random = random; }
}
test('whole real CSV caller rejects explicit NaN RR rather than generating default TP2', () => {
  const valid = cohort(1.5);
  assert.equal(valid.trades.length, 5, 'positive frozen 1200-M5 CLI control');
  for (const trade of valid.trades as any[]) {
    assert.equal(trade.executionBacktest.fillSource, 'MODELED');
    assert.ok(Number.isFinite(trade.tp2Price));
  }
  const omitted = cohort(undefined);
  const levels = (result: any) => result.trades.map((t: any) => ({ entry: t.entryPrice, tp1: t.tp1Price, tp2: t.tp2Price, timestamp: t.timestamp, direction: t.direction }));
  assert.deepEqual(levels(omitted), levels(valid), 'truly absent per-trigger RR retains the historical default levels');
  const rows = [1.5, NaN, Infinity, 0, -1].map(rr => ({ rr: String(rr), trades: cohort(rr).trades.length }));
  console.log('WHOLE_TARGET_EDGES', JSON.stringify(rows));
  assert.equal(rows[1].trades, 0, 'explicit NaN must never become target absence');
  for (const row of rows.slice(2)) assert.equal(row.trades, 0, row.rr);
});

for (const targets of [false, true]) test(`whole direct caller rejects nonpositive RR targets=${targets}`, () => {
  const extra = { executionPolicy: { profile: 'microstructure_v1', targets } };
  const valid = cohort(1.5, false, undefined, extra);
  assert.equal(valid.trades.length, 5, 'same frozen positive CLI cohort must not be empty');
  assert.deepEqual([...new Set(valid.trades.map(t => t.direction))].sort(), ['BUY', 'SELL']);
  for (const rr of [0, -1, '0', '-1', NaN, 'NaN', Infinity, 'Infinity']) {
    assert.equal(cohort(rr, false, undefined, extra).trades.length, 0, `explicit RR=${String(rr)} must reject before cap/SAR`);
  }
});

// Expose the entire real engine's private createTrade, keeping its actual dependencies.
const engineUrl = new URL('../../jarvis-os/src/services/backtestEngine.ts', import.meta.url);
function loadTargetEngine(source = fs.readFileSync(engineUrl, 'utf8')): any {
  const box = { exports: {} as any };
  vm.runInNewContext(ts.transpileModule(source + '\nexports.create = createTrade; exports.seedForecast = cache => { timesfmForecastCache = cache; };', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText, { module: box, exports: box.exports, require: createRequire(engineUrl),
    console, Date, Math, Map, Set, process, structuredClone, TextEncoder, TextDecoder, atob, btoa });
  return box.exports;
}
const moduleBox = { exports: loadTargetEngine() };
// A real preloaded modeled position makes SAR reachable, not a mock of reversal effects.
function reversalBoundary(direction: 'BUY'|'SELL', targets: boolean, dataExtra: any = {}, configExtra: any = {}, engine = moduleBox.exports,
    options: { baseConfig?: any; prepareCandidate?: (state: any) => void } = {}) {
  const { state, now, sign } = seeded(direction);
  state.lastPrice = 1;
  state.atr14 = context.getExecutionSnapshot(state, '5', now)!.atr14;
  const trades: any[] = [], active = new Map();
  const stats: any = { currentDayStr: '1970-01-01', currentSessionStr: '1970-01-01-ASIA', pnlR: 0, peakPnlR: 0,
    consecutiveLosses: 0, streakKillswitchUntil: 0, tradeCount: 0, isKilled: false, sellLossCount: 0,
    buyLossCount: 0, sessionTradeCount: 0, dailyBuys: 0, dailySells: 0, sessionBuyLossStreak: 0, sessionSellLossStreak: 0 };
  const cfg: any = { ticker: 'EURUSD', sessionWarmupMin: 0,
    executionPolicy: { profile: 'microstructure_v1', targets }, executionInstrument: instrument, ...options.baseConfig };
  const data = { tradeId: 'CHALLENGER', direction, entryPrice: 1, slPrice: 1-sign*.001,
    tp1Price: 1+sign*.001, tp2: 1+sign*.01, points: 10, events: ['EVENTO_CHOCH_5M'], tf: '5M' };
  engine.create({ ...data, tradeId: 'EXISTING', direction: direction === 'BUY' ? 'SELL' : 'BUY',
    slPrice: 1+sign*.001, tp1Price: 1-sign*.001, tp2: 1-sign*.01, points: 1 }, now, trades, active, stats, cfg, state);
  assert.equal(trades.length, 1, 'positive opposite modeled preload');
  assert.equal(active.get('EXISTING'), trades[0]);
  if (cfg.executionPolicy?.profile === 'microstructure_v1') {
    assert.equal(trades[0].executionBacktest.fillSource, 'MODELED', 'literal real modeled preload');
  }
  options.prepareCandidate?.(state);
  const snapshot = () => JSON.stringify({ trades, active: [...active.entries()], stats });
  const before = snapshot();
  engine.create({ ...data, ...dataExtra }, now, trades, active, stats, { ...cfg, ...configExtra }, state);
  return { before, after: snapshot(), trades, active, stats };
}
for (const direction of ['BUY', 'SELL'] as const) for (const targets of [false, true]) {
  test(`boundary rejects original wrong-side or equal price before SAR ${direction} targets=${targets}`, () => {
    const sign = direction === 'BUY' ? 1 : -1;
    const valid = reversalBoundary(direction, targets);
    assert.equal(valid.trades.length, 2, 'positive candidate must actually reverse');
    for (const field of ['tp2', 'tp2Price']) {
      const data = { tp2: undefined, [field]: String(1+sign*.01) };
      assert.equal(reversalBoundary(direction, targets, data).trades.length, 2, 'finite numeric string and TP2-price fallback remain valid');
    }
    const wrongFill = reversalBoundary(direction, targets, { entryPrice: 1-sign*.02, tp2: 1-sign*.01 });
    assert.equal(wrongFill.after, wrongFill.before, 'the actual modeled fill, not the proposed entry, governs target side');
    const explicitNaN = reversalBoundary(direction, targets, { tp2: NaN, tp2Price: 1+sign*.01 });
    assert.equal(explicitNaN.after, explicitNaN.before, 'explicit NaN cannot fall back to an alternative target field');
    assert.equal(valid.trades[0].executionBacktest.closeReason, 'REVERSAL');
    assert.equal(valid.active.has('EXISTING'), false);
    assert.equal(valid.active.has('CHALLENGER'), true);
    for (const raw of [1-sign*.01, String(1-sign*.01), 1, '1', NaN, 'NaN', Infinity, 'Infinity', 0, -1]) {
      const rejected = reversalBoundary(direction, targets, { tp2: raw });
      assert.equal(rejected.after, rejected.before, `invalid original ${String(raw)} cannot close/delete/mutate trades, stats or entry counters`);
    }
  });
  if (!targets) test(`boundary rejects effective RR override before SAR ${direction}`, () => {
    const valid = reversalBoundary(direction, targets, {}, { tp2RR: '1.5' });
    assert.equal(valid.trades.length, 2, 'numeric finite positive override reverses');
    for (const rr of [0, '0', -1, '-1', NaN, 'NaN', Infinity, 'Infinity', -Infinity, '1e309', Number.MIN_VALUE, ...(direction === 'SELL' ? [Number.MAX_VALUE] : [])]) {
      const rejected = reversalBoundary(direction, targets, {}, { tp2RR: rr });
      assert.equal(rejected.after, rejected.before, `override RR=${String(rr)} must reject atomically before SAR/recap`);
    }
    const rejected = reversalBoundary(direction, targets, { tp2: 1 }, { tp2RR: 1.5 });
    assert.equal(rejected.after, rejected.before, 'a favorable override must not hide an invalid original target');
  });
}

// Reuse the same seeded closed bars and MODELED quotes, without inventing a new replay.
for (const direction of ['BUY', 'SELL'] as const) {
  test(`staged SAR target-order rejection is atomic ${direction}`, () => {
    const sign = direction === 'BUY' ? 1 : -1;
    const requestedTp2Price = 1 + sign * .0005; // Positive and on-side, but only 0.5R.
    const target = micro.computeExecutionTargets({ direction, entryPrice: 1, initialSlPrice: 1-sign*.001,
      adr: getAdrPrice('EURUSD'), regime: 'FOREX', requestedTp2Price });
    assert.equal(target.valid, false);
    assert.equal(target.reason, 'TARGET_ORDER_NOT_PRESERVABLE');
    const control = reversalBoundary(direction, true);
    assert.equal(control.trades.length, 2, 'valid 10R request must really reverse the modeled preload');
    assert.equal(control.trades[0].executionBacktest.closeReason, 'REVERSAL');
    assert.deepEqual([...control.active.keys()], ['CHALLENGER']);
    const rejected = reversalBoundary(direction, true, { tp2: requestedTp2Price });
    assert.equal(rejected.after, rejected.before, 'rejected target order preserves the entire ledger, active map, stats and counters');
  });
}

for (const direction of ['BUY', 'SELL'] as const) for (const targets of [false, true]) {
  test(`staged SAR rejects invalid costs atomically ${direction} targets=${targets}`, () => {
    const control = reversalBoundary(direction, targets, { mgmtOverrides: { partialClosePct: .25 } }, { commissionPerLot: 3 });
    assert.equal(control.trades.length, 2, 'valid costs still admit and reverse');
    assert.equal(control.trades[0].executionBacktest.closeReason, 'REVERSAL');
    for (const commissionPerLot of [-1, NaN, Infinity]) {
      const rejected = reversalBoundary(direction, targets, {}, { commissionPerLot });
      assert.equal(rejected.after, rejected.before, 'invalid commission cannot consume the opposite position');
    }
    // With profile targets enabled their own valid partial wins, as before.
    for (const partialClosePct of [-1, NaN, Infinity, 1, 100, 101]) {
      const rejected = reversalBoundary(direction, targets, { mgmtOverrides: { partialClosePct } });
      if (targets) assert.equal(rejected.trades.length, 2, 'do not change the profile partial override policy');
      else assert.equal(rejected.after, rejected.before, 'invalid effective partial cannot consume the opposite position');
    }
  });
  test(`staged SAR quote commit failure cannot enter ${direction} targets=${targets}`, () => {
    const rejected = reversalBoundary(direction, targets, {}, {}, undefined,
      { prepareCandidate: state => { state.lastPrice = NaN; } });
    assert.equal(rejected.after, rejected.before, 'valid fill/targets but unavailable SAR quote leaves everything untouched');
  });
}

test('staged SAR exact current PRE parity including legacy post-SAR rejection', () => {
  const before = loadTargetEngine(fs.readFileSync('/tmp/jarvis-execution-verification/fix-pre-sar-order/pre/jarvis-os/src/services/backtestEngine.ts', 'utf8'));
  for (const direction of ['BUY', 'SELL'] as const) {
    for (const targets of [false, true]) {
      assert.equal(reversalBoundary(direction, targets).after, reversalBoundary(direction, targets, {}, {}, before).after,
        'valid modeled reversal preserves the complete current PRE output');
      const sign = direction === 'BUY' ? 1 : -1;
      const rejectedBefore = reversalBoundary(direction, true, { tp2: 1+sign*.0005 }, {}, before);
      assert.notEqual(rejectedBefore.after, rejectedBefore.before, 'this regression must genuinely detect the actual PRE defect');
    }
    for (const executionPolicy of [undefined, { profile: 'legacy_v1' }]) {
      const options = { baseConfig: { executionPolicy, spreadPips: 0, commissionPerLot: 0 } };
      for (const configExtra of [{}, { commissionPerLot: 1e9 }]) {
        const next = reversalBoundary(direction, false, {}, configExtra, undefined, options);
        const previous = reversalBoundary(direction, false, {}, configExtra, before, options);
        assert.equal(next.after, previous.after, 'legacy complete ledger/map/stats remains serialized PRE-identical');
        assert.equal(next.trades[0].resultTp2, 'REVERSAL', 'legacy still reverses before its later friction check');
        if ('commissionPerLot' in configExtra) {
          assert.equal(next.trades.length, 1, 'legacy rejected candidate still leaves the historical SAR effects');
          assert.equal(next.active.size, 0);
        } else assert.equal(next.trades.length, 2);
      }
    }
  }
  for (const rr of [undefined, 1.5, 0]) {
    assert.equal(JSON.stringify(cohort(rr, true)), JSON.stringify(cohort(rr, true, before)),
      `whole legacy current PRE parity RR=${String(rr)}`);
  }
});

for (const targets of [false, true]) for (const raw of [NaN, 'NaN', Infinity, 'Infinity', 0, -1, undefined, 1.01]) {
  test(`createTrade raw TP2 targets=${targets} ${typeof raw}=${String(raw)}`, () => {
    const { state, now, sl } = seeded('BUY');
    const trades: any[] = [], active = new Map();
    const stats: any = { currentDayStr: '', currentSessionStr: '1970-01-01-ASIA', pnlR: 0, peakPnlR: 0,
      consecutiveLosses: 0, streakKillswitchUntil: 0, tradeCount: 0, isKilled: false, sellLossCount: 0,
      buyLossCount: 0, sessionTradeCount: 0, dailyBuys: 0, dailySells: 0, sessionBuyLossStreak: 0, sessionSellLossStreak: 0 };
    const data: any = { tradeId: 'RAW', direction: 'BUY', entryPrice: 1, slPrice: sl, tp1Price: 1.001,
      points: 10, events: ['EVENTO_CHOCH_5M'], tf: '5M' };
    if (raw !== undefined) data.tp2 = raw;
    const cfg = { ticker: 'EURUSD', sessionWarmupMin: 0, executionPolicy: { profile: 'microstructure_v1', targets }, executionInstrument: instrument };
    moduleBox.exports.create(data, now, trades, active, stats, cfg, state);
    const valid = raw === 1.01 || (raw === undefined && targets);
    // targets:false with absent TP2 retains the legacy RIDER convention, not new target math.
    if (raw === undefined && !targets) {
      assert.equal(trades.length, 1);
      assert.equal(trades[0].tp2Price, 0, 'absent ablated target retains legacy RIDER zero');
      return;
    }
    assert.equal(trades.length, valid ? 1 : 0, 'explicit invalid and truly absent TP2 are different inputs');
    if (valid) assert.ok(trades[0].tp2Price > trades[0].entryPrice);
  });
}
test('valid experimental cohort and all legacy TP2 edges match exact pre-fix caller', () => {
  const before = { exports: {} as any };
  const source = fs.readFileSync('/tmp/jarvis-execution-verification/fix-targets/before/jarvis-os/src/services/backtestEngine.ts', 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText, { module: before, exports: before.exports, require: createRequire(engineUrl),
    console, Date, Math, Map, Set, process, structuredClone, TextEncoder, TextDecoder, atob, btoa });
  assert.equal(JSON.stringify(cohort(1.5)), JSON.stringify(cohort(1.5, false, before.exports)), 'entire valid experimental run unchanged');
  for (const rr of [undefined, 1.5, NaN, Infinity, 0, -1]) {
    assert.equal(JSON.stringify(cohort(rr, true)), JSON.stringify(cohort(rr, true, before.exports)), `entire legacy run unchanged RR=${String(rr)}`);
  }
});
for (const targets of [false,true]) test(`whole direct effective TP2 RR override targets=${targets}`, () => {
  const policy = { executionPolicy: { profile: 'microstructure_v1', targets } };
  const positive = cohort(1.5, false, undefined, { ...policy, tp2RR: '1.5' });
  assert.equal(positive.trades.length, 5, 'same real CLI positive override control');
  for (const rr of [0, '0', -1, '-1', NaN, 'NaN', Infinity, 'Infinity']) {
    const result = cohort(1.5, false, undefined, { ...policy, tp2RR: rr });
    assert.equal(result.trades.length, targets ? 5 : 0, targets ? 'inapplicable override stays ignored' : `invalid effective override RR=${String(rr)}`);
  }
});
for (const targets of [false,true]) test(`offline actual TimesFM modified target validated before SAR targets=${targets}`, () => {
  const engine = loadTargetEngine();
  const { now } = seeded('SELL');
  const key = Math.floor(now / 300000) * 300000;
  const forecast = (target: number) => new Map([[key, { ts: key, horizon: 1, point: [target], q10: [target-.001], q50: [target-.0005], q90: [target] }]]);
  const cfg = { timesfm: { enabled: true, tp2Dynamic: 'q90', tp2Q90Step: 0 } };
  engine.seedForecast(forecast(.99));
  const positive = reversalBoundary('SELL', targets, {}, cfg, engine);
  assert.equal(positive.trades.length, 2, 'offline cache reaches actual forecast target replacement and reversal');
  assert.equal(positive.trades[1].timesfmAction, 'APPROVE');
  assert.ok(positive.trades[1].tp2Price < 1 && positive.trades[1].tp2Price > 0);
  for (const target of [0, -1]) {
    engine.seedForecast(forecast(target));
    const rejected = reversalBoundary('SELL', targets, {}, cfg, engine);
    assert.equal(rejected.after, rejected.before, 'directional but nonpositive dynamic target cannot close/erase the opposite trade');
  }
});

// Small synthetic OHLC replay: all fills remain explicitly MODELED. No ticks/broker data.
function smallCaller(direction: 'BUY'|'SELL', family: 'CHOCH'|'BOS', targets: boolean, rr: number|string,
    entryTrigger = 'CHOCH', extra: any = {}, engine = { parseCSV, runBacktest }) {
  const sign = direction === 'BUY' ? 1 : -1, step = 300_000, start = Date.parse('2026-07-14T15:00:00Z');
  const late = entryTrigger === 'LATE';
  const price = 1.1+sign*.000006, origin = price-sign*.001;
  const bar = (at: number, o: number, c: number, h: number, l: number): any => ({ tf: '5', openTimeMs: at-step,
    closeTimeMs: at, availableAtMs: at, open: o, close: c, high: h, low: l, closed: true });
  const lines: string[] = [];
  const emit = (prefix: string, at: number, b: any, extraText = '', extraObservation: any = {}) => {
    const observation = context.buildExecutionObservation({ ticker: 'EURUSD', tf: '5', observedAtMs: at, bar: b, ...extraObservation });
    lines.push(context.appendExecutionEnvelope(`${prefix} | TF: 5 | Precio: ${b.close} | High: ${b.high} | Low: ${b.low} | ${extraText} | TS: ${at}`, observation));
  };
  for (let i = 0; i < 15; i++) {
    const at = start-(14-i)*step;
    const b = i === 14 ? bar(at, origin, price, Math.max(origin,price)+.0001, Math.min(origin,price)-.0001)
      : bar(at, price, price, price+.002, price-.002);
    emit('PING_PRICE', at, b);
  }
  const b = bar(start, origin, price, Math.max(origin,price)+.0001, Math.min(origin,price)-.0001);
  if (!late) emit('EVENTO_SMC_DIV', start, b, direction);
  emit(`EVENTO_${family}`, start+1, b, `${direction} | ORIGIN: ${origin}`, { breakBar: b,
    impulse: { direction, origin, extreme: price, createdAtMs: start+1 } });
  if (late) emit('EVENTO_SWEEP', start+2, b, direction);
  if (entryTrigger === 'SMART' || entryTrigger === 'OTE') {
    const close = price-sign*.0007, open = price-sign*.0005;
    emit('PING_PRICE', start+step, bar(start+step, open, close, Math.max(open,close)+.00005, Math.min(open,close)-.0001));
  }
  const trigger = { enabled: true, minPoints: 1, minScore: late ? 99 : 1,
    ...(late ? { minScoreBuy: 1, minScoreSell: 1 } : {}), tp2: late ? 1.5 : rr };
  const session = { choch5m: trigger, bos5m: trigger, oteChoch5m: trigger, oteBos5m: trigger };
  const cfg: any = { ticker: 'EURUSD', entryTrigger: late ? 'CHOCH' : entryTrigger, minBuyPoints: 1, minSellPoints: 1, oteEntryPercent: 62,
    maxTradesPerDay: 100, sessionWarmupMin: 0, slBufferPercent: .1, rolloverPeakPips: 0, fixedRR: late ? rr : 1.5, spreadPips: 0,
    executionPolicy: { profile: 'microstructure_v1', targets, ...(entryTrigger === 'OTE' ? { smart: false } : {}) },
    executionInstrument: instrument, sessions: { ASIA: session, LONDON: session, NY: session, OFF: session }, ...extra };
  const entries = engine.parseCSV(lines.join('\n')).lines;
  const random = Math.random; Math.random = () => .123456789;
  try { return engine.runBacktest(new Map(), cfg, undefined, entries); } finally { Math.random = random; }
}
for (const direction of ['BUY','SELL'] as const) for (const family of ['CHOCH','BOS'] as const) {
  for (const targets of [false,true]) test(`whole small direct RR source rejects zero before rounding ${direction} ${family} targets=${targets}`, () => {
    const valid = smallCaller(direction, family, targets, 1.5);
    assert.equal(valid.trades.length, 1, 'positive control from the identical small caller');
    assert.equal(valid.trades[0].direction, direction);
    assert.equal(valid.trades[0].triggerType, `${family.toLowerCase()}5m`);
    assert.equal((valid.trades[0] as any).executionBacktest.fillSource, 'MODELED');
    for (const rr of [0, '0', -1, '-1', NaN, 'NaN', Infinity, 'Infinity']) {
      assert.equal(smallCaller(direction, family, targets, rr).trades.length, 0, `RR=${String(rr)} cannot be rounded into a favorable request`);
    }
  });
  for (const entryTrigger of ['SMART','OTE']) for (const targets of [false,true]) test(`whole small routes ${entryTrigger} ${direction} ${family} targets=${targets}`, () => {
    const valid = smallCaller(direction, family, targets, 1.5, entryTrigger);
    assert.equal(valid.trades.length, 1, 'nonempty causal OHLC positive control required');
    assert.equal((valid.trades[0] as any).executionBacktest.fillSource, 'MODELED');
    assert.equal(valid.trades[0].direction, direction);
    assert.ok(valid.trades[0].triggerType?.startsWith('ote'), 'full router/retracement/Alpha/createTrade path');
    for (const rr of [0, -1, NaN, 'NaN', Infinity]) {
      assert.equal(smallCaller(direction, family, targets, rr, entryTrigger).trades.length, 0, `RR=${String(rr)}`);
    }
  });
}
for (const direction of ['BUY','SELL'] as const) for (const targets of [false,true]) test(`whole late direct RR source ${direction} targets=${targets}`, () => {
  const positive = smallCaller(direction, 'CHOCH', targets, 1.5, 'LATE');
  assert.equal(positive.trades.length, 1, 'positive late-revalidation caller');
  assert.equal(positive.trades[0].timestamp, Date.parse('2026-07-14T15:00:00Z')+2, 'filled by sweep-triggered late validation, not initial CHOCH');
  for (const rr of [0, '0', -1, '-1', NaN, 'NaN', Infinity]) {
    assert.equal(smallCaller(direction, 'CHOCH', targets, rr, 'LATE').trades.length, 0, `explicit late RR=${String(rr)}`);
  }
});
test('complete valid experimental and legacy edge outputs match this correction PRE', () => {
  const before = loadTargetEngine(fs.readFileSync('/tmp/jarvis-execution-verification/fix-direct-targets/before/jarvis-os/src/services/backtestEngine.ts', 'utf8'));
  const equal = (actual: any, expected: any, message: string) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
  const edges = [undefined, 1.5, '1.5', NaN, 'NaN', Infinity, 'Infinity', 0, '0', -1, '-1'];
  for (const targets of [false,true]) {
    const cfg = { executionPolicy: { profile: 'microstructure_v1', targets } };
    for (const rr of [undefined, 1.5, '1.5']) for (const tp2RR of [undefined, 1.5, '1.5']) {
      const extra = { ...cfg, tp2RR };
      equal(cohort(rr, false, undefined, extra), cohort(rr, false, before, extra), `complete experimental PRE targets=${targets} RR=${String(rr)} override=${String(tp2RR)}`);
    }
    for (const direction of ['BUY','SELL'] as const) for (const family of ['CHOCH','BOS'] as const) for (const route of ['CHOCH','SMART','OTE', ...(family === 'CHOCH' ? ['LATE'] : [])]) {
      const next = smallCaller(direction, family, targets, 1.5, route);
      assert.equal(next.trades.length, 1, `each parity control is nonempty ${direction}/${family}/${route}/${targets}`);
      equal(next, smallCaller(direction, family, targets, 1.5, route, {}, before), `complete small PRE ${direction}/${family}/${route}/${targets}`);
    }
    for (const direction of ['BUY','SELL'] as const) {
      equal(reversalBoundary(direction, targets).after, reversalBoundary(direction, targets, {}, {}, before).after, 'valid modeled SAR full effects unchanged');
    }
  }
  for (const rr of edges) {
    equal(cohort(rr, true), cohort(rr, true, before), `complete legacy source RR=${String(rr)}`);
    equal(cohort(1.5, true, undefined, { tp2RR: rr }), cohort(1.5, true, before, { tp2RR: rr }), `complete legacy override RR=${String(rr)}`);
  }
});
console.log(`TARGET_CALLERS ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
