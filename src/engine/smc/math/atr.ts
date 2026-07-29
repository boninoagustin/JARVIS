// src/engine/smc/math/atr.ts
import { OHLCV } from '../types.js';

/**
 * Calcula el True Range de la vela actual respecto a la anterior.
 */
export function calculateTR(current: OHLCV, previous?: OHLCV): number {
    const hl = current.high - current.low;
    if (!previous) return hl;
    const hc = Math.abs(current.high - previous.close);
    const lc = Math.abs(current.low - previous.close);
    return Math.max(hl, hc, lc);
}

/**
 * Calcula el Average True Range (ATR) usando RMA (Running Moving Average),
 * tal como lo hace TradingView (PineScript ta.atr).
 */
export class ATRCalculator {
    private length: number;
    private rma: number | null = null;
    private history: number[] = [];

    constructor(length: number = 14) {
        this.length = length;
    }

    /**
     * Agrega una nueva vela y retorna el ATR actualizado.
     */
    public nextValue(current: OHLCV, previous?: OHLCV): number | null {
        // E4: ignorar velas no finitas sin corromper el RMA de Wilder
        if (!Number.isFinite(current.high) || !Number.isFinite(current.low) || !Number.isFinite(current.close)) {
            return this.rma;
        }
        const prev = previous && Number.isFinite(previous.close) ? previous : undefined;
        const tr = calculateTR(current, prev);
        
        if (this.rma === null) {
            this.history.push(tr);
            if (this.history.length === this.length) {
                // El primer valor de RMA es el SMA (Promedio Simple)
                const sum = this.history.reduce((a, b) => a + b, 0);
                this.rma = sum / this.length;
                return this.rma;
            }
            return null; // Aún no hay suficientes datos
        }

        // Fórmula RMA de TradingView: rma = (tr + (length - 1) * rma_prev) / length
        // que equivale a: rma_prev + (tr - rma_prev) / length
        this.rma = (tr + (this.length - 1) * this.rma) / this.length;
        return this.rma;
    }
}
