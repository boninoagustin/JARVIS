import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.ok(existsSync(new URL('./evaluation_protocol.ts', import.meta.url)), 'missing temporal protocol implementation');
const p = await import('./evaluation_protocol.js');
const m = { version: 1, ticker: 'EURUSD', from_ms: 1000, train_end_ms: 1700,
  validation_end_ms: 2000, test_end_ms: 2200, test_independence: 'unverified' };
const dir = mkdtempSync(join(tmpdir(), 'jarvis-protocol-'));
try {
  const file = join(dir, 'manifest.json');
  writeFileSync(file, JSON.stringify(m));
  const loaded = p.loadEvaluationManifest(file, 'EURUSD');
  assert.deepEqual(loaded, m);
  const entries = [999, 1000, 1699, 1700, 1999, 2000, 2199, 2200].map(ts => ({ts}));
  assert.deepEqual(p.filterWindow(entries, loaded, 'train').map(e => e.ts), [1000,1699]);
  assert.deepEqual(p.filterWindow(entries, loaded, 'validation').map(e => e.ts), [1700,1999]);
  assert.deepEqual(p.filterWindow(entries, loaded, 'test').map(e => e.ts), [2000,2199]);
  assert.equal(p.configFingerprint({b: 2, a: {z: 1, y: [2,3]}}),
    p.configFingerprint({a: {y: [2,3], z: 1}, b: 2}));
  assert.notEqual(p.configFingerprint({a: [1,2]}), p.configFingerprint({a:[2,1]}));
  assert.throws(() => p.configFingerprint({value: NaN}), /finite|JSON/);
  assert.throws(() => p.filterWindow([{ts: NaN}], loaded, 'train'), /timestamp/);
  assert.throws(() => p.loadEvaluationManifest({...m, ticker: 'GBPUSD'}, 'EURUSD'), /ticker/);
  assert.throws(() => p.loadEvaluationManifest({...m, train_end_ms: '1700'}, 'EURUSD'), /integer/);
  assert.throws(() => p.loadEvaluationManifest({...m, test_end_ms:1999}, 'EURUSD'), /bounds|end/);
  assert.throws(() => p.loadEvaluationManifest({...m, from_ms:true}, 'EURUSD'), /integer/);
  assert.throws(() => p.loadEvaluationManifest({...m, extra:0}, 'EURUSD'), /fields/);
  const model = {meta: {train_end_ms:1500, available_at_ms:1600}};
  assert.equal(typeof p.modelAvailability, 'function', 'missing metadata-based ML availability');
  assert.deepEqual(p.modelAvailability(model), {status:'verified', train_end_ms:1500, available_at_ms:1600});
  assert.equal(p.modelAvailability({meta:{trained_at:'2026-08-03T10:30:18'}}).status, 'unknown');
  assert.equal(p.modelAvailability({meta:{train_end_ms:1500, available_at_ms:1499}}).status, 'unknown');
  assert.equal(p.modelAvailability({meta:{train_end_ms:1500, trained_at:'2026-08-03T10:30:18Z'}}).status, 'verified');
  assert.equal(typeof p.partitionTrades, 'function', 'missing censored-trade handling');
  const trades = p.partitionTrades([
    {timestamp:1100, closeTimestamp:1200, result:'WIN', rMultiple:2},
    {timestamp:1200, closeTimestamp:1699, result:'WIN', rMultiple:3},
    {timestamp:1300, result:'LOSS'},
    {timestamp:1400, closeTimestamp:1700, result:'LOSS', rMultiple:-1},
    {timestamp:1700, closeTimestamp:1800, result:'WIN', rMultiple:1},
  ], loaded, 'train', 1699);
  assert.equal(trades.length,4);
  assert.equal(trades[0].rMultiple,2);
  assert.equal(trades[0].closedAt,1200);
  assert.equal(trades[1].result,null, 'terminal forced close is not a real label');
  assert.equal(trades[1].rMultiple,null);
  assert.equal(trades[2].result,null);
  assert.equal(trades[3].closeTs,null, 'future close cannot be consumed');
  assert.equal(typeof p.readOnlyReplayConfig, 'function', 'missing read-only replay guard');
  const writable = {ticker:'EURUSD', timesfm:{enabled:true,cachePath:file,
    auditPath:join(dir,'audit.jsonl'),collectPath:join(dir,'collect.jsonl'),collectOnly:true}};
  const readonly = p.readOnlyReplayConfig(writable);
  assert.deepEqual(readonly.timesfm,{enabled:true,cachePath:file});
  assert.equal(writable.timesfm.collectOnly,true, 'guard must not mutate the caller snapshot');
  assert.equal(p.configFingerprint(readonly),p.configFingerprint(p.readOnlyReplayConfig(readonly)));
  assert.throws(() => p.readOnlyReplayConfig({timesfm:{enabled:true,collectOnly:true}}), /cachePath/);
  assert.deepEqual(p.readOnlyReplayConfig({timesfm:{enabled:false,collectOnly:true,auditPath:file}}),
    {timesfm:{enabled:false}});
  console.log('PASS temporal TS: boundaries, canonical fingerprint, ML metadata, censored labels, read-only replay');
} finally { rmSync(dir, {recursive: true, force: true}); }
