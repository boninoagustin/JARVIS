import assert from 'node:assert/strict';
import { parseSweepArgs, completedTrades, metrics, chronologicalWindows } from './ml_threshold_sweep.js';

// ── parseSweepArgs ──
assert.deepEqual(parseSweepArgs(['--ticker', 'eurusd']), { ticker: 'EURUSD', apply: false });
assert.deepEqual(parseSweepArgs(['--ticker', 'GBPUSD', '--apply']), { ticker: 'GBPUSD', apply: true });
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

console.log('PASS sweep: args, closed-trade filtering, metrics, chronological split (hermético)');
