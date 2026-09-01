// src/engine/tp2Cap.ts — Techo de TP2 (sep-2026)
// Decisión medida (A/B gestión 10 tickers, 8 meses): el TP2 fijo a 2-4R NO se alcanza
// (0% de 3.340 trades en backtest) y el trailing devuelve ganancias medianas. Un techo
// de 1.5R captura la ganancia antes de la reversión: +58.4R netos en el A/B, DD↓.
// Exentos: US500 y GER40 (perfiles de tendencia, el TP2 largo SÍ aporta ahí).
export const TP2_CAP_R = 1.5;
export const TP2_CAP_EXEMPT: string[] = ['US500', 'GER40'];

/** Recorta el TP2 a máx. TP2_CAP_R de riesgo si excede. Devuelve el mismo tp2 si no aplica. */
export function capTp2Price(
    ticker: string,
    direction: 'BUY' | 'SELL',
    entry: number,
    sl: number,
    tp2: number,
): number {
    if (TP2_CAP_EXEMPT.includes((ticker || '').toUpperCase())) return tp2;
    if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp2) || tp2 <= 0) return tp2;
    const risk = Math.abs(entry - sl);
    if (risk <= 0) return tp2;
    const dist = Math.abs(tp2 - entry);
    const maxDist = risk * TP2_CAP_R;
    if (dist <= maxDist) return tp2;
    return direction === 'BUY' ? entry + maxDist : entry - maxDist;
}
