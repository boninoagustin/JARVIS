import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isolateTimesfm, evaluateTimesfmAB, TIMESFM_MIN_SAMPLE } from './timesfm_sweep.js';

// ── isolateTimesfm: ML apagado, correlación observando, sin mutar el original ──
const src = { ticker: 'GER40', enabled: true, mlGateEnabled: true, mlGate: { enabled: true }, correlationFilter: { shadow: false }, timesfm: { enabled: true } };
const iso = isolateTimesfm(src);
assert.equal(iso.mlGateEnabled, false);
assert.equal(iso.mlGate.enabled, false);
assert.equal(iso.correlationFilter.shadow, true);
assert.equal(iso.timesfm.enabled, false, 'TimesFM se controla por trial');
assert.equal(src.mlGateEnabled, true, 'no muta el original');
assert.equal(src.correlationFilter.shadow, false);
assert.equal(src.timesfm.enabled, true, 'no muta el timesfm original');
assert.equal(iso.enabled, true, 'parámetros de trading conservados');

// ── evaluateTimesfmAB: fail-closed sin llamar al replay ──
const dir = mkdtempSync(path.join(tmpdir(), 'tfm-sweep-'));
const mkFc = (ts: number) => JSON.stringify({ ts, horizon: 12, q10: [1], q50: [1], q90: [1], availableAt: ts }) + '\n';
try {
  const cache = path.join(dir, 'forecasts.jsonl');
  const triggers: number[] = [];

  // sin caché (as-of no verificable) → insufficient
  let r = evaluateTimesfmAB({ ticker: 'GER40', asset: { ticker: 'GER40' }, entries: [], logs: new Map(), cachePath: cache, triggerTsList: triggers, now: Date.now() });
  assert.equal(r.status, 'insufficient');
  assert.ok(r.reasons!.some(x => /as-of|cobertura/.test(x)));

  // forecasts sin availableAt → insufficient (as-of)
  writeFileSync(cache, JSON.stringify({ ts: 1000, horizon: 12, q10: [1], q50: [1], q90: [1] }) + '\n');
  r = evaluateTimesfmAB({ ticker: 'GER40', asset: { ticker: 'GER40' }, entries: [], logs: new Map(), cachePath: cache, triggerTsList: [1000], now: Date.now() });
  assert.equal(r.status, 'insufficient');
  assert.ok(r.reasons!.some(x => /as-of no verificable/.test(x)));

  // forecasts as-of pero pocos (< MIN) → insufficient
  const lines: string[] = [];
  for (let i = 0; i < TIMESFM_MIN_SAMPLE - 1; i++) lines.push(mkFc(1000 + i * 100));
  writeFileSync(cache, lines.join(''));
  const fewTriggers = lines.map((_, i) => 1000 + i * 100);
  r = evaluateTimesfmAB({ ticker: 'GER40', asset: { ticker: 'GER40' }, entries: [], logs: new Map(), cachePath: cache, triggerTsList: fewTriggers, now: Date.now() });
  assert.equal(r.status, 'insufficient');
  assert.ok(r.reasons!.some(x => /cobertura insuficiente|insuficientes/.test(x)));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('PASS timesfm_sweep: aislamiento TimesFM + fail-closed as-of/muestra (hermético)');
