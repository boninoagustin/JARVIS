import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { parseCSV, runBacktest } from '../../jarvis-os/src/services/backtestEngine';
import type { BacktestConfig } from '../../jarvis-os/src/services/backtestTypes';
import * as replay from '../../jarvis-os/src/services/replayWindow';

const start = Date.parse('2026-07-14T15:00:00Z');
const end = start + 600_000;
const config: BacktestConfig = { ticker: 'EURUSD', entryTrigger: 'CHOCH', minBuyPoints: 1,
  minSellPoints: 1, oteEntryPercent: 70, maxTradesPerDay: 1, maxTradesPerSession: 1 };
const event = (prefix: string, time: number, extra = '', tf = '5') =>
  parseCSV(`${prefix} | TF: ${tf} | ${extra} | TS: ${time}`).lines[0];
const ping = (time: number, price = 1.1, tf = '5') =>
  event('PING_PRICE', time, `Precio: ${price} | High: ${price + 0.0002} | Low: ${price - 0.0002}`, tf);
const setup = (time: number) => [ping(time), event('EVENTO_CHOCH', time + 1, 'BUY | ORIGIN: 1.099 | Precio: 1.1')];
const fixture = [...setup(start - 120_000), ...setup(start), ping(end - 1), ...setup(end)];
const options = { warmupStartMs: start - 120_000, evaluationStartMs: start, evaluationEndMs: end,
  statePolicy: 'context-only-reset-execution-v1' as const, minContextObservations: { '5': 1 } };
function run(entries = fixture, window: any = undefined, cfg = config): any {
  const random = Math.random;
  Math.random = () => 0.123456789;
  try { return (runBacktest as any)(new Map(), structuredClone(cfg), undefined, entries, window); }
  finally { Math.random = random; }
}
// Execute the approved source baseline against the identical real pipeline fixture.
const baselinePath = '/tmp/jarvis-wfa-before-t1mfwfwc/source.tar';
const baselineSource = execFileSync('tar', ['-xOf', baselinePath, 'jarvis-os/src/services/backtestEngine.ts'], { encoding: 'utf8' });
const baselineModule = { exports: {} as any };
vm.runInNewContext(ts.transpileModule(baselineSource, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText,
{ require: createRequire(new URL('../../jarvis-os/src/services/backtestEngine.ts', import.meta.url)),
  exports: baselineModule.exports, module: baselineModule, console, Date, Map, Set, Math, process });
const random = Math.random;
Math.random = () => 0.123456789;
let baseline: any;
try { baseline = baselineModule.exports.runBacktest(new Map(), structuredClone(config), undefined, fixture); }
finally { Math.random = random; }
assert.ok(baseline.trades.length > 0, 'legacy fixture must actually trade');
assert.deepEqual(JSON.parse(JSON.stringify(run())), JSON.parse(JSON.stringify(baseline)), 'no options preserves approved legacy result exactly');
const result = run(fixture, options);
assert.ok(result.replayDiagnostics, 'explicit replay must provide real warmup diagnostics');
assert.equal(result.replayDiagnostics.version, 1);
assert.equal(result.replayDiagnostics.warmupEvents, 2);
assert.equal(result.replayDiagnostics.evaluationEvents, 3);
assert.equal(result.replayDiagnostics.readiness.ready, true);
assert.equal(result.trades.length, 1, 'warmup must not exhaust the one-trade daily/session budget');
assert.ok(result.trades.every((t: any) => t.timestamp >= start && t.timestamp < end));
assert.equal(result.trades[0].closeTimestamp, end - 1, 'exclusive end excludes future closing prices and orders');
assert.equal(result.replayDiagnostics.boundarySnapshot.dailyStats.tradeCount, 0);
assert.equal(result.replayDiagnostics.boundarySnapshot.dailyStats.sessionExp, undefined);
assert.deepEqual(result.replayDiagnostics.boundarySnapshot.state.scoreBuy.events, []);
assert.equal(result.replayDiagnostics.boundarySnapshot.state.activeImpulseBuy, null);
assert.equal(result.replayDiagnostics.boundarySnapshot.state.lastSniperAlert, 0);
console.log('PASS legacy parity, warmup isolation and half-open bounds');

const unready = run(fixture, { ...options, minContextObservations: { '5': 2, 'D': 1 } });
assert.equal(unready.replayDiagnostics.readiness.ready, false);
assert.deepEqual(unready.replayDiagnostics.readiness.missing, ['5', 'D']);
assert.equal(unready.trades.length, 0, 'evaluation observations never retroactively satisfy warmup');
const empty = run([], options);
assert.equal(empty.replayDiagnostics.readiness.ready, false);
assert.equal(empty.trades.length, 0);
const pendingOnly = run([ ...setup(start - 120_000), ping(start, 1.0993), ping(start + 60_000, 1.0995) ], options,
  { ...config, entryTrigger: 'BOTH' });
assert.equal(pendingOnly.trades.length, 0, 'warmup CHOCH cannot leave a pending OTE');
for (const patch of [ { warmupStartMs: -1 }, { warmupStartMs: start + 1 }, { evaluationEndMs: start },
  { evaluationEndMs: Infinity }, { evaluationStartMs: start + 0.5 }, { statePolicy: 'unknown' },
  { minContextObservations: { unknown: 1 } }, { minContextObservations: { '5': -1 } },
  { minContextObservations: { '5': 1.5 } }, { evaluationEndMs: Number.MAX_SAFE_INTEGER } ]) {
  assert.throws(() => run(fixture, { ...options, ...patch }), RangeError);
}
console.log('PASS insufficient readiness, empty input, pending OTE isolation and invalid windows');

assert.equal(typeof (replay as any).planReplayWindow, 'function', 'adaptive planner must be exported');
const planReplayWindow = (replay as any).planReplayWindow as typeof import('../../jarvis-os/src/services/replayWindow').planReplayWindow;
const day = 86_400_000;
const tfs = ['5', '15', '60', '240', 'D'];
const history = Array.from({ length: 90 }, (_, i) => tfs.map((tf, j) =>
  ping(start - (90 - i) * day + j, 1.1 + i * 0.000001 + j * 0.0000001, tf))).flat();
const planned = planReplayWindow(history, start, end);
assert.equal(planned.warmupStartMs, start - 60 * day, '60 daily observations extend past the 14-day floor');
assert.deepEqual(planned.minContextObservations, { '5': 60, '15': 60, '60': 60, '240': 60, D: 60 });
assert.deepEqual(planReplayWindow([...history].reverse(), start, end), planned, 'planner is input-order independent');
const adaptive = run(history, planned).replayDiagnostics;
assert.equal(adaptive.readiness.ready, true);
for (const tf of tfs) assert.equal(adaptive.readiness.observations[tf], 60);
const longer = run(history, { ...planned, warmupStartMs: start - 90 * day }).replayDiagnostics;
const a = adaptive.boundarySnapshot.state;
const b = longer.boundarySnapshot.state;
assert.deepEqual(a.htfCloses, b.htfCloses, 'last-60 HTF buffer equals longer-history reference');
assert.equal(a.lastPrice, b.lastPrice);
assert.equal(a.previousPrice, b.previousPrice);
const atrDifference = Math.abs(a.atr14 - b.atr14);
assert.ok(atrDifference < 1e-9, `ATR initialization residue measured ${atrDifference}`);
console.log(`PASS adaptive 60D context and longer-history snapshot; ATR difference=${atrDifference}`);

// A present malformed range must not fall back to a valid flat-price observation.
for (const range of ['High: Infinity | Low: 1.09', 'High: -1 | Low: 1.09',
  'High: 1.11 | Low: -1', 'High: 1.11oops | Low: 1.09']) {
  const invalid = event('PING_PRICE', start - 10, `Precio: 1.1 | ${range}`);
  assert.equal(replay.contextObservationTf(invalid), undefined, `invalid supplied range: ${range}`);
  const checked = run([invalid, ...setup(start)], options);
  assert.equal(checked.replayDiagnostics.readiness.ready, false);
  assert.equal(checked.replayDiagnostics.boundarySnapshot.state.lastPrice, null);
}
console.log('PASS malformed ranges cannot fabricate readiness or hydrate context');

// Duplicate timestamps must neither satisfy readiness nor update ATR/HTF twice.
const singleWarmup = [ping(start - 1, 1.1, 'D')];
const duplicateWarmup = [...singleWarmup, ping(start - 1, 1.1001, 'D')];
const dailyOptions = { ...options, minContextObservations: { D: 2 } };
const singleSnapshot = run(singleWarmup, dailyOptions).replayDiagnostics;
const duplicateSnapshot = run(duplicateWarmup, dailyOptions).replayDiagnostics;
assert.deepEqual(duplicateSnapshot.readiness, singleSnapshot.readiness);
assert.deepEqual(duplicateSnapshot.boundarySnapshot, singleSnapshot.boundarySnapshot);
assert.equal(duplicateSnapshot.readiness.ready, false);
const invalidRanges = [
  { currentPrice: NaN }, { currentPrice: 0 }, { highPrice: Infinity },
  { lowPrice: 0 }, { highPrice: 1 }, { lowPrice: 2 },
];
for (const invalidRange of invalidRanges) {
  const invalid = structuredClone(ping(start - 1));
  Object.assign(invalid.parsed!, invalidRange);
  assert.equal(replay.contextObservationTf(invalid), undefined);
}
assert.deepEqual(planReplayWindow([...history, ...history, ...setup(end + day)], start, end), planned);
assert.equal(planReplayWindow(history.slice(0, 10), start, end).warmupStartMs, history[0].ts,
  'available sparse history is used without inventing observations');
console.log('PASS distinct observations, invalid OHLC, sparse history and future exclusion');

// Prepared SYNC payload avoids the legacy CSV wrapper's first-comma heuristic.
const zones = { ts: start - 50, tf: '60',
  line: 'SYNC_ZONES | TF: 60 | Trend: BUY | Payload: []',
  parsed: { prefix: 'SYNC_ZONES', eventTf: '60', readableTf: '1H', currentDirection: 'BUY' as const,
    trendMatch: 'BUY', rawZones: [{ top: 1.101, btm: 1.099, dir: 'BUY', medal: 'God' }] } };
const richWarmup = [ping(start - 100), zones,
  event('EVENTO_CHOCH', start - 40, 'BUY | ORIGIN: 1.099 | Precio: 1.1'),
  event('EVENTO_BOS', start - 30, 'SELL | ORIGIN: 1.101 | Precio: 1.1', '240'),
  event('EVENTO_SWEEP', start - 20, 'BUY | ABSORCION | VWAP: UNDER'),
  event('EVENTO_SMC_DIV', start - 10, 'BUY'), ping(start - 2)];
const snapshots: any[] = [];
const isolated = runBacktest(new Map(), structuredClone(config), (_pct, trades) => snapshots.push(structuredClone(trades)),
  richWarmup, options);
assert.equal(isolated.trades.length, 0);
assert.ok(snapshots.every(trades => trades.length === 0), 'no warmup orders even through progress callbacks');
const boundary = isolated.replayDiagnostics!.boundarySnapshot!;
assert.equal(boundary.orders, 0);
assert.equal(boundary.activeTrades, 0);
assert.equal(boundary.state.zones.length, 1);
assert.equal(boundary.state.marketBias['60'], 'BUY');
assert.equal(boundary.state.marketBias['240'], 'SELL');
assert.equal(boundary.state.vwapStatus['5'], 'UNDER');
for (const name of ['activeImpulseBuy', 'activeImpulseSell', 'activeMacroImpulseBuy', 'activeMacroImpulseSell']) {
  assert.equal((boundary.state as any)[name], null, name);
}
assert.deepEqual(boundary.state.activeLocks, []);
assert.deepEqual(boundary.state.scoreBuy, { points: 0, lastUpdate: 0, events: [] });
assert.deepEqual(boundary.state.scoreSell, { points: 0, lastUpdate: 0, events: [] });
assert.equal(boundary.state.lastSniperAlert, 0);
assert.equal(boundary.state.tickTimes, undefined);
assert.equal(boundary.state.densityMedian, undefined);
assert.deepEqual(boundary.dailyStats, run([], options).replayDiagnostics.boundarySnapshot.dailyStats);
console.log('PASS all operational boundary fields, passive zones/bias/VWAP and no transient orders');

// Exercise the actual legacy pipeline across directions, TFs and entry policies.
let legacyCases = 0;
for (const ticker of ['EURUSD', 'BTCUSD']) {
  for (const entryTrigger of ['CHOCH', 'OTE', 'BOTH', 'SMART'] as const) {
    const cfg = { ...config, ticker, entryTrigger, maxTradesPerDay: 0, maxTradesPerSession: 0 };
    const entries = [...fixture, event('EVENTO_BOS', end + 1, 'SELL | ORIGIN: 1.102 | Precio: 1.1', '15'),
      ping(end + 120_000, 1.099), ping(end + 300_000, 1.101)];
    Math.random = () => 0.123456789;
    let expected: any;
    try { expected = baselineModule.exports.runBacktest(new Map(), structuredClone(cfg), undefined, entries); }
    finally { Math.random = random; }
    assert.deepEqual(JSON.parse(JSON.stringify(run(entries, undefined, cfg))), JSON.parse(JSON.stringify(expected)), `${ticker}/${entryTrigger}`);
    legacyCases++;
  }
}
console.log(`PASS ${legacyCases} additional exact legacy parity cases`);
