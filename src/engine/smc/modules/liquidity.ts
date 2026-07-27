// src/engine/smc/modules/liquidity.ts
import { OHLCV, Pivot, SMCEvents } from '../types.js';

interface LiquidityLevel {
    price: number;
    type: 'High' | 'Low';
    touches: number;
    swept: boolean;
}

export class LiquidityEngine {
    public activeLevels: LiquidityLevel[] = [];
    
    // Configuración
    private toleranceAtrMultiplier: number = 0.5; // Tolerancia para Equal Highs/Lows
    private grabWickPct: number = 0.6; // Porcentaje de mecha para considerar Liquidity Grab

    /**
     * Registra nuevos niveles de liquidez basados en Pivots.
     */
    public registerPivot(pivot: Pivot, currentAtr: number) {
        const tolerance = currentAtr * this.toleranceAtrMultiplier;
        
        // Buscar si ya existe un nivel cercano para sumar toques (Equal Highs / Lows)
        const existing = this.activeLevels.find(l => 
            l.type === pivot.type && 
            Math.abs(l.price - pivot.price) <= tolerance && 
            !l.swept
        );

        if (existing) {
            existing.touches += 1;
            // Promediar el precio ligeramente hacia el nuevo toque
            existing.price = (existing.price + pivot.price) / 2;
        } else {
            this.activeLevels.push({
                price: pivot.price,
                type: pivot.type,
                touches: 1,
                swept: false
            });
        }
    }

    /**
     * Procesa la vela para detectar si barre algún nivel de liquidez activo.
     */
    public processCandle(
        candle: OHLCV
    ): Array<SMCEvents['EVENT_SWEEP']> {
        const events: any[] = [];
        
        const totalRange = candle.high - candle.low;
        if (totalRange === 0) return events;

        const topWick = candle.high - Math.max(candle.open, candle.close);
        const bottomWick = Math.min(candle.open, candle.close) - candle.low;
        
        const topWickPct = topWick / totalRange;
        const bottomWickPct = bottomWick / totalRange;

        this.activeLevels.forEach(level => {
            if (level.swept) return;

            // Barrido de Highs (Liquidity Sweep Alcista / Trampa)
            if (level.type === 'High' && candle.high > level.price) {
                // Liquidity Grab: Sube por encima del nivel, pero cierra por debajo y deja mecha larga
                if (candle.close < level.price && topWickPct >= this.grabWickPct) {
                    level.swept = true;
                    events.push({ 
                        type: 'EVENT_SWEEP', 
                        direction: 'Bearish', // Reversión bajista tras barrer liquidez alcista
                        price: level.price, 
                        sweepType: 'LIQ_GRAB',
                        timestamp: candle.timestamp 
                    });
                } 
                // Barrido estándar (cierra por encima)
                else if (candle.close > level.price) {
                    level.swept = true;
                    events.push({ 
                        type: 'EVENT_SWEEP', 
                        direction: 'Bullish',
                        price: level.price, 
                        sweepType: level.touches >= 2 ? 'PEH' : 'SWEEP',
                        timestamp: candle.timestamp 
                    });
                }
            }
            
            // Barrido de Lows (Liquidity Sweep Bajista / Trampa)
            if (level.type === 'Low' && candle.low < level.price) {
                // Liquidity Grab: Baja por debajo del nivel, pero cierra por encima y deja mecha larga
                if (candle.close > level.price && bottomWickPct >= this.grabWickPct) {
                    level.swept = true;
                    events.push({ 
                        type: 'EVENT_SWEEP', 
                        direction: 'Bullish', // Reversión alcista tras barrer liquidez bajista
                        price: level.price, 
                        sweepType: 'LIQ_GRAB',
                        timestamp: candle.timestamp 
                    });
                }
                // Barrido estándar
                else if (candle.close < level.price) {
                    level.swept = true;
                    events.push({ 
                        type: 'EVENT_SWEEP', 
                        direction: 'Bearish',
                        price: level.price, 
                        sweepType: level.touches >= 2 ? 'PEL' : 'SWEEP',
                        timestamp: candle.timestamp 
                    });
                }
            }
        });

        // Limpiar niveles barridos
        this.activeLevels = this.activeLevels.filter(l => !l.swept);

        return events;
    }
}
