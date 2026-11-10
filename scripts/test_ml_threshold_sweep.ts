import assert from 'node:assert/strict';
import { parseSweepArgs, completedTrades, metrics, chronologicalWindows, isolateML, temporalBounds } from './ml_threshold_sweep.js';

// ── parseSweepArgs ──
assert.deepEqual(parseSweepArgs(['--ticker', 'eurusd']), { ticker: 'EURUSD', apply: false, assumeTrainedAt: false });
assert.deepEqual(parseSweepArgs(['--ticker', 'GBPUSD', '--apply']), { ticker: 'GBPUSD', apply: true, assumeTrainedAt: false });
assert.deepEqual(parseSweepArgs(['--ticker', 'X', '--assume-trained-at']), { ticker: 'X', apply: false, assumeTrainedAt: true });
assert.throws(() => parseSweepArgs([]), /--ticker is required/);
assert.throws(() => parseSweepArgs(['--ticker', 'ALL']), /invalid ticker/);
assert.throws(() => parseSweepArgs(['--ticker']), /--ticker requires/);
assert.throws(() => parseSweepArgs(['--bogus']), /unknown option/);
assert.throws(() => parseSweepArgs(['--apply', '--apply']), /duplicate --apply/);
assert.throws(() => parseSweepArgs(['--ticker', 'bad ticker']), /invalid ticker/);

// ── completedTrades: only closed, non-censored, in-window ──
const mk = (o: any) => ({ timestamp: 1000, closeTimestamp: 2000, rMultiple: 0.5, result: 'WIN', ...o });
const trades = [
  mk({ timestamp: 500, closeTimestamp: 1500 }),           // entry before window → drop
  mk({ timestamp: 1200, closeTimestamp: 2500 }),          // close after to → drop
  mk({ timestamp: 1200, closeTimestamp: 1800 }),          // ok
  mk({ timestamp: 1300, closeTimestamp: 1900, rMultiple: NaN }), // non-finite → drop
  mk({ timestamp: 1400, closeTimestamp: 1950, result: 'OPEN' }), // unconfirmed → drop
  mk({ timestamp: 1500, closeTimestamp: 1900, executionBacktest: { closeReason: 'FINAL_CENSOR' } }), // censored → drop
  mk({ timestamp: 1600, closeTimestamp: 1800 }),          // ok
];
const closed = completedTrades(trades, 1000, 2000, 3000);
assert.equal(closed.length, 2);
assert.ok(closed.every(t => t.timestamp >= 1000 && t.closeTimestamp < 2000 && t.closeTimestamp < 3000));

// ── metrics ──
assert.deepEqual(metrics([]), { n: 0, wr: 0, pf: 0, pnlR: 0, mdd: 0 });
const m = metrics([
  { rMultiple: 0.5 }, { rMultiple: -0.2 }, { rMultiple: 0.3 }, { rMultiple: -0.4 },
]);
assert.equal(m.n, 4);
assert.equal(m.wr, 50);            // 2 wins / 4
assert.ok(Math.abs(m.pf - (0.8 / 0.6)) < 1e-9); // gp 0.8 / gl 0.6
assert.ok(Math.abs(m.pnlR - 0.2) < 1e-9);
// equity: .5,.3,.6,.2 → peak .6, min after peak .2 → mdd .4
assert.ok(Math.abs(m.mdd - 0.4) < 1e-9);
assert.throws(() => metrics([{ rMultiple: NaN }]), /invalid closed-trade return/);

// ── chronologicalWindows ──
assert.equal(chronologicalWindows([], 0, 1000), undefined);
const entries = [0, 1, 2, 3].map(ts => ({ ts: ts * 1000 }));
const w = chronologicalWindows(entries, -1, 9999)!;
assert.ok(w);
assert.ok(w.selection.from < w.selection.to && w.selection.to < w.validation.from && w.validation.from < w.validation.to);
assert.equal(w.validation.to, 3001); // last ts + 1

// ── isolateML: apaga TimesFM y pone correlación en observación, sin mutar el original ──
const src = { ticker: 'EURUSD', enabled: true, timesfm: { enabled: true, horizon: 12 }, correlationFilter: { shadow: false } };
const iso = isolateML(src);
assert.equal(iso.timesfm.enabled, false);
assert.equal(iso.correlationFilter.shadow, true);
assert.equal(src.timesfm.enabled, true, 'no debe mutar el asset original');
assert.equal(src.correlationFilter.shadow, false);
assert.equal(iso.enabled, true, 'los parámetros de trading se conservan');
const noTfm = isolateML({ ticker: 'X', enabled: false });
assert.equal(noTfm.timesfm, undefined);
assert.equal(noTfm.correlationFilter, undefined);

// ── temporalBounds: autoritativo vs derivado conservador (opt-in) ──
assert.equal(temporalBounds({ meta: { train_end_ms: 1500, available_at_ms: 1600 } }).status, 'verified');
assert.equal(temporalBounds({ meta: { train_end_ms: 1500, available_at_ms: 1600 } }).derived, undefined);
// trained_at sin Z y sin train_end_ms → fail-closed salvo opt-in
assert.equal(temporalBounds({ meta: { trained_at: '2026-08-03T10:30:18' } }).status, 'unknown');
assert.equal(temporalBounds({ meta: { trained_at: '2026-08-03T10:30:18Z' } }).status, 'unknown');
const derived = temporalBounds({ meta: { trained_at: '2026-08-03T10:30:18' } }, true);
assert.equal(derived.status, 'verified');
assert.equal(derived.derived, 'derived_from_trained_at_conservative_cutoff');
assert.equal(derived.train_end_ms, derived.available_at_ms); // corte conservador = fecha de entrenamiento
assert.ok(derived.available_at_ms! > 0);
// trained_at con Z + opt-in también deriva train_end_ms conservador
const derivedZ = temporalBounds({ meta: { trained_at: '2026-08-03T10:30:18Z' } }, true);
assert.equal(derivedZ.status, 'verified');
assert.equal(derivedZ.train_end_ms, derivedZ.available_at_ms);
// train_end_ms autoritativo + trained_at Z → verified sin derived
assert.equal(temporalBounds({ meta: { train_end_ms: 1500, trained_at: '2026-08-03T10:30:18Z' } }).derived, undefined);

console.log('PASS sweep: args, closed-trade filtering, metrics, chronological split, aislamiento ML, corte temporal (hermético)');
