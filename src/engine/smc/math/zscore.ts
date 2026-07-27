// src/engine/smc/math/zscore.ts

/**
 * Calcula el Z-Score rodante (Rolling Z-Score) de una serie de valores.
 * Fórmula: Z = (X - Media) / Desviación_Estándar
 */
export class ZScoreCalculator {
    private length: number;
    private history: number[] = [];

    constructor(length: number = 20) {
        this.length = length;
    }

    public nextValue(value: number): number | null {
        this.history.push(value);
        if (this.history.length > this.length) {
            this.history.shift(); // Mantener solo el tamaño de la ventana
        }

        if (this.history.length < this.length) {
            return null; // Aún no hay suficientes datos
        }

        // Calcular media
        const sum = this.history.reduce((a, b) => a + b, 0);
        const mean = sum / this.length;

        // Calcular desviación estándar
        const squaredDiffs = this.history.map(x => Math.pow(x - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / this.length;
        const stdDev = Math.sqrt(variance);

        if (stdDev === 0) return 0;

        return (value - mean) / stdDev;
    }
}
