/**
 * Lógica PURA de caps de exposición y clasificación de rechazos (H01-b / H02-b).
 *
 * Vive en su propio módulo, SIN efectos secundarios, para poder testearla sin arrancar el
 * bot (importar db/trading.ts inicia listeners/timers). `db/trading.ts` re-exporta estas
 * funciones para compatibilidad.
 */

export type RiskEntry = { requestedRiskPercent?: unknown; ctraderPositionId?: unknown; ticker?: unknown };

/** Cluster de correlación por activo (los checks específicos van primero). */
export function riskClusterOf(ticker: string): string {
    const t = String(ticker || '').toUpperCase();
    if (/^(XAU|XAG|XPT|XPD)/.test(t)) return 'METALS';
    if (/^(XTI|XBR|USOIL|NATGAS|NGAS)/.test(t)) return 'ENERGY';
    if (/^(BTC|ETH)/.test(t)) return 'CRYPTO';
    if (/^(US500|US30|USTECH100|US100|NAS100)/.test(t)) return 'US_INDICES';
    if (/^(JP225|JAPAN225)/.test(t)) return 'ASIA_INDICES';
    if (/^(GER40|FRA40|NL25|EUROPE50|UK100|ITALY40|SPAIN35|AUSTRALIA200)/.test(t)) return 'EU_INDICES';
    if (/^[A-Z]{6}$/.test(t)) return t.includes('USD') ? 'FX_USD' : 'FX_CROSS';
    return 'OTHER';
}

/** Topes por cluster (% del equity). El tope total vive en CTRADER_MAX_AGGREGATE_RISK_PCT. */
export const CLUSTER_RISK_CAPS: Record<string, number> = {
    FX_USD: 6, FX_CROSS: 4, METALS: 4, ENERGY: 3, CRYPTO: 2,
    US_INDICES: 4, EU_INDICES: 4, ASIA_INDICES: 4, OTHER: 2,
};

/**
 * Exposición abierta = reserva en RAM (requestedRiskPercent) o, si el trade tiene posición
 * y no guardó su riesgo (adoptado/legacy), el riesgo configurado del activo vía fallback.
 * Un CANDIDATO (sin reserva ni posición) no es exposición: señales ignoradas/expiradas no
 * deben consumir presupuesto.
 */
export function computeOpenRisk(
    entries: Iterable<[string, RiskEntry]>,
    fallbackRiskFor: (ticker: string) => number,
    excludeTradeId?: string,
): { total: number; byCluster: Record<string, number>; counted: number } {
    let total = 0;
    let counted = 0;
    const byCluster: Record<string, number> = {};
    for (const [tid, tr] of entries) {
        if (tid === excludeTradeId) continue;
        const stored = Number(tr?.requestedRiskPercent);
        const hasPosition = tr?.ctraderPositionId != null;
        if (!(Number.isFinite(stored) && stored > 0) && !hasPosition) continue;
        const tTicker = String(tr?.ticker ?? '');
        const eff = Number.isFinite(stored) && stored > 0 ? stored : fallbackRiskFor(tTicker);
        total += eff;
        counted += 1;
        const c = riskClusterOf(tTicker);
        byCluster[c] = (byCluster[c] ?? 0) + eff;
    }
    return { total, byCluster, counted };
}

/**
 * Rechazo terminal SIN fill: sólo con evidencia estructurada (volumen ejecutado 0) y sin
 * incertidumbre. El texto del error no clasifica nada.
 */
export function isTerminalNoFill(result: any): boolean {
    return !!result && !result.success && result.executionUncertain !== true && Number(result.filledVolumeCents) === 0;
}
