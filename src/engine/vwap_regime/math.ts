// src/engine/vwap_regime/math.ts

export class EMA {
    private alpha: number;
    private value: number | null = null;
    private history: number[] = [];

    constructor(private period: number) {
        this.alpha = 2 / (period + 1);
    }

    update(price: number): number {
        if (this.value === null) {
            this.history.push(price);
            if (this.history.length === this.period) {
                this.value = this.history.reduce((a, b) => a + b, 0) / this.period;
            } else {
                return price; // Or NaN, but returning price is safe before full period
            }
        } else {
            this.value = (price - this.value) * this.alpha + this.value;
        }
        return this.value;
    }
}

export class RMA {
    private alpha: number;
    private value: number | null = null;
    private history: number[] = [];

    constructor(private period: number) {
        this.alpha = 1 / period;
    }

    update(price: number): number {
        if (this.value === null) {
            this.history.push(price);
            if (this.history.length === this.period) {
                this.value = this.history.reduce((a, b) => a + b, 0) / this.period;
            } else {
                return price;
            }
        } else {
            this.value = (price - this.value) * this.alpha + this.value;
        }
        return this.value;
    }
}

export class WMA {
    private history: number[] = [];
    
    constructor(private period: number) {}

    update(price: number): number {
        this.history.push(price);
        if (this.history.length > this.period) {
            this.history.shift();
        }
        
        if (this.history.length < this.period) return price;

        let sum = 0;
        let weightSum = 0;
        for (let i = 0; i < this.period; i++) {
            const weight = i + 1;
            sum += this.history[i] * weight;
            weightSum += weight;
        }
        return sum / weightSum;
    }
}

export class HMA {
    private period: number;
    private halfWma: WMA;
    private fullWma: WMA;
    private sqrtWma: WMA;

    constructor(period: number) {
        this.period = period;
        this.halfWma = new WMA(Math.floor(period / 2));
        this.fullWma = new WMA(period);
        this.sqrtWma = new WMA(Math.floor(Math.sqrt(period)));
    }

    update(price: number): number {
        const half = this.halfWma.update(price);
        const full = this.fullWma.update(price);
        
        const rawHma = (2 * half) - full;
        return this.sqrtWma.update(rawHma);
    }
}

export class SwingHighLow {
    private highHistory: number[] = [];
    private lowHistory: number[] = [];
    private index: number = 0;
    
    public ph: number | null = null;
    public pl: number | null = null;
    public phL: number = 0;
    public plL: number = 0;

    public phList: number[] = []; // stores the last 3 distinct pivot highs
    public plList: number[] = []; // stores the last 3 distinct pivot lows

    constructor(private prd: number) {}

    update(high: number, low: number): void {
        this.highHistory.push(high);
        this.lowHistory.push(low);
        if (this.highHistory.length > this.prd + 1) {
            this.highHistory.shift();
            this.lowHistory.shift();
        }

        if (this.highHistory.length === this.prd + 1) {
            // Check if the newest bar is highest/lowest
            const currentH = this.highHistory[this.highHistory.length - 1];
            const currentL = this.lowHistory[this.lowHistory.length - 1];
            
            let isHighest = true;
            let isLowest = true;
            for(let i = 0; i < this.prd; i++) {
                if (this.highHistory[i] > currentH) isHighest = false;
                if (this.lowHistory[i] < currentL) isLowest = false;
            }

            if (isHighest) {
                this.ph = currentH;
                this.phL = this.index;
                // Add to list if it's a new distinct pivot or replace if we want to store latest
                // Actually we just want the historical levels.
                // But consecutive bars might be identical highs.
                if (this.phList.length === 0 || this.phList[this.phList.length - 1] !== currentH) {
                    this.phList.push(currentH);
                    if (this.phList.length > 3) this.phList.shift();
                }
            }
            if (isLowest) {
                this.pl = currentL;
                this.plL = this.index;
                if (this.plList.length === 0 || this.plList[this.plList.length - 1] !== currentL) {
                    this.plList.push(currentL);
                    if (this.plList.length > 3) this.plList.shift();
                }
            }
        }
        this.index++;
    }
}

export class ATR {
    private rma: RMA;
    private prevClose: number | null = null;

    constructor(period: number) {
        this.rma = new RMA(period);
    }

    update(high: number, low: number, close: number): number {
        let tr = high - low;
        if (this.prevClose !== null) {
            const h_c = Math.abs(high - this.prevClose);
            const l_c = Math.abs(low - this.prevClose);
            tr = Math.max(tr, h_c, l_c);
        }
        this.prevClose = close;
        return this.rma.update(tr);
    }
}
