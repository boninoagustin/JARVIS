// src/engine/smc/modules/market_structure.ts
import { OHLCV, Pivot, Direction, SMCPreset, SMCEvents } from '../types.js';

const HISTORY_CAP = 150;
// 🆕 Fase 2.1: lookback máximo para buscar el origin del impulso (como el Pine: min(max(1, bars_since_pivot), 100))
const ORIGIN_LOOKBACK = 100;

export class MarketStructureEngine {
    public currentTrend: Direction | 'Neutral' = 'Neutral';
    public lastBOS: Pivot | null = null;
    public lastCHoCH: Pivot | null = null;
    
    // Almacena el último pivot mayor (Swing High/Low) que define la estructura actual
    public activeSwingHigh: Pivot | null = null;
    public activeSwingLow: Pivot | null = null;

    // 🆕 Buffer de velas para calcular origin/extreme del impulso en BOS/CHoCH
    private history: OHLCV[] = [];

    // 🆕 Filtro 3: extremo de la tendencia activa (trend_extreme del Pine).
    // En tendencia alcista es el mayor high alcanzado; en bajista, el menor low.
    private trendExtreme: number | null = null;

    /**
     * 🆕 Filtro 3 (paridad Pine): requisitos extra para VALIDAR un CHoCH.
     * - chochReqSweep: el impulso debe haber barrido liquidez (origin más allá
     *   del extremo de la tendencia). En el Pine aplica a 1h/4h/D (o riesgo ≤2).
     * - chochReqMom: exige momentum Z-Score. En el Pine aplica a 4h/D (o riesgo 1).
     */
    private chochReqSweep: boolean;
    private chochReqMom: boolean;

    constructor(chochReqSweep: boolean = false, chochReqMom: boolean = false) {
        this.chochReqSweep = chochReqSweep;
        this.chochReqMom = chochReqMom;
    }

    /**
     * 🆕 Fase 2.1: origin/extreme del impulso (equivalente al lookback del Pine).
     * origin  = extremo opuesto de la pierna (min low en ruptura alcista, max high en bajista)
     *           medido desde el pivot roto hasta la vela previa a la actual.
     * extreme = extremo a favor (max high / min low) incluyendo la vela actual.
     */
    private computeOriginExtreme(pivotTs: number, isBullishBreak: boolean, current: OHLCV): { origin: number; extreme: number; originTs: number; extremeTs: number } {
        const window = this.history
            .filter(c => c.timestamp >= pivotTs && c.timestamp < current.timestamp);

        if (window.length === 0) {
            return {
                origin: isBullishBreak ? current.low : current.high,
                extreme: isBullishBreak ? current.high : current.low,
                originTs: current.timestamp,
                extremeTs: current.timestamp
            };
        }

        if (isBullishBreak) {
            const originCandle = window.reduce((min, c) => c.low < min.low ? c : min, window[0]);
            const maxWindow = window.reduce((max, c) => c.high > max.high ? c : max, window[0]);
            const extremeCandle = current.high > maxWindow.high ? current : maxWindow;
            return {
                origin: originCandle.low,
                extreme: extremeCandle.high,
                originTs: originCandle.timestamp,
                extremeTs: extremeCandle.timestamp
            };
        } else {
            const originCandle = window.reduce((max, c) => c.high > max.high ? c : max, window[0]);
            const minWindow = window.reduce((min, c) => c.low < min.low ? c : min, window[0]);
            const extremeCandle = current.low < minWindow.low ? current : minWindow;
            return {
                origin: originCandle.high,
                extreme: extremeCandle.low,
                originTs: originCandle.timestamp,
                extremeTs: extremeCandle.timestamp
            };
        }
    }

    /**
     * Procesa la vela y los pivotes para emitir BOS o CHoCH.
     * Retorna una lista de eventos emitidos en esta vela.
     */
    public processCandle(
        candle: OHLCV, 
        pivotsHigh: Pivot[], 
        pivotsLow: Pivot[], 
        preset: SMCPreset,
        options: { zScore?: { zUp: number; zDn: number } | null; sweepEscapeDir?: Direction | null } = {}
    ): Array<(SMCEvents['EVENT_BOS'] & { type: 'EVENT_BOS' }) | (SMCEvents['EVENT_CHOCH'] & { type: 'EVENT_CHOCH' })> {
        
        const events: any[] = [];
        const zScore = options.zScore ?? null;
        const sweepEscapeDir = options.sweepEscapeDir ?? null;
        
        // 🆕 Alimentar el buffer de historia para origin/extreme
        this.history.push(candle);
        if (this.history.length > HISTORY_CAP) this.history.shift();

        // 🆕 Filtro 3: actualizar el extremo de la tendencia activa (como el Pine)
        if (this.currentTrend === 'Bullish') {
            this.trendExtreme = this.trendExtreme === null ? candle.high : Math.max(this.trendExtreme, candle.high);
        } else if (this.currentTrend === 'Bearish') {
            this.trendExtreme = this.trendExtreme === null ? candle.low : Math.min(this.trendExtreme, candle.low);
        }
        
        // Actualizar swing points válidos (los más recientes que no han sido rotos)
        this.updateActiveSwings(pivotsHigh, pivotsLow);

        if (this.currentTrend === 'Neutral') {
            if (this.activeSwingHigh && this.checkBreak(candle, this.activeSwingHigh.price, true, preset.confirm_close)) {
                this.currentTrend = 'Bullish';
                this.trendExtreme = candle.high;
                this.activeSwingHigh.isBroken = true;
                const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingHigh.timestamp, true, candle);
                events.push({ type: 'EVENT_CHOCH', direction: 'Bullish', price: this.activeSwingHigh.price, timestamp: candle.timestamp, origin, extreme, originTs, extremeTs });
            } else if (this.activeSwingLow && this.checkBreak(candle, this.activeSwingLow.price, false, preset.confirm_close)) {
                this.currentTrend = 'Bearish';
                this.trendExtreme = candle.low;
                this.activeSwingLow.isBroken = true;
                const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingLow.timestamp, false, candle);
                events.push({ type: 'EVENT_CHOCH', direction: 'Bearish', price: this.activeSwingLow.price, timestamp: candle.timestamp, origin, extreme, originTs, extremeTs });
            }
            return events;
        }

        // Evaluar BOS y CHoCH si ya tenemos tendencia
        if (this.currentTrend === 'Bullish') {
            // BOS: Romper Swing High hacia arriba
            if (this.activeSwingHigh && !this.activeSwingHigh.isBroken && this.checkBreak(candle, this.activeSwingHigh.price, true, preset.confirm_close)) {
                this.activeSwingHigh.isBroken = true;
                this.lastBOS = this.activeSwingHigh;
                this.trendExtreme = candle.high; // reset del extremo como en el Pine
                const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingHigh.timestamp, true, candle);
                events.push({ type: 'EVENT_BOS', direction: 'Bullish', price: this.activeSwingHigh.price, timestamp: candle.timestamp, origin, extreme, originTs, extremeTs });
            }
            // CHoCH: Romper Swing Low hacia abajo (Cambio a Bajista)
            if (this.activeSwingLow && !this.activeSwingLow.isBroken && this.checkBreak(candle, this.activeSwingLow.price, false, preset.confirm_close)) {
                this.activeSwingLow.isBroken = true; // Consumido incluso si falla los gates
                    const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingLow.timestamp, false, candle);
                    if (this.passesChochGates(origin, false, zScore, sweepEscapeDir)) {
                        this.lastCHoCH = this.activeSwingLow;
                        this.currentTrend = 'Bearish';
                        if(false) console.error(`[TREND CHANGE] ${new Date(candle.timestamp).toISOString()} -> Bearish (CHOCH SELL)`);
                        this.trendExtreme = candle.low;
                        events.push({ type: 'EVENT_CHOCH', direction: 'Bearish', price: this.activeSwingLow.price, timestamp: candle.timestamp, origin, extreme, originTs, extremeTs });
                }
            }
        } else if (this.currentTrend === 'Bearish') {
            // BOS: Romper Swing Low hacia abajo
            if (this.activeSwingLow && !this.activeSwingLow.isBroken && this.checkBreak(candle, this.activeSwingLow.price, false, preset.confirm_close)) {
                this.activeSwingLow.isBroken = true;
                this.lastBOS = this.activeSwingLow;
                this.trendExtreme = candle.low;
                const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingLow.timestamp, false, candle);
                events.push({ type: 'EVENT_BOS', direction: 'Bearish', price: this.activeSwingLow.price, timestamp: candle.timestamp, origin, extreme, originTs, extremeTs });
            }
            // CHoCH: Romper Swing High hacia arriba (Cambio a Alcista)
            if (this.activeSwingHigh && !this.activeSwingHigh.isBroken && this.checkBreak(candle, this.activeSwingHigh.price, true, preset.confirm_close)) {
                this.activeSwingHigh.isBroken = true; // Consumido incluso si falla los gates
                const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingHigh.timestamp, true, candle);
                if (this.passesChochGates(origin, true, zScore, sweepEscapeDir)) {
                    this.lastCHoCH = this.activeSwingHigh;
                    this.currentTrend = 'Bullish';
                    if(false) console.error(`[TREND CHANGE] ${new Date(candle.timestamp).toISOString()} -> Bullish (CHOCH BUY)`);
                    this.trendExtreme = candle.high;
                    events.push({ type: 'EVENT_CHOCH', direction: 'Bullish', price: this.activeSwingHigh.price, timestamp: candle.timestamp, origin, extreme, originTs, extremeTs });
                }
            }
        }

        return events;
    }

    /**
     * 🆕 Filtro 3: valida un CHoCH contra los requisitos del Pine.
     * - Sweep: el origin del impulso supera el extremo de la tendencia que revierte,
     *   O hubo un sweep reciente en la dirección de la reversa (sweep_active del Pine).
     * - Momentum: Z-Score con signo a favor ≥ 1.5.
     */
    private passesChochGates(origin: number, isBullishReversal: boolean, zScore: { zUp: number, zDn: number } | null, sweepEscapeDir: Direction | null): boolean {
        if (this.chochReqSweep && this.trendExtreme !== null) {
            const sweptExtreme = isBullishReversal ? origin <= this.trendExtreme : origin >= this.trendExtreme;
            const sweepActive = sweepEscapeDir === (isBullishReversal ? 'Bullish' : 'Bearish');
            const sweptLiq = sweptExtreme || sweepActive;
            
            if (!sweptLiq) return false;
        }
        if (this.chochReqMom) {
            const hasMom = isBullishReversal
                ? (zScore !== null && zScore.zUp >= 1.5)
                : (zScore !== null && zScore.zDn >= 1.5);
            if (!hasMom) return false;
        }
        return true;
    }

    private updateActiveSwings(pivotsHigh: Pivot[], pivotsLow: Pivot[]) {
        // En PineScript, solo el pivote más reciente está activo (curr_ph/curr_pl).
        // Si se rompe, esperamos a que se forme uno nuevo, no retrocedemos a pivotes anteriores.
        if (pivotsHigh.length > 0) {
            const lastHigh = pivotsHigh[pivotsHigh.length - 1];
            if (!lastHigh.isBroken) {
                this.activeSwingHigh = lastHigh;
            } else if (this.activeSwingHigh && this.activeSwingHigh.timestamp === lastHigh.timestamp) {
                // Si el último pivote está roto y es el que teníamos activo, lo limpiamos.
                this.activeSwingHigh = null;
            }
        }
        
        if (pivotsLow.length > 0) {
            const lastLow = pivotsLow[pivotsLow.length - 1];
            if (!lastLow.isBroken) {
                this.activeSwingLow = lastLow;
            } else if (this.activeSwingLow && this.activeSwingLow.timestamp === lastLow.timestamp) {
                this.activeSwingLow = null;
            }
        }
    }

    private checkBreak(candle: OHLCV, priceLevel: number, isUp: boolean, confirmClose: boolean): boolean {
        if (isUp) {
            return confirmClose ? candle.close > priceLevel : candle.high > priceLevel;
        } else {
            return confirmClose ? candle.close < priceLevel : candle.low < priceLevel;
        }
    }
}
