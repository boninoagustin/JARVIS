// src/engine/smc/modules/imbalances.ts
import { OHLCV, Imbalance, SMCPreset } from '../types.js';
import { resolveSignalPolicy } from '../signal_profiles.js';
import { isValidImpulseCandle } from '../math/directional_impulse.js';

export class ImbalanceEngine {
    private history: OHLCV[] = [];
    public activeFVGs: Imbalance[] = [];
    /**
     * Procesa la vela entrante para detectar nuevos FVGs, 
     * mitigar los existentes o convertirlos en iFVG (God Zones).
     */
    public processCandle(
        candle: OHLCV, 
        currentAtr: number,
        preset: SMCPreset,
        periodMs?: number
    ): Array<any> {
        const policy = resolveSignalPolicy(preset);
        const events: any[] = [];
        this.history.push(candle);

        // 1. Mitigación parcial, total e inversión (iFVG) de los FVGs activos
        this.activeFVGs.forEach(fvg => {
            // iFVG: se invalida cuando el precio CIERRA de vuelta a través del
            // lado opuesto de la zona ORIGINAL (el iFVG queda usado y agotado)
            if (fvg.is_ifvg) {
                // iFVG Bearish (nació de FVG Bullish invertido): falla si cierra sobre el top original
                if (fvg.direction === 'Bearish' && candle.close > fvg.originalTop!) {
                    fvg.mitigated = true;
                // iFVG Bullish (nació de FVG Bearish invertido): falla si cierra bajo el bottom original
                } else if (fvg.direction === 'Bullish' && candle.close < fvg.originalBottom!) {
                    fvg.mitigated = true;
                }
                return;
            }

            // FVGs ya mitigados: verificar conversión a iFVG en velas posteriores
            if (fvg.mitigated) {
                if (fvg.direction === 'Bullish' && candle.close < fvg.originalBottom!) {
                    fvg.is_ifvg = true;
                    fvg.direction = 'Bearish';
                    fvg.mitigated = false;
                    // Restaurar la zona original para el iFVG
                    fvg.top = fvg.originalTop!;
                    fvg.bottom = fvg.originalBottom!;
                    events.push({ type: 'EVENT_IFVG_CREATED', fvg });
                } else if (fvg.direction === 'Bearish' && candle.close > fvg.originalTop!) {
                    fvg.is_ifvg = true;
                    fvg.direction = 'Bullish';
                    fvg.mitigated = false;
                    fvg.top = fvg.originalTop!;
                    fvg.bottom = fvg.originalBottom!;
                    events.push({ type: 'EVENT_IFVG_CREATED', fvg });
                }
                return;
            }

            const originalSize = fvg.originalTop! - fvg.originalBottom!;

            // FVG Alcista (Bullish): soporte — precio baja hacia la zona
            if (fvg.direction === 'Bullish') {
                if (candle.low < fvg.top) {
                    // Cierre por debajo del bottom original → iFVG
                    if (candle.close < fvg.originalBottom!) {
                        fvg.is_ifvg = true;
                        fvg.direction = 'Bearish';
                        fvg.top = fvg.originalTop!;
                        fvg.bottom = fvg.originalBottom!;
                        events.push({ type: 'EVENT_IFVG_CREATED', fvg });
                    } else if (candle.low <= fvg.bottom) {
                        // Mecha atravesó toda la zona → mitigación total
                        fvg.mitigated = true;
                    } else {
                        // Fill parcial: recortar la zona desde arriba
                        const newTop = candle.low;
                        const remaining = newTop - fvg.bottom;
                        if (remaining / originalSize < 0.2) {
                            // Menos del 20% restante → mitigación total
                            fvg.mitigated = true;
                        } else {
                            fvg.top = newTop;
                        }
                    }
                }
            }
            // FVG Bajista (Bearish): resistencia — precio sube hacia la zona
            else if (fvg.direction === 'Bearish') {
                if (candle.high > fvg.bottom) {
                    // Cierre por encima del top original → iFVG
                    if (candle.close > fvg.originalTop!) {
                        fvg.is_ifvg = true;
                        fvg.direction = 'Bullish';
                        fvg.top = fvg.originalTop!;
                        fvg.bottom = fvg.originalBottom!;
                        events.push({ type: 'EVENT_IFVG_CREATED', fvg });
                    } else if (candle.high >= fvg.top) {
                        // Mecha atravesó toda la zona → mitigación total
                        fvg.mitigated = true;
                    } else {
                        // Fill parcial: recortar la zona desde abajo
                        const newBottom = candle.high;
                        const remaining = fvg.top - newBottom;
                        if (remaining / originalSize < 0.2) {
                            fvg.mitigated = true;
                        } else {
                            fvg.bottom = newBottom;
                        }
                    }
                }
            }
        });

        // Los FVGs mitigados se mantienen vivos para posible conversión a iFVG.
        // Solo eliminamos los iFVGs que ya fueron mitigados (usados y agotados).
        this.activeFVGs = this.activeFVGs.filter(fvg => !(fvg.is_ifvg && fvg.mitigated));

        // 🆕 Cap duro de seguridad: límite defensivo por si el array crece
        // indefinidamente en ejecución 24/7.
        const MAX_ACTIVE_FVGS = 50;
        if (this.activeFVGs.length > MAX_ACTIVE_FVGS) {
            this.activeFVGs.splice(0, this.activeFVGs.length - MAX_ACTIVE_FVGS);
        }

        // 2. Detección de nuevos FVGs (Requiere al menos 3 velas)
        if (this.history.length >= 3) {
            const c0 = this.history[this.history.length - 1]; // Vela actual
            const c1 = this.history[this.history.length - 2]; // Vela del medio (desplazamiento)
            const c2 = this.history[this.history.length - 3]; // Vela anterior

            // E3: un gap de fin de semana/feriado entre las velas del trío crea FVGs gigantes de ruido
            const hasTimeGap = periodMs !== undefined && periodMs > 0 &&
                (c0.timestamp - c1.timestamp > periodMs * 2.5 || c1.timestamp - c2.timestamp > periodMs * 2.5);

            const fvgAtrMult = policy.fvgQuality ? policy.fvg.minAtr :
                (preset.fvg_min_atr_factor !== undefined ? preset.fvg_min_atr_factor : 0.5);
            const minGapSize = currentAtr * fvgAtrMult;
            // Experimental .55 body / max 3 ATR are the user variant, not Pine parity.
            // Lifecycle above is deliberately unchanged, including mitigated FVG -> iFVG.
            const qualityReady = !policy.fvgQuality || (
                Number.isFinite(currentAtr) && currentAtr > 0 &&
                [c2, c1, c0].every(isValidImpulseCandle) &&
                c2.timestamp < c1.timestamp && c1.timestamp < c0.timestamp &&
                c1.high > c1.low && Math.abs(c1.close - c1.open) / (c1.high - c1.low) >= policy.fvg.minBodyFraction
            );
            const qualityGap = (gap: number) => qualityReady && (!policy.fvgQuality || gap <= currentAtr * policy.fvg.maxAtr);

            // Detección FVG Alcista
            if (!hasTimeGap && c0.low > c2.high) {
                const gapSize = c0.low - c2.high;
                if (gapSize >= minGapSize && qualityGap(gapSize) && (preset.require_displacement ? c1.close > c1.open : true)) {
                    const fvg: Imbalance = {
                        id: `FVG-BULL-${c1.timestamp}`,
                        timestamp: c1.timestamp,
                        ...(policy.experimental ? { availableAt: c0.timestamp } : {}),
                        direction: 'Bullish',
                        top: c0.low,
                        bottom: c2.high,
                        originalTop: c0.low,
                        originalBottom: c2.high,
                        mitigated: false,
                        is_ifvg: false
                    };
                    this.activeFVGs.push(fvg);
                    events.push({ type: 'EVENT_FVG_CREATED', fvg });
                }
            }

            // Detección FVG Bajista
            if (!hasTimeGap && c0.high < c2.low) {
                const gapSize = c2.low - c0.high;
                if (gapSize >= minGapSize && qualityGap(gapSize) && (preset.require_displacement ? c1.close < c1.open : true)) {
                    const fvg: Imbalance = {
                        id: `FVG-BEAR-${c1.timestamp}`,
                        timestamp: c1.timestamp,
                        ...(policy.experimental ? { availableAt: c0.timestamp } : {}),
                        direction: 'Bearish',
                        top: c2.low,
                        bottom: c0.high,
                        originalTop: c2.low,
                        originalBottom: c0.high,
                        mitigated: false,
                        is_ifvg: false
                    };
                    this.activeFVGs.push(fvg);
                    events.push({ type: 'EVENT_FVG_CREATED', fvg });
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
