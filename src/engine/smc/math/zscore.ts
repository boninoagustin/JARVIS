import { OHLCV } from '../types.js';

/**
 * Calcula el Z-Score rodante (Rolling Z-Score) de una serie de valores con decaimiento exponencial.
 * Fórmula: Z = (X - Media) / Desviación_Estándar
 */
export class ZScoreCalculator {
    private length: number;
    private decay: number;
    private updistSmooth: number = 0;
    private downdistSmooth: number = 0;

    private upHistory: number[] = [];
    private dnHistory: number[] = [];

    constructor(length: number = 50, decay: number = 0.85) {
        this.length = length;
        this.decay = Math.max(0, Math.min(0.99, decay));
    }

    public nextValue(candle: OHLCV): { zUp: number, zDn: number } | null {
        const updistRaw = candle.close > candle.open ? (candle.close - candle.open) : 0;
        const downdistRaw = candle.close < candle.open ? (candle.open - candle.close) : 0;

        this.updistSmooth = this.updistSmooth * this.decay + updistRaw;
        this.downdistSmooth = this.downdistSmooth * this.decay + downdistRaw;

        this.upHistory.push(this.updistSmooth);
        this.dnHistory.push(this.downdistSmooth);

        if (this.upHistory.length > this.length) this.upHistory.shift();
        if (this.dnHistory.length > this.length) this.dnHistory.shift();

        if (this.upHistory.length < this.length) return null;

        const sumUp = this.upHistory.reduce((a, b) => a + b, 0);
        const meanUp = sumUp / this.length;
        const varUp = this.upHistory.reduce((a, b) => a + Math.pow(b - meanUp, 2), 0) / this.length;
        const stdDevUp = Math.sqrt(varUp);
        const zUp = stdDevUp === 0 ? 0 : (this.updistSmooth - meanUp) / stdDevUp;

        const sumDn = this.dnHistory.reduce((a, b) => a + b, 0);
        const meanDn = sumDn / this.length;
        const varDn = this.dnHistory.reduce((a, b) => a + Math.pow(b - meanDn, 2), 0) / this.length;
        const stdDevDn = Math.sqrt(varDn);
        const zDn = stdDevDn === 0 ? 0 : (this.downdistSmooth - meanDn) / stdDevDn;

        return { zUp, zDn };
    }
}
