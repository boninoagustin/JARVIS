#!/usr/bin/env tsx
/**
 * H04 (auditoría 2026-11-05): aplicación atómica del preset de detección.
 *   (a) preset modificado desde la evaluación → APPLY_ABORTED (CHANGED), sin escribir;
 *   (b) apply concurrente → LOCKED;
 *   (c) camino normal → rename atómico + backup versionado, sin .tmp residual;
 *   (d) lock huérfano viejo → se retira y aplica.
 *
 * Uso: npx tsx scripts/ops/test_detection_apply.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPresetAtomic, fileSha } from './preset_apply_core.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-preset-'));
const preset = path.join(dir, 'optimized_preset_EURUSD.json');
const lock = path.join(dir, 'apply.lock');
fs.writeFileSync(preset, JSON.stringify({ M15: { pivot_len: 3 }, Detection: { a: 1 } }, null, 2));

console.log('=== H04: CAS (preset cambió desde la evaluación) ===');
const shaAtStart = fileSha(preset);
fs.writeFileSync(preset, JSON.stringify({ M15: { pivot_len: 99 } }, null, 2));   // alguien lo cambió
const before = fs.readFileSync(preset, 'utf8');
const r1 = applyPresetAtomic({ presetPath: preset, lockPath: lock, expectedSha: shaAtStart, build: (c) => ({ ...c, Detection: { a: 2 } }) });
assert.equal(r1.ok, false);
if (!r1.ok) assert.equal(r1.code, 'CHANGED');
assert.equal(fs.readFileSync(preset, 'utf8'), before, 'no debe escribir tras CHANGED');
console.log('PASS preset cambiado → CHANGED y sin escritura');

console.log('\n=== H04: lock concurrente ===');
const shaNow = fileSha(preset);
fs.writeFileSync(lock, '99999');   // otro proceso tiene el lock
const r2 = applyPresetAtomic({ presetPath: preset, lockPath: lock, expectedSha: shaNow, build: (c) => ({ ...c, Detection: { a: 3 } }) });
assert.equal(r2.ok, false);
if (!r2.ok) assert.equal(r2.code, 'LOCKED');
console.log('PASS lock ocupado → LOCKED');
fs.unlinkSync(lock);

console.log('\n=== H04: camino normal (atómico + backup versionado) ===');
const r3 = applyPresetAtomic({ presetPath: preset, lockPath: lock, expectedSha: shaNow, build: (c) => ({ ...c, Detection: { a: 3 } }) });
assert.equal(r3.ok, true, 'el camino normal debe aplicar');
if (r3.ok) {
    assert.ok(r3.backup && fs.existsSync(r3.backup), 'backup versionado debe existir');
    assert.match(path.basename(r3.backup!), /^optimized_preset_EURUSD\.json\.bak-\d+$/);
}
assert.equal(JSON.parse(fs.readFileSync(preset, 'utf8')).Detection.a, 3);
assert.equal(fs.existsSync(`${preset}.tmp`), false, 'sin .tmp residual');
assert.equal(fs.existsSync(lock), false, 'el lock se libera');
console.log('PASS aplicado por rename + backup .bak-<ts> + lock liberado');

console.log('\n=== H04: lock huérfano viejo ===');
const shaFinal = fileSha(preset);
fs.writeFileSync(lock, '123');
const old = Date.now() - 3 * 3600_000;
fs.utimesSync(lock, old / 1000, old / 1000);   // mtime 3 h atrás
const r4 = applyPresetAtomic({ presetPath: preset, lockPath: lock, expectedSha: shaFinal, build: (c) => ({ ...c, Detection: { a: 4 } }) });
assert.equal(r4.ok, true, 'un lock >2h es huérfano y debe retirarse');
console.log('PASS lock huérfano (>2h) retirado y aplicado');


console.log('\n=== H04: preset NUEVO (no existía al evaluar) ===');
const nuevo = path.join(dir, 'optimized_preset_NUEVO.json');
const lock2 = path.join(dir, 'apply2.lock');
// no existe al capturar el sha; expectedSha = '' significa "no existía"
const r5 = applyPresetAtomic({ presetPath: nuevo, lockPath: lock2, expectedSha: '', build: (c) => ({ ...c, Detection: { a: 1 } }) });
assert.equal(r5.ok, true, 'sin preset previo y sin cambios → debe crear');
assert.equal(fs.existsSync(nuevo), true);
console.log('PASS preset ausente + expectedSha="" → crea');

// alguien lo crea durante la búsqueda → CAS debe abortar
const nuevo2 = path.join(dir, 'optimized_preset_NUEVO2.json');
fs.writeFileSync(nuevo2, JSON.stringify({ Detection: { a: 99 } }));
const r6 = applyPresetAtomic({ presetPath: nuevo2, lockPath: lock2, expectedSha: '', build: (c) => ({ ...c, Detection: { a: 1 } }) });
assert.equal(r6.ok, false);
if (!r6.ok) assert.equal(r6.code, 'CHANGED');
assert.equal(JSON.parse(fs.readFileSync(nuevo2, 'utf8')).Detection.a, 99, 'no debe pisar');
console.log('PASS preset creado durante la evaluación → CHANGED (no pisa)');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\nAUTOTEST OK');
