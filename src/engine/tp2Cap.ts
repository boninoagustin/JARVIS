// src/engine/tp2Cap.ts — Techo de TP2 (sep-2026)
// Decisión medida (A/B gestión 10 tickers, 8 meses): el TP2 fijo a 2-4R NO se alcanza
// (0% de 3.340 trades en backtest) y el trailing devuelve ganancias medianas. Un techo
// de 1.5R captura la ganancia antes de la reversión: +58.4R netos en el A/B, DD↓.
// Exentos: US500 y GER40 (perfiles de tendencia, el TP2 largo SÍ aporta ahí).
export const TP2_CAP_R = 1.5;
export const TP2_CAP_EXEMPT: string[] = ['US500', 'GER40'];

// 🆕 sep-2026 (idea de Bon): cap de TP2 por VOLATILIDAD del activo, además del cap en R.
// El cap en R solo no alcanza: con SL ancho (p.ej. 28 pips EURUSD), 1.5R = 42 pips — un TP
// inalcanzable (P(±35 pips en 3h) ≈ 10%). El TP2 queda limitado a TP2_CAP_ADR_MULT × ADR
// (rango diario promedio, medido de 194-208 días de M5 por activo). EURUSD: 0.5×47 = 23.5 pips.
// Exentos: US500/GER40 (A/B previo: el TP2 largo SÍ aporta en perfiles de tendencia).
// 🆕 30-sep-2026: tabla REGENERADA para TODO el universo con histórico (47 tickers,
// últimos 20 días de M5, scripts/calc_adr_table.ts). La tabla vieja (10 activos, sep)
// quedó obsoleta: GBPJPY 0.78→1.46, USDJPY 1.22→1.29, EURUSD 0.47→0.41.
export const TP2_CAP_ADR_MULT = 0.5;
const ADR_TABLE: Record<string, number> = {
    AUDCAD: 0.004592, AUDCHF: 0.003033, AUDJPY: 0.8502, AUDNZD: 0.006065,
    AUDUSD: 0.003902, AUSTRALIA200: 88.17, BTCUSD: 2108.3015, CADCHF: 0.002658,
    CADJPY: 0.86375, CHFJPY: 1.4051, EURAUD: 0.00599, EURCAD: 0.00508,
    EURCHF: 0.003965, EURGBP: 0.001958, EURNZD: 0.009825, EUROPE50: 70.295,
    EURUSD: 0.004074, FRA40: 88.735, GBPAUD: 0.007159, GBPCAD: 0.006496,
    GBPCHF: 0.004881, GBPJPY: 1.46305, GBPNZD: 0.01193, GBPUSD: 0.005441,
    GER40: 235.895, ITALY40: 656.55, JP225: 1297.2, NATGAS: 0.10315,
    NL25: 10.34, NZDCAD: 0.004325, NZDCHF: 0.0025, NZDJPY: 0.717,
    NZDUSD: 0.003777, SPAIN35: 236.295, UK100: 100.845, US30: 492.25,
    US500: 55.11, USDCAD: 0.004792, USDCHF: 0.004474, USDJPY: 1.29055,
    USOIL: 3.877, USTECH100: 369.105, XAGUSD: 2.0885, XAUUSD: 77.0895,
    XBRUSD: 3.74, XPDUSD: 42.1025, XPTUSD: 54.9535,
};

/** Recorta el TP2 a máx. min(TP2_CAP_R × riesgo, TP2_CAP_ADR_MULT × ADR del ticker).
 *  Devuelve el mismo tp2 si no aplica. Compartido vivo/backtest (paridad). */
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
    const adr = ADR_TABLE[(ticker || '').toUpperCase()];
    const dist = Math.abs(tp2 - entry);
    let maxDist = risk * TP2_CAP_R;
    if (Number.isFinite(adr) && adr > 0) {
        maxDist = Math.min(maxDist, adr * TP2_CAP_ADR_MULT);
    }
    if (dist <= maxDist) return tp2;
    const capped = direction === 'BUY' ? entry + maxDist : entry - maxDist;
    // 🛡️ 30-sep-2026: instrumentación del cap (verificar que muerde en vivo;
    // el proceso previo al deploy no lo estaba aplicando — evidencia USOIL 3.06R).
    console.log(`[TP2CAP] ${(ticker || '?').toUpperCase()} ${direction}: TP2 ${tp2} (${(dist / risk).toFixed(2)}R) recortado a ${Number(capped.toFixed(6))} (${(maxDist / risk).toFixed(2)}R). risk=${Number(risk.toFixed(6))} adr=${Number.isFinite(adr) ? adr : 'n/d'}`);
    return capped;
}
