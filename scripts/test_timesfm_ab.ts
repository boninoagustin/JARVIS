import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyTimesfmAsOf, auditTimesfmCache, readTriggerTs, MIN_TIMESFM_FORECASTS } from './timesfm_ab.js';

// ── verifyTimesfmAsOf ──
const mkFc = (o: any) => ({ ts: 1000, horizon: 12, q10: [1, 2], q50: [1, 2], q90: [1, 2], ...o });
assert.equal(verifyTimesfmAsOf(mkFc({ availableAt: 1000 })).ok, true, 'availableAt == ts es as-of válido');
assert.equal(verifyTimesfmAsOf(mkFc({ computedAt: 500 })).ok, true, 'computedAt < ts es as-of válido');
assert.equal(verifyTimesfmAsOf(mkFc({ availableAt: 1001 })).ok, false, 'availableAt > ts es look-ahead');
assert.equal(verifyTimesfmAsOf(mkFc({})).ok, false, 'sin availableAt/computedAt no es verificable');
assert.equal(verifyTimesfmAsOf(mkFc({ ts: 'no' })).ok, false, 'ts inválido');
assert.equal(verifyTimesfmAsOf(mkFc({ availableAt: 1000, q50: [] })).ok, false, 'cuantiles faltantes');

// ── auditTimesfmCache (hermético, archivo temporal) ──
const dir = mkdtempSync(path.join(tmpdir(), 'tfm-ab-'));
const cache = path.join(dir, 'forecasts_m5.jsonl');
const mkLine = (o: any) => JSON.stringify({ ts: 1000, horizon: 12, q10: [1], q50: [1], q90: [1], ...o }) + '\n';
try {
  // insuficiente: pocos forecasts + sin as-of
  writeFileSync(cache, mkLine({ ts: 1000 }) + mkLine({ ts: 2000 }));
  const sparse = auditTimesfmCache(cache, [1000, 2000]);
  assert.equal(sparse.ok, false);
  assert.equal(sparse.valid, 0, 'sin as-of → 0 válidos');
  assert.ok(sparse.reasons.some(r => /as-of/.test(r)));
  assert.ok(sparse.reasons.some(r => /cobertura insuficiente/.test(r)));

  // suficiente + as-of completo → cobertura 1
  const lines: string[] = [];
  for (let i = 0; i < MIN_TIMESFM_FORECASTS; i++) lines.push(mkLine({ ts: 1000 + i, availableAt: 1000 + i }));
  writeFileSync(cache, lines.join(''));
  const full = auditTimesfmCache(cache, lines.map((_, i) => 1000 + i));
  assert.equal(full.ok, true, `as-of completo debería pasar (valid=${full.valid})`);
  assert.equal(full.coverage, 1);

  // cobertura parcial → ok=false por triggers sin forecast
  writeFileSync(cache, lines.join(''));
  const partial = auditTimesfmCache(cache, [1000, 1001, 99999]);
  assert.equal(partial.ok, false);
  assert.ok(partial.reasons.some(r => /cobertura de triggers/.test(r)));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── readTriggerTs ──
const tdir = mkdtempSync(path.join(tmpdir(), 'tfm-trig-'));
try {
  const tp = path.join(tdir, 'triggers.jsonl');
  writeFileSync(tp, '{"ts":1000}\n{"ts":2000}\n{"bad":1}\n');
  assert.deepEqual(readTriggerTs(tp), [1000, 2000]);
  assert.deepEqual(readTriggerTs(path.join(tdir, 'nope.jsonl')), []);
} finally { rmSync(tdir, { recursive: true, force: true }); }

console.log('PASS timesfm_ab: as-of, cobertura, lectura de triggers (hermético)');
