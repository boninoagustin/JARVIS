#!/usr/bin/env tsx
/**
 * H09 (auditoría 2026-11-05): rachas de semanas negativas del shutdown.
 *   (a) 4 negativas contiguas → 4
 *   (b) 4 negativas con un hueco → se corta en el hueco
 *   (c) semana actual ≥ 0 → 0
 *   (d) entrada desordenada → se ordena
 *   (e) mergeWeek reemplaza la semana existente y acota el historial
 *
 * Uso: npx tsx scripts/ops/test_shutdown_weeks.ts
 */
import assert from 'node:assert/strict';
import { countConsecutiveNegativeWeeks, mergeWeek } from './shutdown_weeks_core.js';

const w = (week: string, r: number) => ({ week, baselineR: r });

console.log('=== H09: contigüidad de semanas ===');

// (a) 4 contiguas (semanas ISO de lunes)
assert.equal(countConsecutiveNegativeWeeks([
    w('2026-10-26', -1), w('2026-10-19', -2), w('2026-10-12', -1), w('2026-10-05', -3),
]), 4);
console.log('PASS 4 semanas contiguas negativas → 4');

// (b) con un hueco (falta 2026-10-19)
assert.equal(countConsecutiveNegativeWeeks([
    w('2026-10-26', -1), w('2026-10-12', -2), w('2026-10-05', -1), w('2026-09-28', -3),
]), 1);
console.log('PASS hueco de una semana → se corta (1, no 4)');

// (b2) dos contiguas + hueco + dos contiguas
assert.equal(countConsecutiveNegativeWeeks([
    w('2026-10-26', -1), w('2026-10-19', -2), w('2026-10-05', -1), w('2026-09-28', -3),
]), 2);
console.log('PASS racha de 2 + hueco → 2');

// (c) la más reciente ≥ 0 corta la racha
assert.equal(countConsecutiveNegativeWeeks([
    w('2026-11-02', 1.2), w('2026-10-26', -1), w('2026-10-19', -2),
]), 0);
console.log('PASS semana actual positiva → 0');

// (d) desordenada
assert.equal(countConsecutiveNegativeWeeks([
    w('2026-10-12', -1), w('2026-10-26', -1), w('2026-10-19', -2),
]), 3);
console.log('PASS entrada desordenada → 3');

// (e) mergeWeek
let h = mergeWeek([w('2026-10-19', -1), w('2026-10-12', -2)], '2026-10-19', -3.5);
assert.equal(h.length, 2);
assert.equal(h.find((x) => x.week === '2026-10-19')!.baselineR, -3.5);
console.log('PASS mergeWeek reemplaza la semana existente');
h = mergeWeek(h, '2026-10-26', -1);
assert.equal(h[h.length - 1].week, '2026-10-26');
console.log('PASS mergeWeek agrega la semana nueva ordenada');

console.log('\nAUTOTEST OK');
