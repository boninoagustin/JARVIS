/** One operational recommendation. Detection diagnostics never activate/pause an asset. */
export interface RosterEvidence {
  verdict?: string;
  reason?: string;
  generatedAt?: string;
  feasible?: boolean;
  mu?: number;
  backtestTrades?: number;
}
export interface RecommendationInput {
  on: boolean;
  roster?: RosterEvidence;
  healthAt?: string;
  operatorOverride?: boolean;
  riskVerdict?: string;
  now?: number;
}
export interface AssetRecommendation {
  action: 'activate' | 'keep' | 'pause' | 'stayOff' | 'review';
  label: string;
  reason: string;
  color: string;
  rosterLabel: string;
}
const MAX_AGE = 8 * 864e5;
function fresh(iso: string | undefined, now: number): boolean {
  const ts = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ts) && ts <= now + 60_000 && now - ts <= MAX_AGE;
}
export function assetRecommendation(input: RecommendationInput): AssetRecommendation {
  const { on, roster, operatorOverride, riskVerdict } = input;
  const now = input.now ?? Date.now();
  const rosterLabel = roster?.verdict || 'SIN PROPUESTA';
  const review = (reason: string): AssetRecommendation => ({ action: 'review', label: 'Revisar antes de decidir', reason, color: '#eab308', rosterLabel });
  if (!roster || !['TRADE', 'WATCH', 'PARKED', 'OFF'].includes(rosterLabel)) return review('Falta una propuesta de roster válida. No hay recomendación de activar.');
  if (!fresh(roster.generatedAt, now) || !fresh(input.healthAt, now)) return review('Evaluación o roster sin fecha válida o con más de 8 días. Actualizá los datos antes de decidir.');
  if (operatorOverride || /override del operador/i.test(roster.reason || '')) return review('Excepción manual del operador: este TRADE no representa una selección automática.');
  if (rosterLabel === 'TRADE') {
    if (roster.feasible !== true || !Number.isFinite(roster.mu) || roster.mu! < 0.05 || !Number.isFinite(roster.backtestTrades) || roster.backtestTrades! < 30) return review('La propuesta TRADE no acredita ventaja, muestra y viabilidad suficientes. Recalculá el roster.');
    if (riskVerdict === 'NO_OPERAR') return review('Roster TRADE, pero la propuesta de riesgo indica NO_OPERAR. Revisá la viabilidad antes de activar.');
    return {
      action: on ? 'keep' : 'activate', label: on ? 'Mantener activo' : 'Activar recomendado',
      reason: 'Seleccionado por el roster: ventaja ≥ 0,05 R/tr, muestra ≥ 30, lote viable y cupo disponible.',
      color: '#22c55e', rosterLabel,
    };
  }
  const fallback = rosterLabel === 'WATCH' ? 'Seguir optimizando, sin recomendar nuevas entradas.' : rosterLabel === 'PARKED' ? 'En espera; seguimiento con health semanal.' : 'Fuera de la selección para operar.';
  return {
    action: on ? 'pause' : 'stayOff', label: on ? 'Pausar nuevas entradas' : 'Mantener apagado',
    reason: roster.reason || fallback, color: on ? '#eab308' : '#94a3b8', rosterLabel,
  };
}
