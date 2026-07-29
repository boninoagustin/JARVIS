// src/engine/smc/modules/pivots.ts
import { OHLCV, Pivot } from '../types.js';

export class PivotEngine {
    private leftLen: number;
    private rightLen: number;
    private history: OHLCV[] = [];
    private currentIndex: number = 0;

    constructor(leftLen: number = 5, rightLen: number = 5) {
        this.leftLen = leftLen;
        this.rightLen = rightLen;
    }

    /**
     * Procesa la vela y devuelve un Pivot si se confirmó uno en el pasado,
     * dado que requiere `rightLen` velas de confirmación.
     */
    public nextCandle(candle: OHLCV): Pivot | null {
        this.history.push(candle);
        this.currentIndex++;

        // Necesitamos al menos leftLen + 1 + rightLen velas para evaluar el pivot del medio
        const requiredLength = this.leftLen + 1 + this.rightLen;
        if (this.history.length < requiredLength) {
            return null;
        }

        // Evaluar si la vela en (currentIndex - rightLen - 1) es un pivot
        const pivotCandleIndex = this.history.length - 1 - this.rightLen;
        const pivotCandle = this.history[pivotCandleIndex];
        
        let isHigh = true;
        let isLow = true;

        const startIndex = pivotCandleIndex - this.leftLen;
        const endIndex = pivotCandleIndex + this.rightLen;

        for (let i = startIndex; i <= endIndex; i++) {
            if (i === pivotCandleIndex) continue;
            const current = this.history[i];
            
            if (i < pivotCandleIndex) {
                // Left bars: current must be < pivot (so pivot is strictly > current)
                if (current.high >= pivotCandle.high) isHigh = false;
                if (current.low <= pivotCandle.low) isLow = false;
            } else {
                // Right bars: current must be < pivot (so pivot is strictly > current)
                if (current.high >= pivotCandle.high) isHigh = false;
                if (current.low <= pivotCandle.low) isLow = false;
            }
        }

        // Mantener el historial acotado a lo estrictamente necesario
        if (this.history.length > requiredLength * 2) {
            this.history.shift();
        }

        if (isHigh) {
            return {
                index: this.currentIndex - this.rightLen - 1,
                timestamp: pivotCandle.timestamp,
                price: pivotCandle.high,
                type: 'High',
                isBroken: false,
                bodyMin: Math.min(pivotCandle.open, pivotCandle.close),
                bodyMax: Math.max(pivotCandle.open, pivotCandle.close),
                high: pivotCandle.high,
                low: pivotCandle.low
            };
        }

        if (isLow) {
            return {
                index: this.currentIndex - this.rightLen - 1,
                timestamp: pivotCandle.timestamp,
                price: pivotCandle.low,
                type: 'Low',
                isBroken: false,
                bodyMin: Math.min(pivotCandle.open, pivotCandle.close),
                bodyMax: Math.max(pivotCandle.open, pivotCandle.close),
                high: pivotCandle.high,
                low: pivotCandle.low
            };
        }

        return null;
    }
}
