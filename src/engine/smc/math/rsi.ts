// src/engine/smc/math/rsi.ts

/**
 * Calcula el Relative Strength Index (RSI) con RMA,
 * igual que el ta.rsi de TradingView.
 */
export class RSICalculator {
    private length: number;
    private rmaUp: number | null = null;
    private rmaDown: number | null = null;
    private historyUp: number[] = [];
    private historyDown: number[] = [];

    constructor(length: number = 14) {
        this.length = length;
    }

    public nextValue(currentClose: number, previousClose?: number): number | null {
        if (previousClose === undefined) return null;

        const change = currentClose - previousClose;
        const up = Math.max(change, 0);
        const down = -Math.min(change, 0);

        if (this.rmaUp === null || this.rmaDown === null) {
            this.historyUp.push(up);
            this.historyDown.push(down);
            
            if (this.historyUp.length === this.length) {
                // Primer cálculo usando SMA
                this.rmaUp = this.historyUp.reduce((a, b) => a + b, 0) / this.length;
                this.rmaDown = this.historyDown.reduce((a, b) => a + b, 0) / this.length;
                return this.calculateRSI();
            }
            return null; // Aún no hay suficientes datos
        }

        // RMA = (ValorActual + (Length - 1) * RMA_Anterior) / Length
        this.rmaUp = (up + (this.length - 1) * this.rmaUp) / this.length;
        this.rmaDown = (down + (this.length - 1) * this.rmaDown) / this.length;

        return this.calculateRSI();
    }

    private calculateRSI(): number {
        if (this.rmaDown === 0) return 100;
        if (this.rmaUp === 0) return 0;
        const rs = this.rmaUp! / this.rmaDown!;
        return 100 - (100 / (1 + rs));
    }
}
