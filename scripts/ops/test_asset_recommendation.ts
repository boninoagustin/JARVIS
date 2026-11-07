import assert from 'node:assert/strict';
import { assetRecommendation, type RecommendationInput } from '../../jarvis-os/src/services/assetRecommendation.js';
const now = Date.parse('2026-11-07T12:00:00Z');
const at = new Date(now - 3600_000).toISOString();
const base: RecommendationInput = { on: false, now, healthAt: at, roster: { verdict: 'TRADE', generatedAt: at, feasible: true, mu: 0.064, backtestTrades: 43 } };
let n = 0;
function check(label: string, input: RecommendationInput, action: string, text: string) {
  const result = assetRecommendation(input);
  assert.equal(result.action, action, label);
  assert.equal(result.label, text, label);
  n++; console.log('PASS', label);
}
check('TRADE apagado', base, 'activate', 'Activar recomendado');
check('TRADE encendido', { ...base, on: true }, 'keep', 'Mantener activo');
for (const verdict of ['WATCH', 'PARKED', 'OFF']) {
  check(verdict + ' apagado', { ...base, roster: { ...base.roster, verdict } }, 'stayOff', 'Mantener apagado');
  check(verdict + ' encendido', { ...base, on: true, roster: { ...base.roster, verdict } }, 'pause', 'Pausar nuevas entradas');
}
check('EUROPE50 positivo pero cluster lleno', { ...base, roster: { ...base.roster, verdict: 'WATCH', mu: 0.062, reason: 'buen edge pero cluster EU_INDICES lleno' } }, 'stayOff', 'Mantener apagado');
check('Sin roster', { ...base, roster: undefined }, 'review', 'Revisar antes de decidir');
check('Roster viejo', { ...base, roster: { ...base.roster, generatedAt: '2026-10-01T00:00:00Z' } }, 'review', 'Revisar antes de decidir');
check('Health viejo', { ...base, healthAt: '2026-10-01T00:00:00Z' }, 'review', 'Revisar antes de decidir');
check('Override en config', { ...base, operatorOverride: true }, 'review', 'Revisar antes de decidir');
check('Propuesta heredada de override', { ...base, roster: { ...base.roster, reason: 'override del operador' } }, 'review', 'Revisar antes de decidir');
check('TRADE sin muestra', { ...base, roster: { ...base.roster, backtestTrades: 10 } }, 'review', 'Revisar antes de decidir');
check('TRADE sin viabilidad', { ...base, roster: { ...base.roster, feasible: false } }, 'review', 'Revisar antes de decidir');
check('Riesgo NO_OPERAR contradictorio', { ...base, riskVerdict: 'NO_OPERAR' }, 'review', 'Revisar antes de decidir');
check('TRADE con edge insuficiente', { ...base, roster: { ...base.roster, mu: 0.014 } }, 'review', 'Revisar antes de decidir');
check('Fecha futura', { ...base, healthAt: '2027-01-01T00:00:00Z' }, 'review', 'Revisar antes de decidir');
assert.equal(assetRecommendation({ ...base, roster: { ...base.roster, verdict: 'WATCH', reason: 'cluster europeo completo' } }).reason, 'cluster europeo completo');
console.log(`AUTOTEST OK (${n} casos; sin Firestore, sin cambios de activos)`);
