import { OHLCV } from '../types.js';

/**
 * Calcula el Z-Score de una serie de valores basado en la varianza ponderada 
 * por volumen, usando el algoritmo incremental de Welford (numéricamente estable).
 *
 * Fórmula: Z = (TP - VWAP) / σ
 *   TP  = (High + Low + Close) / 3
 *   VWAP = media ponderada por volumen (acumulativa desde el anclaje)
 *   σ   = desviación estándar ponderada por volumen
 *
 * Welford ponderado:
 *   n     += v
 *   delta  = tp - mean_prev
 *   mean  += v * delta / n
 *   M2    += v * delta * (tp - mean)   // usando mean actualizado
 *   σ      = sqrt(M2 / n)
 *
 * Ventajas sobre la fórmula ingenua Σv·tp²/Σv − VWAP²:
 *   - Sin cancelación catastrófica (los términos son diferencias, no cuadrados brutos).
 *   - Cada barra se mide contra UN único VWAP (el del paso anterior), no contra 
 *     el running VWAP de ese instante (que era el bug de la implementación previa).
 *   - Sin riesgo de overflow con float64 porque M2 escala como O(n) no O(n·price²).
 */
export class ZScoreCalculator {
    private n: number = 0;      // peso acumulado (Σv, "effective sample count")
    private mean: number = 0;   // VWAP actual (media ponderada)
    private M2: number = 0;     // suma ponderada de desviaciones cuadráticas

    // Último valor calculado (para devolver en velas no finitas)
    private lastZ: { zScore: number; vwap: number; sigma: number } | null = null;

    constructor() {}

    public nextValue(candle: OHLCV): { zScore: number; vwap: number; sigma: number } | null {
        if (!Number.isFinite(candle.open) || !Number.isFinite(candle.close)) {
            return this.lastZ;
        }

        const tp = (candle.high + candle.low + candle.close) / 3;
        const v = (candle.volume && candle.volume > 0) ? candle.volume : 1;

        // Welford incremental ponderado por volumen
        this.n += v;
        if (this.n === 0) return this.lastZ;

        const delta = tp - this.mean;
        this.mean += (v * delta) / this.n;
        // M2 usa el mean ACTUALIZADO (post-incremento) — así cada término
        // mide la desviación contra el VWAP del paso actual, no contra uno futuro
        this.M2 += v * delta * (tp - this.mean);

        const sigma = Math.sqrt(this.M2 / this.n);
        const zScore = sigma === 0 ? 0 : (tp - this.mean) / sigma;

        this.lastZ = { zScore, vwap: this.mean, sigma };
        return this.lastZ;
    }

    /** Reinicia los acumuladores — anclaje estructural del Z-Score. */
    public reset(): void {
        this.n = 0;
        this.mean = 0;
        this.M2 = 0;
        this.lastZ = null;
    }

    /** Muestras efectivas (Σv) desde el último anclaje. */
    public get sampleCount(): number {
        return this.n;
    }
}
