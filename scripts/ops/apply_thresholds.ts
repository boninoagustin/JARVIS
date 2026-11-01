#!/usr/bin/env tsx
/**
 * Umbral de mejora según tamaño de muestra — 02-nov-2026.
 *
 * Contexto: con 2-4 trades por activo/semana, la partición de validación tiene
 * mediana = 2 trades (26 de 28 activos con n < 30). Pedir +0.05 R/t con n=5 es
 * ruido: cualquier trial "gana" por azar. Pero pedir siempre +0.15 R/t bloquea
 * también los casos con muestra sana.
 *
 * Regla: la exigencia escala con la evidencia disponible.
 *   n >= 20  → +0.05 R/t (el umbral de siempre)
 *   n <  20  → +0.15 R/t (3× más exigente: compensa la falta de muestra)
 *
 * No reemplaza al Montecarlo ni al resto de los gates: se suma a ellos.
 * Autotest: npx tsx scripts/ops/apply_thresholds.ts --self-test
 */

export const MIN_TRADES_FOR_STANDARD_GAIN = 20;
export const STANDARD_GAIN_R = 0.05;
export const SMALL_SAMPLE_GAIN_R = 0.15;
export const DRAWDOWN_IMPROVEMENT = 0.15;
export const MAX_PNL_GIVEBACK = 0.15;

/** Delta mínimo de expectancy (R/trade) exigido para la muestra dada. */
export function requiredGainR(validationTrades: number): number {
  if (!Number.isInteger(validationTrades) || validationTrades <= 0) return SMALL_SAMPLE_GAIN_R;
  return validationTrades >= MIN_TRADES_FOR_STANDARD_GAIN ? STANDARD_GAIN_R : SMALL_SAMPLE_GAIN_R;
}

export interface GainEvidence {
  gain: number;        // Δ expectancy propuesta - producción (R/trade)
  drawdownGain: number; // (dd_prod - dd_prop) / max(dd_prod, 1)
  pnlGiveback: number;  // caída relativa de PnL
  validationTrades: number;
}

/**
 * Acepta la mejora si:
 *  a) el Δ de expectancy alcanza el umbral del tamaño de muestra, o
 *  b) mejora el drawdown ≥15% sacrificando ≤15% de PnL (camino alternativo de siempre).
 */
export function evaluateGain(ev: GainEvidence): { ok: boolean; need: number; reason: string } {
  const need = requiredGainR(ev.validationTrades);
  if (ev.gain >= need) {
    return { ok: true, need, reason: `Δ ${ev.gain.toFixed(3)} R/t ≥ ${need} (n=${ev.validationTrades})` };
  }
  if (ev.drawdownGain >= DRAWDOWN_IMPROVEMENT && ev.pnlGiveback <= MAX_PNL_GIVEBACK) {
    return { ok: true, need, reason: `drawdown -${(ev.drawdownGain * 100).toFixed(0)}% con PnL -${(ev.pnlGiveback * 100).toFixed(0)}%` };
  }
  return {
    ok: false, need,
    reason: `las métricas no confirman la mejora recomendada (Δ ${ev.gain.toFixed(3)} R/t < ${need} requerido con n=${ev.validationTrades})`,
  };
}

if (process.argv.includes('--self-test')) {
  const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('FALLA:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
  assert(requiredGainR(30) === STANDARD_GAIN_R, 'n=30 → 0.05');
  assert(requiredGainR(20) === STANDARD_GAIN_R, 'n=20 (borde) → 0.05');
  assert(requiredGainR(19) === SMALL_SAMPLE_GAIN_R, 'n=19 → 0.15');
  assert(requiredGainR(0) === SMALL_SAMPLE_GAIN_R, 'n=0 → 0.15');
  assert(requiredGainR(Number.NaN) === SMALL_SAMPLE_GAIN_R, 'n inválido → 0.15');
  // n=5 con +0.07: antes pasaba, ahora no (es ruido con 5 trades)
  assert(!evaluateGain({ gain: 0.07, drawdownGain: 0, pnlGiveback: 0, validationTrades: 5 }).ok, 'n=5 +0.07 R/t se rechaza');
  assert(evaluateGain({ gain: 0.20, drawdownGain: 0, pnlGiveback: 0, validationTrades: 5 }).ok, 'n=5 +0.20 R/t pasa');
  assert(evaluateGain({ gain: 0.07, drawdownGain: 0, pnlGiveback: 0, validationTrades: 30 }).ok, 'n=30 +0.07 R/t pasa');
  assert(evaluateGain({ gain: 0.01, drawdownGain: 0.20, pnlGiveback: 0.10, validationTrades: 8 }).ok, 'drawdown -20% con PnL -10% pasa (vía b)');
  assert(!evaluateGain({ gain: 0.01, drawdownGain: 0.20, pnlGiveback: 0.30, validationTrades: 8 }).ok, 'drawdown -20% con PnL -30% se rechaza');
  console.log(process.exitCode ? '\nAUTOTEST FALLÓ' : '\nAUTOTEST OK');
}
