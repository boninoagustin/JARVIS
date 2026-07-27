import { Pivot, Direction } from '../types.js';

export interface DivergenceEvent {
    direction: Direction;
    type: 'Regular' | 'Hidden';
    timestamp: number;
}

export class DivergenceEngine {
    private lastHighs: { pivot: Pivot, rsi: number }[] = [];
    private lastLows: { pivot: Pivot, rsi: number }[] = [];
    
    // Config
    private maxLookback = 5; // Lookback window for comparing pivots

    public processPivot(
        pivot: Pivot, 
        rsiByTimestamp: Map<number, number>
    ): DivergenceEvent | null {
        // Lookup O(1) del RSI exactamente en la vela del pivot.
        // Si no está (warm-up del RSI o pivot fuera del buffer), no hay
        // divergencia computable — mejor descartar que adivinar.
        const rsiValue = rsiByTimestamp.get(pivot.timestamp);
        if (rsiValue === undefined) return null;

        const currentPoint = { pivot, rsi: rsiValue };

        if (pivot.type === 'High') {
            return this.checkBearishDivergence(currentPoint);
        } else {
            return this.checkBullishDivergence(currentPoint);
        }
    }

    // 🆕 Push con trim garantizado: antes los caminos con match hacían push
    // y retornaban sin acotar el array.
    private recordHigh(p: { pivot: Pivot, rsi: number }) {
        this.lastHighs.push(p);
        if (this.lastHighs.length > this.maxLookback * 2) this.lastHighs.shift();
    }

    private recordLow(p: { pivot: Pivot, rsi: number }) {
        this.lastLows.push(p);
        if (this.lastLows.length > this.maxLookback * 2) this.lastLows.shift();
    }

    private checkBearishDivergence(current: { pivot: Pivot, rsi: number }): DivergenceEvent | null {
        // We look for a previous high to compare
        for (let i = this.lastHighs.length - 1; i >= Math.max(0, this.lastHighs.length - this.maxLookback); i--) {
            const prev = this.lastHighs[i];
            
            // Regular Bearish Divergence: Price makes Higher High, RSI makes Lower High
            if (current.pivot.price > prev.pivot.price && current.rsi < prev.rsi) {
                this.recordHigh(current);
                return { direction: 'Bearish', type: 'Regular', timestamp: current.pivot.timestamp };
            }
            
            // Hidden Bearish Divergence: Price makes Lower High, RSI makes Higher High
            if (current.pivot.price < prev.pivot.price && current.rsi > prev.rsi) {
                this.recordHigh(current);
                return { direction: 'Bearish', type: 'Hidden', timestamp: current.pivot.timestamp };
            }
        }
        
        this.recordHigh(current);
        return null;
    }

    private checkBullishDivergence(current: { pivot: Pivot, rsi: number }): DivergenceEvent | null {
        // We look for a previous low to compare
        for (let i = this.lastLows.length - 1; i >= Math.max(0, this.lastLows.length - this.maxLookback); i--) {
            const prev = this.lastLows[i];
            
            // Regular Bullish Divergence: Price makes Lower Low, RSI makes Higher Low
            if (current.pivot.price < prev.pivot.price && current.rsi > prev.rsi) {
                this.recordLow(current);
                return { direction: 'Bullish', type: 'Regular', timestamp: current.pivot.timestamp };
            }
            
            // Hidden Bullish Divergence: Price makes Higher Low, RSI makes Lower Low
            if (current.pivot.price > prev.pivot.price && current.rsi < prev.rsi) {
                this.recordLow(current);
                return { direction: 'Bullish', type: 'Hidden', timestamp: current.pivot.timestamp };
            }
        }
        
        this.recordLow(current);
        return null;
    }
}
