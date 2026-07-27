// src/engine/smc/modules/market_structure.ts
import { OHLCV, Pivot, Direction, SMCPreset, SMCEvents } from '../types.js';

export class MarketStructureEngine {
    public currentTrend: Direction | 'Neutral' = 'Neutral';
    public lastBOS: Pivot | null = null;
    public lastCHoCH: Pivot | null = null;
    
    // Almacena el último pivot mayor (Swing High/Low) que define la estructura actual
    public activeSwingHigh: Pivot | null = null;
    public activeSwingLow: Pivot | null = null;

    /**
     * Procesa la vela y los pivotes para emitir BOS o CHoCH.
     * Retorna una lista de eventos emitidos en esta vela.
     */
    public processCandle(
        candle: OHLCV, 
        pivotsHigh: Pivot[], 
        pivotsLow: Pivot[], 
        preset: SMCPreset
    ): Array<SMCEvents['EVENT_BOS'] | SMCEvents['EVENT_CHOCH']> {
        
        const events: any[] = [];
        
        // Actualizar swing points válidos (los más recientes que no han sido rotos)
        this.updateActiveSwings(pivotsHigh, pivotsLow);

        if (this.currentTrend === 'Neutral') {
            // Inicializar tendencia si rompe el primer pivot fuerte
            if (this.activeSwingHigh && this.checkBreak(candle, this.activeSwingHigh.price, true, preset.confirm_close)) {
                this.currentTrend = 'Bullish';
                this.activeSwingHigh.isBroken = true;
            } else if (this.activeSwingLow && this.checkBreak(candle, this.activeSwingLow.price, false, preset.confirm_close)) {
                this.currentTrend = 'Bearish';
                this.activeSwingLow.isBroken = true;
            }
            return events;
        }

        // Evaluar BOS y CHoCH si ya tenemos tendencia
        if (this.currentTrend === 'Bullish') {
            // BOS: Romper Swing High hacia arriba
            if (this.activeSwingHigh && !this.activeSwingHigh.isBroken && this.checkBreak(candle, this.activeSwingHigh.price, true, preset.confirm_close)) {
                this.activeSwingHigh.isBroken = true;
                this.lastBOS = this.activeSwingHigh;
                events.push({ type: 'EVENT_BOS', direction: 'Bullish', price: this.activeSwingHigh.price, timestamp: candle.timestamp });
            }
            // CHoCH: Romper Swing Low hacia abajo (Cambio a Bajista)
            if (this.activeSwingLow && !this.activeSwingLow.isBroken && this.checkBreak(candle, this.activeSwingLow.price, false, preset.confirm_close)) {
                this.activeSwingLow.isBroken = true;
                this.lastCHoCH = this.activeSwingLow;
                this.currentTrend = 'Bearish';
                events.push({ type: 'EVENT_CHOCH', direction: 'Bearish', price: this.activeSwingLow.price, timestamp: candle.timestamp });
            }
        } else if (this.currentTrend === 'Bearish') {
            // BOS: Romper Swing Low hacia abajo
            if (this.activeSwingLow && !this.activeSwingLow.isBroken && this.checkBreak(candle, this.activeSwingLow.price, false, preset.confirm_close)) {
                this.activeSwingLow.isBroken = true;
                this.lastBOS = this.activeSwingLow;
                events.push({ type: 'EVENT_BOS', direction: 'Bearish', price: this.activeSwingLow.price, timestamp: candle.timestamp });
            }
            // CHoCH: Romper Swing High hacia arriba (Cambio a Alcista)
            if (this.activeSwingHigh && !this.activeSwingHigh.isBroken && this.checkBreak(candle, this.activeSwingHigh.price, true, preset.confirm_close)) {
                this.activeSwingHigh.isBroken = true;
                this.lastCHoCH = this.activeSwingHigh;
                this.currentTrend = 'Bullish';
                events.push({ type: 'EVENT_CHOCH', direction: 'Bullish', price: this.activeSwingHigh.price, timestamp: candle.timestamp });
            }
        }

        return events;
    }

    private updateActiveSwings(pivotsHigh: Pivot[], pivotsLow: Pivot[]) {
        // Encontrar el último pivot high no roto
        for (let i = pivotsHigh.length - 1; i >= 0; i--) {
            if (!pivotsHigh[i].isBroken) {
                this.activeSwingHigh = pivotsHigh[i];
                break;
            }
        }
        
        // Encontrar el último pivot low no roto
        for (let i = pivotsLow.length - 1; i >= 0; i--) {
            if (!pivotsLow[i].isBroken) {
                this.activeSwingLow = pivotsLow[i];
                break;
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
