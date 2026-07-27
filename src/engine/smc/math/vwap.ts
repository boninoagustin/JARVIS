// src/engine/smc/math/vwap.ts
import { OHLCV } from '../types.js';

export class VWAPCalculator {
    private cumulativePriceVolume: number = 0;
    private cumulativeVolume: number = 0;

    /**
     * Añade una nueva vela y retorna el VWAP actual.
     */
    public nextValue(candle: OHLCV): number {
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        this.cumulativePriceVolume += typicalPrice * candle.volume;
        this.cumulativeVolume += candle.volume;

        if (this.cumulativeVolume === 0) return typicalPrice;
        return this.cumulativePriceVolume / this.cumulativeVolume;
    }

    /**
     * Resetea el VWAP (útil para anclar a sesiones diarias, semanales, o eventos de estructura como BOS/CHoCH).
     */
    public reset(): void {
        this.cumulativePriceVolume = 0;
        this.cumulativeVolume = 0;
    }
}
