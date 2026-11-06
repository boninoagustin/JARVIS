#!/usr/bin/env tsx
/**
 * H12 (auditoría 2026-11-05): el mínimo viable se contrasta contra la PROPUESTA FINAL
 * capada, no contra Kelly sin cap.
 *
 * Caso del hallazgo: Kelly=5%, mínimo viable=4%, cap=3% → NO debe proponer 3%.
 *
 * Uso: npx tsx scripts/ops/test_risk_allocator.ts
 */
import assert from 'node:assert/strict';
import { decideRiskProposal } from './risk_allocator_core.js';

const base = { maxPct: 3, minPct: 0.5, minTrades: 30, muForIncrease: 0.05 };

console.log('=== H12: mínimo viable vs propuesta capada ===');

// Caso exacto del hallazgo: Kelly 5% (capado a 3), mínimo 4% → no puede proponer 3%.
const r1 = decideRiskProposal({ ...base, mu: 0.09, n: 60, kellyPct: 5, current: 1, minFeasible: 4 });
assert.equal(r1.proposal, 1, 'no debe proponer 3% (bajo el mínimo de 4%)');
assert.equal(r1.verdict, 'MANTENER');
console.log('PASS mínimo 4% vs Kelly 5% (cap 3) → mantiene actual, no 3%');

// Estructural: el mínimo supera el doble de la propuesta → NO_OPERAR.
const r2 = decideRiskProposal({ ...base, mu: 0.09, n: 60, kellyPct: 5, current: 1, minFeasible: 10 });
assert.equal(r2.verdict, 'NO_OPERAR');
console.log('PASS mínimo 10% (>> propuesta) → NO_OPERAR');

// Camino normal: subir.
const r3 = decideRiskProposal({ ...base, mu: 0.1, n: 60, kellyPct: 2, current: 1, minFeasible: 0.5 });
assert.equal(r3.proposal, 2);
assert.equal(r3.verdict, 'SUBIR');
console.log('PASS Kelly 2% sin conflicto → SUBIR a 2%');

// Camino normal: bajar.
const r4 = decideRiskProposal({ ...base, mu: 0.1, n: 60, kellyPct: 0.5, current: 2, minFeasible: 0.5 });
assert.equal(r4.proposal, 0.5);
assert.equal(r4.verdict, 'BAJAR');
console.log('PASS Kelly 0.5% → BAJAR a 0.5%');

// Edge negativo.
const r5 = decideRiskProposal({ ...base, mu: -0.02, n: 60, kellyPct: 2, current: 1, minFeasible: 0.5 });
assert.equal(r5.verdict, 'NO_OPERAR');
console.log('PASS mu <= 0 → NO_OPERAR');

// Muestra insuficiente.
const r6 = decideRiskProposal({ ...base, mu: 0.2, n: 10, kellyPct: 2, current: 1, minFeasible: 0.5 });
assert.equal(r6.verdict, 'SIN_MUESTRA');
assert.equal(r6.proposal, 1);
console.log('PASS n < 30 → SIN_MUESTRA (mantiene actual)');

// Edge fino.
const r7 = decideRiskProposal({ ...base, mu: 0.02, n: 60, kellyPct: 2, current: 1, minFeasible: 0.5 });
assert.equal(r7.verdict, 'MANTENER');
console.log('PASS mu < 0.05 → MANTENER');

// Mínimo marginal (0.8 vs propuesta 1) → no bloquea.
const r8 = decideRiskProposal({ ...base, mu: 0.09, n: 60, kellyPct: 2, current: 1, minFeasible: 0.8 });
assert.equal(r8.verdict, 'SUBIR');
console.log('PASS mínimo 0.8% < propuesta 2% → no bloquea');

console.log('\nAUTOTEST OK');
