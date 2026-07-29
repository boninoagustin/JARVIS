// src/engine/smc/modules/market_structure.ts
import { OHLCV, Pivot, Direction, SMCPreset, SMCEvents } from '../types.js';

const HISTORY_CAP = 150;
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
    private chochReqSweep: boolean = false;
    private chochReqMom: boolean = false;
    private chochReqBosPrior: boolean = false;  // 🆕 E6: exige BOS previo para CHoCH

    constructor() {
        // Gates are now read from preset in processCandle
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
        currentAtr: number = 0,
        options: { zScore?: number | null; sweepEscapeDir?: Direction | null; crtValid?: boolean } = {}
    ): Array<(SMCEvents['EVENT_BOS'] & { type: 'EVENT_BOS' }) | (SMCEvents['EVENT_CHOCH'] & { type: 'EVENT_CHOCH' })> {
        
        const events: any[] = [];
        const zScore = options.zScore ?? null;
        const sweepEscapeDir = options.sweepEscapeDir ?? null;
        const crtOrigin = options.crtValid ?? false;     // 🆕 E1
        
        // 🆕 S9: sincronizar gates desde preset en cada llamada
        this.chochReqSweep = preset.choch_require_sweep ?? false;
        this.chochReqMom = preset.choch_require_momentum ?? false;
        this.chochReqBosPrior = preset.choch_require_bos_prior ?? false;  // 🆕 E6
        
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
            const breakH = this.activeSwingHigh && this.checkBreak(candle, this.activeSwingHigh.price, true, preset.confirm_close);
            const breakL = this.activeSwingLow && this.checkBreak(candle, this.activeSwingLow.price, false, preset.confirm_close);

            let applyH = breakH;
            let applyL = breakL;
            if (breakH && breakL) {
                if (candle.close > candle.open) applyL = false;
                else applyH = false;
            }

            if (applyH && this.activeSwingHigh) {
                const breakBar = this.findFirstBreakBar(this.activeSwingHigh.timestamp, this.activeSwingHigh.price, true) || candle;
                const coiled = this.detectCoiled(this.activeSwingHigh.timestamp);  // 🆕 E2
                this.activeSwingHigh.isBroken = true;
                this.currentTrend = 'Bullish';
                this.trendExtreme = breakBar.high;
                const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingHigh.timestamp, true, breakBar);
                events.push({ type: 'EVENT_CHOCH', direction: 'Bullish', price: this.activeSwingHigh.price, timestamp: breakBar.timestamp, origin, extreme, originTs, extremeTs, crtOrigin, isCoiled: coiled });
            } else if (applyL && this.activeSwingLow) {
                const breakBar = this.findFirstBreakBar(this.activeSwingLow.timestamp, this.activeSwingLow.price, false) || candle;
                const coiled = this.detectCoiled(this.activeSwingLow.timestamp);  // 🆕 E2
                this.activeSwingLow.isBroken = true;
                this.currentTrend = 'Bearish';
                this.trendExtreme = breakBar.low;
                const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingLow.timestamp, false, breakBar);
                events.push({ type: 'EVENT_CHOCH', direction: 'Bearish', price: this.activeSwingLow.price, timestamp: breakBar.timestamp, origin, extreme, originTs, extremeTs, crtOrigin, isCoiled: coiled });
            }
            return events;
        }

        // Evaluar BOS y CHoCH si ya tenemos tendencia
        if (this.currentTrend === 'Bullish') {
            const breakH = this.activeSwingHigh && !this.activeSwingHigh.isBroken && this.checkBreak(candle, this.activeSwingHigh.price, true, preset.confirm_close);
            const breakL = this.activeSwingLow && !this.activeSwingLow.isBroken && this.checkBreak(candle, this.activeSwingLow.price, false, preset.confirm_close);

            // 🆕 S9/N1: el swing de BOS también se difiere hasta pasar el
            // desempate y el filtro de displacement (antes quedaba consumido sin evento).
            let applyH = breakH; // BOS
            let applyL = breakL; // CHoCH

            if (breakH && breakL) {
                if (candle.close > candle.open) applyL = false;
                else applyH = false;
            }

            if (applyH && this.activeSwingHigh) {
                if (preset.valid_bos_displacement && !this.isDisplacement(candle, currentAtr, zScore, 'Bullish')) applyH = false;
            }
            if (applyL && this.activeSwingLow) {
                if (preset.valid_bos_displacement && !this.isDisplacement(candle, currentAtr, zScore, 'Bearish')) applyL = false;
            }

            if (applyH && this.activeSwingHigh) {
                // 🆕 FP1 Fix: timestamp real del primer break, no de la confirmación del pivote
                const breakBar = this.findFirstBreakBar(this.activeSwingHigh.timestamp, this.activeSwingHigh.price, true) || candle;
                const coiled = this.detectCoiled(this.activeSwingHigh.timestamp);  // 🆕 E2
                this.activeSwingHigh.isBroken = true;
                this.lastBOS = this.activeSwingHigh;
                this.trendExtreme = breakBar.high;
                const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingHigh.timestamp, true, breakBar);
                events.push({ type: 'EVENT_BOS', direction: 'Bullish', price: this.activeSwingHigh.price, timestamp: breakBar.timestamp, origin, extreme, originTs, extremeTs, crtOrigin, isCoiled: coiled });
            } else if (applyL && this.activeSwingLow) {
                const breakBar = this.findFirstBreakBar(this.activeSwingLow.timestamp, this.activeSwingLow.price, false) || candle;
                const coiled = this.detectCoiled(this.activeSwingLow.timestamp);  // 🆕 E2
                const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingLow.timestamp, false, breakBar);
                if (this.passesChochGates(origin, false, zScore, sweepEscapeDir)) {
                    // 🆕 S9: solo ahora marcamos el swing como roto (gate pasó)
                    this.activeSwingLow.isBroken = true;
                    this.lastCHoCH = this.activeSwingLow;
                    this.currentTrend = 'Bearish';
                    this.trendExtreme = breakBar.low;
                    events.push({ type: 'EVENT_CHOCH', direction: 'Bearish', price: this.activeSwingLow.price, timestamp: breakBar.timestamp, origin, extreme, originTs, extremeTs, crtOrigin, isCoiled: coiled });
                    // 🆕 Disc 4 Fix: al revertir tendencia, el BOS previo pertenecía a la tendencia anterior.
                    // Para el próximo CHoCH se necesita un NUEVO BOS en la tendencia actual.
                    this.lastBOS = null;
                }
                // Si el gate falla, el swing LOW NO se marca como roto → puede re-evaluarse
            }
        } else if (this.currentTrend === 'Bearish') {
            const breakH = this.activeSwingHigh && !this.activeSwingHigh.isBroken && this.checkBreak(candle, this.activeSwingHigh.price, true, preset.confirm_close);
            const breakL = this.activeSwingLow && !this.activeSwingLow.isBroken && this.checkBreak(candle, this.activeSwingLow.price, false, preset.confirm_close);

            // 🆕 S9/N1: el swing de BOS también se difiere hasta pasar el
            // desempate y el filtro de displacement (antes quedaba consumido sin evento).
            let applyH = breakH; // CHoCH
            let applyL = breakL; // BOS

            if (breakH && breakL) {
                if (candle.close < candle.open) applyH = false;
                else applyL = false;
            }

            if (applyL && this.activeSwingLow) {
                if (preset.valid_bos_displacement && !this.isDisplacement(candle, currentAtr, zScore, 'Bearish')) applyL = false;
            }
            if (applyH && this.activeSwingHigh) {
                if (preset.valid_bos_displacement && !this.isDisplacement(candle, currentAtr, zScore, 'Bullish')) applyH = false;
            }

            if (applyL && this.activeSwingLow) {
                // 🆕 FP1 Fix: timestamp real del primer break
                const breakBar = this.findFirstBreakBar(this.activeSwingLow.timestamp, this.activeSwingLow.price, false) || candle;
                const coiled = this.detectCoiled(this.activeSwingLow.timestamp);  // 🆕 E2
                this.activeSwingLow.isBroken = true;
                this.lastBOS = this.activeSwingLow;
                this.trendExtreme = breakBar.low;
                const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingLow.timestamp, false, breakBar);
                events.push({ type: 'EVENT_BOS', direction: 'Bearish', price: this.activeSwingLow.price, timestamp: breakBar.timestamp, origin, extreme, originTs, extremeTs, crtOrigin, isCoiled: coiled });
            } else if (applyH && this.activeSwingHigh) {
                const breakBar = this.findFirstBreakBar(this.activeSwingHigh.timestamp, this.activeSwingHigh.price, true) || candle;
                const coiled = this.detectCoiled(this.activeSwingHigh.timestamp);  // 🆕 E2
                const { origin, extreme, originTs, extremeTs } = this.computeOriginExtreme(this.activeSwingHigh.timestamp, true, breakBar);
                if (this.passesChochGates(origin, true, zScore, sweepEscapeDir)) {
                    // 🆕 S9: solo ahora marcamos el swing como roto (gate pasó)
                    this.activeSwingHigh.isBroken = true;
                    this.lastCHoCH = this.activeSwingHigh;
                    this.currentTrend = 'Bullish';
                    this.trendExtreme = breakBar.high;
                    events.push({ type: 'EVENT_CHOCH', direction: 'Bullish', price: this.activeSwingHigh.price, timestamp: breakBar.timestamp, origin, extreme, originTs, extremeTs, crtOrigin, isCoiled: coiled });
                    // 🆕 Disc 4 Fix: resetear BOS previo al revertir tendencia
                    this.lastBOS = null;
                }
                // Si el gate falla, el swing HIGH NO se marca como roto → puede re-evaluarse
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
    private passesChochGates(origin: number, isBullishReversal: boolean, zScore: number | null, sweepEscapeDir: Direction | null): boolean {
        // 🆕 Disc 4 Fix: compuerta secuencial — exige BOS previo en la tendencia que se revierte.
        // Un CHoCH alcista (revierte Bearish → Bullish) requiere un BOS bajista previo.
        // Un CHoCH bajista (revierte Bullish → Bearish) requiere un BOS alcista previo.
        if (this.chochReqBosPrior) {
            if (this.lastBOS === null) return false;
            const bosDir: Direction = this.lastBOS.type === 'High' ? 'Bullish' : 'Bearish';
            const expectedBosDir: Direction = isBullishReversal ? 'Bearish' : 'Bullish';
            if (bosDir !== expectedBosDir) return false;
        }

        if (this.chochReqSweep && this.trendExtreme !== null) {
            const sweptExtreme = isBullishReversal ? origin <= this.trendExtreme : origin >= this.trendExtreme;
            const sweepActive = sweepEscapeDir === (isBullishReversal ? 'Bullish' : 'Bearish');
            const sweptLiq = sweptExtreme || sweepActive;
            
            if (!sweptLiq) return false;
        }
        if (this.chochReqMom) {
            const hasMomentum = zScore !== null && Math.abs(zScore) >= 1.5;
            if (!hasMomentum) return false;
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

    /*
    private getActiveSweepEscapeDir(_candle: OHLCV, _preset: SMCPreset): Direction | null {
        // En una implementación real, esto leería del módulo de liquidez
        // Por ahora lo simplificamos a null ya que se maneja a nivel superior
        return null;
    }
    */

    /**
     * 🆕 FP4 Fix: Validación de desplazamiento institucional por Z-Score.
     * La teoría (Sección 3) define el desplazamiento como una desviación
     * estadística ≥ 2.0σ del valor justo (VWAP), no como un umbral fijo
     * de ATR. El ATR*1.2 se mantiene como fallback si no hay Z-Score
     * disponible (warm-up del calculador).
     */
    /**
     * 🆕 E2: Detector de Rangos Comprimidos (Coiled Range).
     * Si antes de la ruptura encontramos ≥ 3 velas consecutivas cuyos cuerpos
     * están completamente contenidos dentro del rango [low, high] de una vela
     * "madre", el rompimiento tiene tasa de fakeout casi nula.
     *
     * @param pivotTs timestamp del pivote roto (para delimitar la ventana)
     * @returns true si el rango previo a la ruptura está comprimido
     */
    private detectCoiled(pivotTs: number): boolean {
        const window = this.history.filter(c => c.timestamp >= pivotTs);
        if (window.length < 4) return false; // mínimo 1 madre + 3 contenidas

        // La vela madre es la primera del rango (la que contiene a las demás)
        const mother = window[0];
        const motherHigh = mother.high;
        const motherLow = mother.low;
        let containedCount = 0;

        for (let i = 1; i < window.length; i++) {
            const c = window[i];
            const cBodyHigh = Math.max(c.open, c.close);
            const cBodyLow = Math.min(c.open, c.close);
            if (cBodyHigh <= motherHigh && cBodyLow >= motherLow) {
                containedCount++;
                if (containedCount >= 3) return true;
            } else {
                containedCount = 0; // reset si una vela rompe el rango
            }
        }
        return false;
    }

    private isDisplacement(candle: OHLCV, atr: number, zScore: number | null, direction: 'Bullish' | 'Bearish'): boolean {
        // Si hay Z-Score, es el filtro primario (teoría)
        if (zScore !== null) {
            const absZ = Math.abs(zScore);
            const correctDirection = direction === 'Bullish' ? zScore > 0 : zScore < 0;
            return absZ >= 2.0 && correctDirection;
        }
        // Fallback: ATR*1.2 solo durante warm-up del Z-Score
        const bodySize = Math.abs(candle.close - candle.open);
        if (bodySize < atr * 1.2) return false;
        if (direction === 'Bullish') return candle.close > candle.open;
        if (direction === 'Bearish') return candle.close < candle.open;
        return false;
    }

    private checkBreak(candle: OHLCV, priceLevel: number, isUp: boolean, _confirmClose: boolean): boolean {
        // La teoría exige CIERRE, no mecha, independientemente de confirm_close
        return isUp ? candle.close > priceLevel : candle.close < priceLevel;
    }

    /**
     * 🆕 FP1 Fix: Cuando un pivote se confirmó con retraso (rightLen barras),
     * busca la PRIMERA barra en la ventana de confirmación que rompió el nivel.
     * Así el BOS/CHoCH recibe el timestamp correcto del break original,
     * no el de la vela actual (que puede estar 5 barras después).
     *
     * Esto elimina el "lag estructural": el evento se ancla temporalmente
     * donde realmente ocurrió la ruptura, no donde se confirmó el pivote.
     */
    private findFirstBreakBar(
        pivotTs: number,
        priceLevel: number,
        isBullishBreak: boolean
    ): OHLCV | null {
        // Buscar desde la barra posterior al pivote hasta la actual (exclusive)
        const candidates = this.history.filter(
            c => c.timestamp > pivotTs
        );

        for (const c of candidates) {
            const broke = isBullishBreak
                ? c.close > priceLevel
                : c.close < priceLevel;
            if (broke) return c; // primera barra que rompe
        }

        return null; // no debería pasar si checkBreak ya dio true
    }
}
