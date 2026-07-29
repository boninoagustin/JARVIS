import { Pivot, Direction } from '../types.js';

export interface DivergenceEvent {
    direction: Direction;
    type: 'Regular' | 'Hidden';
    timestamp: number;
    price: number;
}

export class DivergenceEngine {
    private lastPriceHighs: Pivot[] = [];
    private lastPriceLows: Pivot[] = [];
    private lastRsiHighs: Pivot[] = [];
    private lastRsiLows: Pivot[] = [];
    
    private matchedHighs: { price: Pivot, rsi: Pivot }[] = [];
    private matchedLows: { price: Pivot, rsi: Pivot }[] = [];

    // Config
    private maxLookback = 5;
    // 🆕 N2: tolerancia en VELAS (no ms) entre el pivote de precio y el de RSI.
    // Los timestamps están en ms, así que se compara contra rsiTolerance * periodMs.
    private rsiTolerance = 3;
    private periodMs: number;

    constructor(periodMs: number = 60 * 60000) {
        this.periodMs = periodMs;
    }

    public addRsiPivot(pivot: Pivot): DivergenceEvent | null {
        if (pivot.type === 'High') {
            this.lastRsiHighs.push(pivot);
            if (this.lastRsiHighs.length > this.maxLookback) this.lastRsiHighs.shift();
        } else {
            this.lastRsiLows.push(pivot);
            if (this.lastRsiLows.length > this.maxLookback) this.lastRsiLows.shift();
        }
        return this.matchAndCheck(pivot.type);
    }

    public processPricePivot(pivot: Pivot): DivergenceEvent | null {
        if (pivot.type === 'High') {
            this.lastPriceHighs.push(pivot);
            if (this.lastPriceHighs.length > this.maxLookback) this.lastPriceHighs.shift();
        } else {
            this.lastPriceLows.push(pivot);
            if (this.lastPriceLows.length > this.maxLookback) this.lastPriceLows.shift();
        }
        return this.matchAndCheck(pivot.type);
    }

    private matchAndCheck(type: 'High' | 'Low'): DivergenceEvent | null {
        const pricePivots = type === 'High' ? this.lastPriceHighs : this.lastPriceLows;
        const rsiPivots = type === 'High' ? this.lastRsiHighs : this.lastRsiLows;
        const matched = type === 'High' ? this.matchedHighs : this.matchedLows;

        if (pricePivots.length === 0 || rsiPivots.length === 0) return null;

        // Take the latest un-matched price pivot and find its RSI pivot
        const latestPrice = pricePivots[pricePivots.length - 1];
        
        if (matched.length > 0 && matched[matched.length - 1].price.timestamp === latestPrice.timestamp) {
            return null;
        }

        let closestRsi: Pivot | null = null;
        let minDiff = Infinity;

        // Buscamos el pivot de RSI más cercano en tiempo
        for (let i = rsiPivots.length - 1; i >= 0; i--) {
            const rp = rsiPivots[i];
            const diff = Math.abs(rp.timestamp - latestPrice.timestamp);
            if (diff <= this.rsiTolerance * this.periodMs) {
                if (diff < minDiff) {
                    minDiff = diff;
                    closestRsi = rp;
                }
            }
        }

        if (closestRsi) {
            const newMatch = { price: latestPrice, rsi: closestRsi };
            matched.push(newMatch);
            if (matched.length > this.maxLookback) matched.shift();

            // Comparar de forma consecutiva con el match anterior
            if (matched.length >= 2) {
                const prev = matched[matched.length - 2];
                const curr = newMatch;
                
                if (type === 'High') {
                    if (curr.price.price > prev.price.price && curr.rsi.price < prev.rsi.price) {
                        return { direction: 'Bearish', type: 'Regular', timestamp: curr.price.timestamp, price: curr.price.price };
                    }
                    if (curr.price.price < prev.price.price && curr.rsi.price > prev.rsi.price) {
                        return { direction: 'Bearish', type: 'Hidden', timestamp: curr.price.timestamp, price: curr.price.price };
                    }
                } else {
                    if (curr.price.price < prev.price.price && curr.rsi.price > prev.rsi.price) {
                        return { direction: 'Bullish', type: 'Regular', timestamp: curr.price.timestamp, price: curr.price.price };
                    }
                    if (curr.price.price > prev.price.price && curr.rsi.price < prev.rsi.price) {
                        return { direction: 'Bullish', type: 'Hidden', timestamp: curr.price.timestamp, price: curr.price.price };
                    }
                }
            }
        }

        return null;
    }
}
