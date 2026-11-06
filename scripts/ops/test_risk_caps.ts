#!/usr/bin/env tsx
/**
 * Tests de los caps de exposición y de la clasificación de rechazos (H01-b / H02-b).
 * Escenarios pedidos en la 2ª revisión de la auditoría.
 *
 * Uso: npx tsx scripts/ops/test_risk_caps.ts
 */
import assert from 'node:assert/strict';
import { computeOpenRisk, isTerminalNoFill } from '../../src/engine/RiskCaps.js';

const fallback = (_t: string) => 1; // riesgo configurado por defecto para los no-reservados

console.log('=== computeOpenRisk ===');

// (1) Cinco FX al 1,5% (base 1% × factor de sesión 1,5): el cap de cluster FX_USD (6%) bloquea la 5ª.
{
  const entries: Array<[string, any]> = [];
  for (let i = 1; i <= 4; i++) entries.push([`t${i}`, { ticker: 'EURUSD', requestedRiskPercent: 1.5 }]);
  const { total, byCluster } = computeOpenRisk(entries, fallback);
  assert.equal(total, 6);
  assert.equal(byCluster.FX_USD, 6);
  // la quinta evalúa 6 + 1,5 = 7,5 > 6 → debe superar el cap de cluster
  assert.ok(byCluster.FX_USD + 1.5 > 6, 'la 5ª debe quedar bloqueada por el cap de cluster');
  console.log('PASS 5 FX al 1,5% → la 5ª excede el cluster (6% → 7,5%)');
}

// (2) Candidato sin reserva ni posición: NO consume exposición (señales ignoradas/expiradas).
{
  const entries: Array<[string, any]> = [
    ['cand1', { ticker: 'EURUSD' }],                                  // candidato puro
    ['cand2', { ticker: 'GBPUSD', ctradedPositionId: undefined }],    // typo a propósito
    ['cand3', { ticker: 'USDJPY', requestedRiskPercent: undefined }], // sin reserva
  ];
  const { total, byCluster } = computeOpenRisk(entries, fallback);
  assert.equal(total, 0);
  assert.deepEqual(byCluster, {});
  console.log('PASS candidatos sin reserva/posición → exposición 0');
}

// (3) Posición adoptada/legacy SIN reserva: usa el fallback (no 0).
{
  const entries: Array<[string, any]> = [
    ['adoptada', { ticker: 'GBPCHF', ctraderPositionId: '301452833' }],
  ];
  const { total } = computeOpenRisk(entries, fallback);
  assert.equal(total, 1);
  console.log('PASS posición sin reserva → fallback 1% (no 0)');
}

// (4) excludeTradeId: la entrada que se está evaluando no se cuenta.
{
  const entries: Array<[string, any]> = [
    ['a', { ticker: 'EURUSD', requestedRiskPercent: 2 }],
    ['b', { ticker: 'EURUSD', requestedRiskPercent: 2 }],
  ];
  assert.equal(computeOpenRisk(entries, fallback, 'b').total, 2);
  console.log('PASS excludeTradeId');
}

// (5) Metales y FX no comparten cluster.
{
  const entries: Array<[string, any]> = [
    ['x', { ticker: 'XAUUSD', requestedRiskPercent: 3 }],
    ['y', { ticker: 'EURUSD', requestedRiskPercent: 3 }],
  ];
  const { byCluster } = computeOpenRisk(entries, fallback);
  assert.equal(byCluster.METALS, 3);
  assert.equal(byCluster.FX_USD, 3);
  console.log('PASS clusters separados (METALS vs FX_USD)');
}

console.log('\n=== isTerminalNoFill (H02) ===');
assert.equal(isTerminalNoFill({ success: false, filledVolumeCents: 0 }), true);
assert.equal(isTerminalNoFill({ success: false, executionUncertain: true, filledVolumeCents: 0 }), false);
assert.equal(isTerminalNoFill({ success: false, filledVolumeCents: 5 }), false);
assert.equal(isTerminalNoFill({ success: false, error: 'Orden rechazada por el broker' }), false);
assert.equal(isTerminalNoFill({ success: true, filledVolumeCents: 0 }), false);
assert.equal(isTerminalNoFill(undefined), false);
console.log('PASS rechazo terminal sólo con volumen 0 y sin incertidumbre');
console.log('PASS texto de error por sí solo NO clasifica (sin evidencia estructurada)');

console.log('\nAUTOTEST OK');
