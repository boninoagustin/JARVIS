/** Pure presentation rules. None of these diagnostics authorizes a live mutation. */
export const MAX_REPORT_AGE_MS = 8 * 864e5;
export interface Metrics {
    expectancy?: number; profit_factor?: number; net_pnl_r?: number;
    max_drawdown_r?: number; win_rate?: number; trade_count?: number;
}
export interface MetricReport {
    proposal_validation?: Metrics; production_validation?: Metrics;
    proposal_oos?: Metrics; production_oos?: Metrics;
    evaluation_certificate?: { validation_role?: string };
    certificate?: { validation_role?: string };
}
export function isFreshReport(timestamp: unknown, now = Date.now()): boolean {
    const ts = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
    return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 && ts <= now && now - ts <= MAX_REPORT_AGE_MS;
}
export function reportScope(report: { ticker: string; timestamp: unknown }, activeTickers: readonly string[], now = Date.now()) {
    if (!activeTickers.includes(report.ticker)) return { current: false, label: 'HISTÓRICO · fuera de active_tickers (o lista no disponible)' };
    if (!isFreshReport(report.timestamp, now)) return { current: false, label: 'HISTÓRICO / VENCIDO · fecha inválida, futura o antigüedad > 8 días' };
    return { current: true, label: 'REPORTE VIGENTE · ≤ 8 días · universo de optimización (no roster operativo)' };
}
export function reportMetrics(report: MetricReport) {
    const selection = !!(report.proposal_validation || report.production_validation)
        || (report.evaluation_certificate ?? report.certificate)?.validation_role === 'selection_validation';
    // Never mix an explicitly named validation partition with a legacy metric alias.
    const explicit = !!(report.proposal_validation || report.production_validation);
    return {
        proposal: explicit ? report.proposal_validation : report.proposal_oos,
        production: explicit ? report.production_validation : report.production_oos,
        label: selection ? 'Validación de selección · NO es OOS independiente' : 'OOS legado · independencia no acreditada',
    };
}
export function metricDelta(proposal: unknown, production: unknown): number | undefined {
    return typeof proposal === 'number' && Number.isFinite(proposal)
        && typeof production === 'number' && Number.isFinite(production) ? proposal - production : undefined;
}
export function pnlChangeLabel(dropRatio: unknown): string {
    if (typeof dropRatio !== 'number' || !Number.isFinite(dropRatio)) return 'PnL: sin comparación válida';
    return dropRatio < 0 ? `PnL mejora: ${(Math.abs(dropRatio) * 100).toFixed(0)}% (vs |base|)`
        : dropRatio > 0 ? `PnL caída: ${(dropRatio * 100).toFixed(0)}% (vs |base|)` : 'PnL: sin cambio';
}
export function reportVerdict(status: string, current: boolean): string {
    const verdict = status === 'RECOMMEND' ? 'CANDIDATA DE INVESTIGACIÓN · no autoriza operar'
        : status === 'HOLD_MC' ? 'HOLD MC · revisar resultado / disponibilidad / error técnico'
        : status === 'HOLD' ? 'HOLD · sin propuesta de cambio' : status;
    return current ? verdict : `Histórico: ${verdict}`;
}
/** Plain-language "qué hacer" summary for the top of an asset card. */
export function reportSummary(status: string, current: boolean): { label: string; color: string } {
    if (!current) return { label: 'Histórico (fuera del universo o vencido): ignorar para decidir.', color: '#94a3b8' };
    switch (status) {
        case 'RECOMMEND': return { label: 'Hay una mejora con evidencia. Se aplica sola si pasa la certificación posterior; no tenés que hacer nada.', color: '#22c55e' };
        case 'HOLD': return { label: 'Sin mejora esta semana: se mantiene la configuración actual.', color: '#94a3b8' };
        case 'HOLD_MC': return { label: 'Resultado no concluyente (muestra o Monte Carlo): no implica apagar el activo.', color: '#eab308' };
        case 'ERROR': case 'HOLD_SELECTION_ERROR': case 'HOLD_INTEGRITY': case 'HOLD_ML_ERROR': return { label: 'No se pudo evaluar: se conserva la configuración anterior.', color: '#ef4444' };
        default: return { label: 'Sin conclusión clara.', color: '#94a3b8' };
    }
}
export function mlDiagnostic(ev?: { bestGate?: { umbral?: number; n?: number }; sinGate?: { n?: number } }): string {
    return `Diagnóstico solamente · umbral ensayado ${ev?.bestGate?.umbral ?? '—'} · n gate ${ev?.bestGate?.n ?? '—'} / sin gate ${ev?.sinGate?.n ?? '—'}. Activar un booleano no despliega ese umbral; equivalencia con runtime no acreditada.`;
}
/** Minimum closed/simulated sample before a filter toggle is allowed. Matches the exits n≥30 gate. */
export const MIN_FILTER_SAMPLE = 30;
/** Evidence gate for toggling a counterfactual filter: fresh eval + non-trivial sample. */
export function filterEvidence(ts: unknown, n: unknown, now = Date.now()) {
    const fresh = isFreshReport(ts, now);
    const count = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    const enough = count >= MIN_FILTER_SAMPLE;
    const reason = !fresh ? 'evaluación vencida o sin fecha'
        : !enough ? `muestra insuficiente (n=${count}/${MIN_FILTER_SAMPLE})` : null;
    return { fresh, enough, actionable: fresh && enough, n: count, reason };
}
/** Activating a filter is only offered when the counterfactual shows a POSITIVE
 * improvement (delta > 0); a negative/zero delta means "do not activate". */
export function activationRecommendation(ts: unknown, n: unknown, delta: unknown, now = Date.now()) {
    const ev = filterEvidence(ts, n, now);
    if (!ev.actionable) return { ...ev, recommend: false };
    const d = typeof delta === 'number' && Number.isFinite(delta) ? delta : 0;
    if (d <= 0) return { ...ev, recommend: false, reason: `no mejora (Δ ${d.toFixed(1)}) — no recomendado activar` };
    return { ...ev, recommend: true, reason: null };
}
