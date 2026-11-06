/**
 * H09 (auditoría 2026-11-05): rachas de semanas NEGATIVAS del shutdown.
 *
 * Antes se contaban registros negativos consecutivos en la lista ordenada, sin exigir que
 * las semanas fueran contiguas en el calendario: cuatro observaciones separadas por huecos
 * contaban como cuatro seguidas. Además el dry-run no leía el historial (siempre 0).
 *
 * Regla: semanas ISO (YYYY-MM-DD) contiguas = 7 días exactos por paso.
 */
export type WeekRow = { week: string; baselineR: number };

export function mergeWeek(history: WeekRow[], week: string, baselineR: number, keep = 52): WeekRow[] {
    const next = Array.isArray(history) ? history.map((h) => ({ ...h })) : [];
    const i = next.findIndex((h) => h.week === week);
    if (i >= 0) next[i].baselineR = Number(baselineR.toFixed(2));
    else next.push({ week, baselineR: Number(baselineR.toFixed(2)) });
    return next
        .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(String(h.week)))
        .sort((a, b) => (a.week < b.week ? -1 : 1))
        .slice(-keep);
}

export function countConsecutiveNegativeWeeks(history: WeekRow[]): number {
    const sorted = (Array.isArray(history) ? history : [])
        .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(String(h.week)) && Number.isFinite(Number(h.baselineR)))
        .sort((a, b) => (a.week < b.week ? 1 : -1));   // más reciente primero
    let n = 0;
    let prevTs: number | null = null;
    for (const h of sorted) {
        if (!(Number(h.baselineR) < 0)) break;          // la racha se corta con una semana >= 0
        const ts = Date.parse(h.week);
        if (!Number.isFinite(ts)) break;
        if (prevTs !== null) {
            const gapDays = (prevTs - ts) / 86400000;
            if (Math.round(gapDays) !== 7) break;       // hueco en el calendario → no contigua
        }
        n++;
        prevTs = ts;
    }
    return n;
}
