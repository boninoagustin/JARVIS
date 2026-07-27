// src/engine/smc/modules/order_blocks.ts
import { OHLCV, OrderBlock, SMCPreset, SMCEvents } from '../types.js';

export class OrderBlockEngine {
    private history: OHLCV[] = [];
    public activeOBs: OrderBlock[] = [];
    
    // Configuración de scoring interno
    private obAtrMultiplier: number = 1.2; // Para que sea OB, la vela de desplazamiento debe ser > 1.2 * ATR
    
    /**
     * Procesa la vela entrante para detectar OBs, mitigarlos o convertirlos en Breakers.
     */
    public processCandle(
        candle: OHLCV, 
        currentAtr: number,
        preset: SMCPreset
    ): Array<SMCEvents['EVENT_OB_CREATED']> {
        const events: any[] = [];
        this.history.push(candle);

        // 1. Mitigación y Breakers
        this.activeOBs.forEach(ob => {
            if (ob.mitigated || ob.category === 'Breaker') return;

            // Bullish OB (Soporte)
            if (ob.direction === 'Bullish') {
                if (candle.low <= ob.bottom) {
                    if (candle.close < ob.bottom) {
                        if (preset.strict_breaker && this.isDisplacement(candle, currentAtr, 'Bearish')) {
                            // Se rompe con fuerza -> Breaker
                            ob.category = 'Breaker';
                            ob.direction = 'Bearish';
                        } else {
                            ob.mitigated = true;
                        }
                    } else {
                        // Solo fue mitigado
                        ob.mitigated = true;
                    }
                }
            } 
            // Bearish OB (Resistencia)
            else if (ob.direction === 'Bearish') {
                if (candle.high >= ob.top) {
                    if (candle.close > ob.top) {
                        if (preset.strict_breaker && this.isDisplacement(candle, currentAtr, 'Bullish')) {
                            // Se rompe con fuerza -> Breaker
                            ob.category = 'Breaker';
                            ob.direction = 'Bullish';
                        } else {
                            ob.mitigated = true;
                        }
                    } else {
                        ob.mitigated = true;
                    }
                }
            }
        });

        // Limpiar OBs mitigados (que no sean breakers)
        this.activeOBs = this.activeOBs.filter(ob => !ob.mitigated || ob.category === 'Breaker');

        // 2. Detección de nuevos OBs (Requiere 2 velas)
        if (this.history.length >= 2) {
            const current = this.history[this.history.length - 1]; // Vela de desplazamiento
            const previous = this.history[this.history.length - 2]; // El OB (vela institucional)

            if (preset.require_displacement) {
                // Bullish OB: Vela previa bajista, vela actual alcista fuerte
                if (previous.close < previous.open && this.isDisplacement(current, currentAtr, 'Bullish')) {
                    const ob: OrderBlock = {
                        id: `OB-BULL-${previous.timestamp}`,
                        timestamp: previous.timestamp,
                        direction: 'Bullish',
                        top: previous.high,
                        bottom: previous.low,
                        mitigated: false,
                        score: this.calculateScore('Bullish', previous, current),
                        category: 'Plata', // Por defecto, luego el SMCEngine lo ajusta con GodZones
                        merged: false
                    };
                    this.activeOBs.push(ob);
                    events.push({ type: 'EVENT_OB_CREATED', ob });
                }

                // Bearish OB: Vela previa alcista, vela actual bajista fuerte
                if (previous.close > previous.open && this.isDisplacement(current, currentAtr, 'Bearish')) {
                    const ob: OrderBlock = {
                        id: `OB-BEAR-${previous.timestamp}`,
                        timestamp: previous.timestamp,
                        direction: 'Bearish',
                        top: previous.high,
                        bottom: previous.low,
                        mitigated: false,
                        score: this.calculateScore('Bearish', previous, current),
                        category: 'Plata',
                        merged: false
                    };
                    this.activeOBs.push(ob);
                    events.push({ type: 'EVENT_OB_CREATED', ob });
                }
            }
        }

        if (this.history.length > 5) {
            this.history.shift();
        }

        return events;
    }

    private isDisplacement(candle: OHLCV, atr: number, direction: 'Bullish' | 'Bearish'): boolean {
        const bodySize = Math.abs(candle.close - candle.open);
        const minBody = atr * this.obAtrMultiplier;
        
        if (bodySize < minBody) return false;
        
        if (direction === 'Bullish') return candle.close > candle.open;
        if (direction === 'Bearish') return candle.close < candle.open;
        
        return false;
    }

    private calculateScore(direction: 'Bullish' | 'Bearish', obCandle: OHLCV, dispCandle: OHLCV): number {
        let score = 5; // Base score (Plata)
        // Lógica base: mientras más grande la vela de desplazamiento vs el OB, más score.
        const obRange = obCandle.high - obCandle.low;
        const dispBody = Math.abs(dispCandle.close - dispCandle.open);
        
        if (obRange > 0) {
            const ratio = dispBody / obRange;
            if (ratio > 2) score += 2; // Oro
            if (ratio > 3) score += 4; // Platino (Max 9)
        }
        
        return Math.min(10, score);
    }
}
