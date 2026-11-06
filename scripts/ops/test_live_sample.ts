#!/usr/bin/env tsx
/**
 * H08 (auditoría 2026-11-05): muestra viva.
 * 5 filas VERIFIED live únicas + 5 backtesting + 3 duplicadas + 2 sin VERIFIED
 * → la muestra debe ser 5 y sumar sólo esas 5.
 *
 * Uso: npx tsx scripts/ops/test_live_sample.ts
 */
import assert from 'node:assert/strict';
import { buildLiveSample, describeLiveSample } from './live_sample_core.js';

const row = (id: string, extra: Record<string, any> = {}) => ({
    id,
    data: () => ({ ticker: 'EURUSD', result: 'WIN', rMultiple: 1, mode: 'live', riskAccountingStatus: 'VERIFIED', ctraderPositionId: id, ...extra }),
});

const rows = [
    row('p1', { rMultiple: 1.0 }),
    row('p2', { rMultiple: -1.0 }),
    row('p3', { rMultiple: 2.0 }),
    row('p4', { rMultiple: 0.5 }),
    row('p5', { rMultiple: -0.5 }),
    // backtesting
    row('b1', { mode: 'backtesting' }), row('b2', { mode: 'backtesting' }),
    row('b3', { isBacktest: true }), row('b4', { mode: 'backtesting' }), row('b5', { mode: 'backtesting' }),
    // duplicados de posiciones reales
    row('d1', { duplicateOf: 'x' }), row('d2', { duplicateOf: 'y' }), row('d3', { duplicateOf: 'z' }),
    // sin contabilidad verificada
    row('u1', { riskAccountingStatus: 'PENDING' }), row('u2', { riskAccountingStatus: undefined }),
];

console.log('=== H08: composición de la muestra viva ===');
const res = buildLiveSample(rows as any);
const eur = res.byTicker.get('EURUSD')!;
assert.equal(eur.n, 5, 'deben quedar 5 operaciones reales');
assert.equal(Number(eur.sumR.toFixed(2)), 2.0, 'suma de las 5: 1-1+2+0.5-0.5');
assert.equal(res.stats.backtest, 5);
assert.equal(res.stats.duplicate, 3);
assert.equal(res.stats.unverified, 2);
console.log('PASS ' + describeLiveSample(res));
console.log('PASS n=5 y sumR=2.0 (sólo las verificadas y únicas)');

// Dedupe por posición: misma posición con dos filas → 1
const dup = buildLiveSample([row('same', { rMultiple: 1 }), row('same', { rMultiple: 1 })] as any);
assert.equal(dup.byTicker.get('EURUSD')!.n, 1);
assert.equal(dup.stats.dupKey, 1);
console.log('PASS misma posición repetida → 1 (dedupe)');

// Backtest puro → muestra vacía
const bt = buildLiveSample([row('bb', { mode: 'backtesting' })] as any);
assert.equal(bt.byTicker.size, 0);
console.log('PASS sólo backtesting → muestra vacía');

console.log('\nAUTOTEST OK');
