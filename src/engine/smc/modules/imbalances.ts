// src/engine/smc/modules/imbalances.ts
import { OHLCV, Imbalance, SMCPreset, SMCEvents } from '../types.js';

export class ImbalanceEngine {
    private history: OHLCV[] = [];
    public activeFVGs: Imbalance[] = [];
    
    // Configuración
    private fvgAtrMultiplier: number = 0.5; // Tamaño mínimo del FVG basado en ATR

    /**
     * Procesa la vela entrante para detectar nuevos FVGs, 
     * mitigar los existentes o convertirlos en iFVG (God Zones).
     */
    public processCandle(
        candle: OHLCV, 
        currentAtr: number,
        preset: SMCPreset
    ): Array<SMCEvents['EVENT_IFVG_CREATED']> {
        const events: any[] = [];
        this.history.push(candle);

        // 1. Mitigación e Inversión (iFVG) de los FVGs activos
        this.activeFVGs.forEach(fvg => {
            if (fvg.mitigated || fvg.is_ifvg) return;

            // FVG Alcista (Bullish)
            if (fvg.direction === 'Bullish') {
                if (candle.low <= fvg.bottom) {
                    // Si el precio cruza por completo y cierra por debajo, es un iFVG
                    if (candle.close < fvg.bottom) {
                        fvg.is_ifvg = true;
                        fvg.direction = 'Bearish'; // Ahora actúa como resistencia
                        events.push({ type: 'EVENT_IFVG_CREATED', fvg });
                    } else {
                        // Solo fue mitigado
                        fvg.mitigated = true;
                    }
                }
            } 
            // FVG Bajista (Bearish)
            else if (fvg.direction === 'Bearish') {
                if (candle.high >= fvg.top) {
                    // Si el precio cruza por completo y cierra por encima, es un iFVG
                    if (candle.close > fvg.top) {
                        fvg.is_ifvg = true;
                        fvg.direction = 'Bullish'; // Ahora actúa como soporte
                        events.push({ type: 'EVENT_IFVG_CREATED', fvg });
                    } else {
                        // Solo fue mitigado
                        fvg.mitigated = true;
                    }
                }
            }
        });

        // Limpiar los FVGs que fueron mitigados y no se convirtieron en iFVG
        this.activeFVGs = this.activeFVGs.filter(fvg => !fvg.mitigated || fvg.is_ifvg);

        // 🆕 Cap duro: el filtro anterior retiene iFVGs mitigados para siempre;
        // sin límite, el array crece indefinidamente en ejecución 24/7.
        const MAX_ACTIVE_FVGS = 50;
        if (this.activeFVGs.length > MAX_ACTIVE_FVGS) {
            this.activeFVGs.splice(0, this.activeFVGs.length - MAX_ACTIVE_FVGS);
        }

        // 2. Detección de nuevos FVGs (Requiere al menos 3 velas)
        if (this.history.length >= 3) {
            const c0 = this.history[this.history.length - 1]; // Vela actual
            const c1 = this.history[this.history.length - 2]; // Vela del medio (desplazamiento)
            const c2 = this.history[this.history.length - 3]; // Vela anterior

            const minGapSize = currentAtr * this.fvgAtrMultiplier;

            // Detección FVG Alcista
            if (c0.low > c2.high) {
                const gapSize = c0.low - c2.high;
                if (gapSize >= minGapSize && (preset.require_displacement ? c1.close > c1.open : true)) {
                    this.activeFVGs.push({
                        id: `FVG-BULL-${c1.timestamp}`,
                        timestamp: c1.timestamp,
                        direction: 'Bullish',
                        top: c0.low,
                        bottom: c2.high,
                        mitigated: false,
                        is_ifvg: false
                    });
                }
            }

            // Detección FVG Bajista
            if (c0.high < c2.low) {
                const gapSize = c2.low - c0.high;
                if (gapSize >= minGapSize && (preset.require_displacement ? c1.close < c1.open : true)) {
                    this.activeFVGs.push({
                        id: `FVG-BEAR-${c1.timestamp}`,
                        timestamp: c1.timestamp,
                        direction: 'Bearish',
                        top: c2.low,
                        bottom: c0.high,
                        mitigated: false,
                        is_ifvg: false
                    });
                }
            }
        }

        // Mantener historial pequeño (solo necesitamos 3 velas)
        if (this.history.length > 5) {
            this.history.shift();
        }

        return events;
    }
}
