/**
 * H12 (auditoría 2026-11-05): decisión de riesgo por activo (¼ Kelly, cap 3%).
 *
 * Bug: el mínimo viable se comparaba contra Kelly SIN CAP, no contra la propuesta final.
 * Caso: minFeasible=4%, Kelly=5% → 4 > 5 es falso → proponía 3% (capado), por debajo del
 * mínimo ejecutable. La propuesta era inaplicable.
 *
 * Regla: el mínimo se contrasta contra la PROPUESTA FINAL (ya capada).
 */
export type RiskVerdict = 'NO_OPERAR' | 'SIN_MUESTRA' | 'MANTENER' | 'SUBIR' | 'BAJAR';
export type RiskDecision = { proposal: number; verdict: RiskVerdict; note: string };

export function decideRiskProposal(p: {
    mu: number;
    n: number;
    kellyPct: number;
    current: number;
    minFeasible: number | null;
    maxPct: number;
    minPct: number;
    minTrades: number;
    muForIncrease: number;
}): RiskDecision {
    const kellyPct = Math.max(0, Number.isFinite(p.kellyPct) ? p.kellyPct : 0);
    const capped = Math.min(p.maxPct, Math.max(p.minPct, kellyPct));

    if (!Number.isFinite(p.mu) || p.mu <= 0 || p.n < p.minTrades) {
        const verdict: RiskVerdict = p.mu <= 0 ? 'NO_OPERAR' : 'SIN_MUESTRA';
        const note = p.mu <= 0 ? `edge negativo (${p.mu.toFixed(3)} R/tr)` : `n=${p.n} < ${p.minTrades}`;
        return { proposal: p.current, verdict, note };
    }

    // H12: contra la propuesta FINAL capada (antes: contra kellyPct sin cap).
    if (p.minFeasible !== null && p.minFeasible > capped) {
        const structural = p.minFeasible > 1 && p.minFeasible > 2 * capped;
        return {
            proposal: p.current,
            verdict: structural ? 'NO_OPERAR' : 'MANTENER',
            note: `lote mínimo exige ~${p.minFeasible.toFixed(2)}% > propuesta ${capped.toFixed(2)}%${structural ? '' : ' (marginal)'}`,
        };
    }

    if (p.mu < p.muForIncrease) {
        return { proposal: p.current, verdict: 'MANTENER', note: `edge fino (${p.mu.toFixed(3)} R/tr < ${p.muForIncrease})` };
    }

    const diff = capped - p.current;
    return {
        proposal: capped,
        verdict: Math.abs(diff) < 0.15 ? 'MANTENER' : diff > 0 ? 'SUBIR' : 'BAJAR',
        note: `Kelly/4 = ${kellyPct.toFixed(2)}%`,
    };
}
