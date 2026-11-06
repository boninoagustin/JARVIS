/**
 * H08 (auditoría 2026-11-05): muestra "viva" para roster/shutdown.
 *
 * Antes contaba cualquier fila con `result` WIN/LOSS/BREAKEVEN y R finito: incluía
 * backtests, duplicados de la misma posición y filas sin contabilidad verificada. Un
 * `n≥20 vivo` podía no representar veinte operaciones reales independientes.
 *
 * Reglas:
 *  - fuera backtesting (`mode==='backtesting'` o `isBacktest`);
 *  - fuera duplicados (`duplicateOf`);
 *  - fuera lo que no está cerrado (WIN/LOSS/BREAKEVEN);
 *  - fuera contabilidad no VERIFIED (sin dato ≠ verificado);
 *  - fuera R no finito;
 *  - dedupe por posición/trade/journal (una fila por operación real).
 *
 * Puro: no toca Firestore. Devuelve la composición para poder auditarla en los logs.
 */
export type LiveSample = { n: number; sumR: number };
export type LiveSampleRow = { id?: string; data?: () => any } | Record<string, any>;

export type LiveSampleResult = {
    byTicker: Map<string, LiveSample>;
    stats: {
        total: number; backtest: number; duplicate: number; notClosed: number;
        unverified: number; invalidR: number; dupKey: number; used: number;
    };
};

export function buildLiveSample(rows: LiveSampleRow[]): LiveSampleResult {
    const byTicker = new Map<string, LiveSample>();
    const stats = { total: 0, backtest: 0, duplicate: 0, notClosed: 0, unverified: 0, invalidR: 0, dupKey: 0, used: 0 };
    const seen = new Set<string>();

    for (const raw of rows) {
        stats.total++;
        const t: any = typeof (raw as any)?.data === 'function' ? (raw as any).data() : raw;
        if (!t) { stats.unverified++; continue; }
        if (t.mode === 'backtesting' || t.isBacktest === true) { stats.backtest++; continue; }
        if (t.duplicateOf) { stats.duplicate++; continue; }
        if (!['WIN', 'LOSS', 'BREAKEVEN'].includes(String(t.result))) { stats.notClosed++; continue; }
        if (t.riskAccountingStatus !== 'VERIFIED') { stats.unverified++; continue; }
        const r = Number(t.rMultiple);
        if (!Number.isFinite(r)) { stats.invalidR++; continue; }

        const docId = (raw as any)?.id;
        const key = t.ctraderPositionId != null ? `pos:${t.ctraderPositionId}`
            : (t.tradeId ? `trade:${t.tradeId}` : (docId ? `doc:${docId}` : `journal:${t.journalId ?? JSON.stringify([t.ticker, t.timestamp, t.session])}`));
        if (seen.has(key)) { stats.dupKey++; continue; }
        seen.add(key);

        const cur = byTicker.get(t.ticker) ?? { n: 0, sumR: 0 };
        cur.n += 1;
        cur.sumR += r;
        byTicker.set(t.ticker, cur);
        stats.used++;
    }
    return { byTicker, stats };
}

/** Resumen compacto para el log de composición (auditable). */
export function describeLiveSample(s: LiveSampleResult): string {
    return `live ${s.stats.used}/${s.stats.total} (bt=${s.stats.backtest} dup=${s.stats.duplicate} ` +
        `dupKey=${s.stats.dupKey} abierto=${s.stats.notClosed} sinVerif=${s.stats.unverified} rInvalido=${s.stats.invalidR})`;
}
