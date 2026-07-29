import { OHLCV, OrderBlock, SMCPreset } from '../types.js';
export interface OBContext {
    vwapStatus?: 'OVER' | 'UNDER';
    currentTrend?: 'Bullish' | 'Bearish' | 'Neutral';
    simpleTrend?: 'Bullish' | 'Bearish' | 'Neutral';
    hasIFVGOverlap?: (top: number, bottom: number, isBull: boolean) => boolean;
    zScore?: number | null;
    isExhaustionZone?: boolean;  // 🆕 E5: |Z| ≥ 2.0 → precio en banda K=2 del VWAP
    crtOrigin?: boolean;         // 🆕 E1: patrón CRT de 3 velas en origen del BOS/CHoCH
    isCoiled?: boolean;          // 🆕 E2: rango comprimido antes de la ruptura
    htfTrend?: 'Bullish' | 'Bearish' | 'Neutral';
    weeklyBias?: 'Bullish' | 'Bearish' | 'Neutral';
    isLegacy?: boolean;
    isChoch?: boolean;
    hasFvgNear?: boolean;
    htfAligned?: (isBull: boolean) => boolean;
}

export class OrderBlockEngine {
    private history: OHLCV[] = [];
    public activeOBs: OrderBlock[] = [];
    
    public get activeBreakers(): OrderBlock[] {
        return this.activeOBs.filter(ob => ob.category === 'Breaker' && !ob.mitigated);
    }

    private obAtrMultiplier: number = 1.2;

    public updateHistory(candle: OHLCV) {
        this.history.push(candle);
        if (this.history.length > 300) {
            this.history.shift();
        }
    }

    public evaluateZones(candle: OHLCV, currentAtr: number, preset: SMCPreset, maxActiveOBs: number = 50, maxTouches: number = 4): Array<any> {
        const events: any[] = [];
        const pendingBreakers: OrderBlock[] = []; // E6: don't mutate activeOBs while iterating
        this.activeOBs.forEach(ob => {
            ob.ageBars = (ob.ageBars || 0) + 1;
            if (preset.max_ob_age && ob.ageBars > preset.max_ob_age) {
                ob.mitigated = true;
                return;
            }
            if (ob.mitigated) return; // 🆕 Breakers ya no se saltan, se evalúan para re-test e invalidación

            if (ob.direction === 'Bullish') {
                if (candle.low <= ob.top) { // Check intersection instead of exact bottom
                    const wickBreak = preset.wick_invalidates_ob && candle.low < ob.bottom;
                    if (candle.close < ob.bottom || wickBreak) { // Break
                        events.push({ type: 'ZONE_BROKEN', direction: ob.direction, category: ob.category, score: ob.score, top: ob.top, bottom: ob.bottom });
                        
                        // 🆕 Solo creamos un Breaker si el OB original NO era ya un Breaker
                        if (ob.category !== 'Breaker' && (!preset.strict_breaker || this.isDisplacement(candle, currentAtr, 'Bearish'))) {
                            const brk: OrderBlock = { ...ob, category: 'Breaker', direction: 'Bearish', id: `BRK-BEAR-${candle.timestamp}`, mitigated: false, touchCount: 0, ageBars: 0 };
                            pendingBreakers.push(brk);
                            events.push({ type: 'EVENT_BREAKER_CREATED', ob: brk });
                        }
                        ob.mitigated = true;
                    } else { // Just a touch
                        events.push({ type: 'ZONE_TOUCHED', direction: ob.direction, category: ob.category, score: ob.score, top: ob.top, bottom: ob.bottom });
                        ob.touchCount = (ob.touchCount || 0) + 1;
                        if (ob.touchCount >= maxTouches) {
                            ob.mitigated = true;
                        }
                    }
                }
            } else if (ob.direction === 'Bearish') {
                if (candle.high >= ob.bottom) { // Check intersection
                    const wickBreak = preset.wick_invalidates_ob && candle.high > ob.top;
                    if (candle.close > ob.top || wickBreak) { // Break
                        events.push({ type: 'ZONE_BROKEN', direction: ob.direction, category: ob.category, score: ob.score, top: ob.top, bottom: ob.bottom });
                        
                        // 🆕 Solo creamos un Breaker si el OB original NO era ya un Breaker
                        if (ob.category !== 'Breaker' && (!preset.strict_breaker || this.isDisplacement(candle, currentAtr, 'Bullish'))) {
                            const brk: OrderBlock = { ...ob, category: 'Breaker', direction: 'Bullish', id: `BRK-BULL-${candle.timestamp}`, mitigated: false, touchCount: 0, ageBars: 0 };
                            pendingBreakers.push(brk);
                            events.push({ type: 'EVENT_BREAKER_CREATED', ob: brk });
                        }
                        ob.mitigated = true;
                    } else { // Just a touch
                        events.push({ type: 'ZONE_TOUCHED', direction: ob.direction, category: ob.category, score: ob.score, top: ob.top, bottom: ob.bottom });
                        ob.touchCount = (ob.touchCount || 0) + 1;
                        if (ob.touchCount >= maxTouches) {
                            ob.mitigated = true;
                        }
                    }
                }
            }
        });
        if (pendingBreakers.length > 0) this.activeOBs.unshift(...pendingBreakers);

        // 🆕 N5: un breaker mitigado/invalidado tampoco debe seguir en activeOBs
        this.activeOBs = this.activeOBs.filter(ob => !ob.mitigated);

        const normalOBs = this.activeOBs.filter(ob => ob.category !== 'Breaker');
        if (normalOBs.length > maxActiveOBs) {
            // Remove the oldest (first elements) of normal OBs
            const toRemove = normalOBs.slice(0, normalOBs.length - maxActiveOBs);
            const toRemoveIds = new Set(toRemove.map(o => o.id));
            this.activeOBs = this.activeOBs.filter(o => !toRemoveIds.has(o.id));
        }

        const breakerOBs = this.activeOBs.filter(ob => ob.category === 'Breaker');
        if (breakerOBs.length > 8) { // max active breakers hardcoded to 8 in pine
            // 🆕 N5: el frente del array es lo más RECIENTE (los breakers nuevos entran por unshift),
            // así que se eliminan los más antiguos (la cola) y se conservan los 8 más recientes
            const toRemove = breakerOBs.slice(8);
            const toRemoveIds = new Set(toRemove.map(o => o.id));
            this.activeOBs = this.activeOBs.filter(o => !toRemoveIds.has(o.id));
        }

        return events;
    }

    private hasAdjacentFVG(obIdx: number, isBull: boolean, atr: number, minAtr: number): boolean {
        for (let k = 0; k <= 2; k++) {
            const older = this.history[obIdx + k], newer = this.history[obIdx + k + 2];
            if (!older || !newer) break;
            if (isBull  && newer.low  > older.high && (newer.low - older.high) > atr * minAtr) return true;
            if (!isBull && newer.high < older.low  && (older.low - newer.high) > atr * minAtr) return true;
        }
        return false;
    }

    private mergeOB(ob: OrderBlock, preset: SMCPreset, currentAtr: number): OrderBlock[] {
        if (!preset.merge_tolerance_atr) return [ob];
        
        const tolerance = preset.merge_tolerance_atr * currentAtr;
        for (const existing of this.activeOBs) {
            if (!existing.mitigated && existing.direction === ob.direction && existing.category !== 'Breaker') {
                if (ob.bottom <= existing.top + tolerance && ob.top >= existing.bottom - tolerance) {
                    existing.top = Math.max(existing.top, ob.top);
                    existing.bottom = Math.min(existing.bottom, ob.bottom);
                    existing.score = Math.max(existing.score, ob.score);
                    existing.merged = true;
                    return [];
                }
            }
        }
        return [ob];
    }

    public createStructuralOB(ev: any, currentAtr: number, preset: SMCPreset, context?: OBContext): OrderBlock[] {
        if (this.history.length < 5) return [];
        const isBull = ev.direction === 'Bullish';
        const breakIdx = this.history.length - 1;
        let extremeIdx = breakIdx;
        
        for (let i = breakIdx - 1; i >= Math.max(0, breakIdx - 20); i--) {
            if (isBull && this.history[i].low < this.history[extremeIdx].low) extremeIdx = i;
            if (!isBull && this.history[i].high > this.history[extremeIdx].high) extremeIdx = i;
        }

        let obCandleIdx = extremeIdx;
        let maxObVol = -1; // E1: allow selecting zero-volume opposite candles
        const searchStart = Math.max(0, extremeIdx - 5);
        
        for (let i = extremeIdx; i >= searchStart; i--) {
            const c = this.history[i];
            const isOpposite = isBull ? c.close < c.open : c.close > c.open;
            if (isOpposite) {
                const bodySize = Math.abs(c.close - c.open);
                const totalSize = c.high - c.low;
                const bodyPct = totalSize > 0 ? bodySize / totalSize : 0;
                
                if (!preset.min_ob_body_pct || bodyPct >= preset.min_ob_body_pct) {
                    if (c.volume > maxObVol) {
                        maxObVol = c.volume;
                        obCandleIdx = i;
                    }
                }
            }
        }

        if (preset.require_fvg_after_ob && !this.hasAdjacentFVG(obCandleIdx, isBull, currentAtr, preset.fvg_min_atr ?? 0.1)) return [];

        const obCandle = this.history[obCandleIdx];
        const dispCandle = this.history[breakIdx];
        // E2: skip doji/flat OB candles (zero-height zone when use_body_for_ob is on)
        const obRange = obCandle.high - obCandle.low;
        const obBody = Math.abs(obCandle.close - obCandle.open);
        if (obRange <= 0 || obBody / obRange < (preset?.min_ob_body_pct ?? 0.1)) return [];
        
        // VWAP Hard Filter
        const vwapZoneValid = isBull
            ? context?.vwapStatus === 'UNDER'   // Discount para longs
            : context?.vwapStatus === 'OVER';   // Premium para shorts

        if (context?.vwapStatus && !vwapZoneValid) {
            return []; // No crear OB fuera de zona VWAP correcta
        }
        const useBodyForOB = preset.use_body_for_ob !== undefined ? preset.use_body_for_ob : true;
        const obTop = isBull ? (useBodyForOB ? Math.max(obCandle.open, obCandle.close) : obCandle.high) : obCandle.high;
        const obBtm = isBull ? obCandle.low : (useBodyForOB ? Math.min(obCandle.open, obCandle.close) : obCandle.low);

        const swp = extremeIdx >= 2 && (isBull 
            ? this.history[extremeIdx].low < this.history[extremeIdx - 1].low && this.history[extremeIdx].low < this.history[extremeIdx - 2].low
            : this.history[extremeIdx].high > this.history[extremeIdx - 1].high && this.history[extremeIdx].high > this.history[extremeIdx - 2].high
        );

        let sumVol = 0;
        for (let i = searchStart; i <= breakIdx; i++) sumVol += this.history[i].volume;
        const avgVol = sumVol / Math.max(1, breakIdx - searchStart + 1);

        const isChoch = ev.type === 'EVENT_CHOCH';
        const structContext = { ...context, isChoch };
        const score = this.calculateScore(obCandle, dispCandle, swp, isBull, avgVol, structContext);
        const category = isChoch ? 'CHoCH' : this.scoreToMedal(score);

        const ob: OrderBlock = {
            id: `OB-${isBull ? 'BULL' : 'BEAR'}-${obCandle.timestamp}`,
            timestamp: obCandle.timestamp,
            direction: isBull ? 'Bullish' : 'Bearish',
            top: obTop,
            bottom: obBtm,
            mitigated: false,
            score: score,
            category: category,
            merged: false,
            touchCount: 0,
            ageBars: 0
        };
        const result = this.mergeOB(ob, preset, currentAtr);
        if (result.length > 0) {
            // E8: two consecutive BOS can pick the same OB candle — don't stack duplicates
            if (this.activeOBs.some(o => o.id === ob.id)) return [];
            this.activeOBs.push(ob);
        }
        return result;
    }

    public createLegacyOB(fvg: any, currentAtr: number, preset: SMCPreset, context?: OBContext): OrderBlock[] {
        if (this.history.length < 5) return [];
        const isBull = fvg.direction === 'Bullish';
        const breakIdx = this.history.length - 1;
        let extremeIdx = breakIdx;
        
        for (let i = breakIdx - 1; i >= Math.max(0, breakIdx - 10); i--) {
            if (isBull && this.history[i].low < this.history[extremeIdx].low) extremeIdx = i;
            if (!isBull && this.history[i].high > this.history[extremeIdx].high) extremeIdx = i;
        }

        let obCandleIdx = extremeIdx;
        let maxObVol = -1; // E1: allow selecting zero-volume opposite candles
        const searchStart = Math.max(0, extremeIdx - 5);
        
        for (let i = extremeIdx; i >= searchStart; i--) {
            const c = this.history[i];
            const isOpposite = isBull ? c.close < c.open : c.close > c.open;
            if (isOpposite) {
                const bodySize = Math.abs(c.close - c.open);
                const totalSize = c.high - c.low;
                const bodyPct = totalSize > 0 ? bodySize / totalSize : 0;
                
                // DeepSeek Fix D6: Aplicar min_ob_body_pct a Legacy OBs
                if (!preset.min_ob_body_pct || bodyPct >= preset.min_ob_body_pct) {
                    if (c.volume > maxObVol) {
                        maxObVol = c.volume;
                        obCandleIdx = i;
                    }
                }
            }
        }

        const obCandle = this.history[obCandleIdx];
        const dispCandle = this.history[breakIdx];
        // E2: skip doji/flat OB candles (zero-height zone when use_body_for_ob is on)
        const obRange = obCandle.high - obCandle.low;
        const obBody = Math.abs(obCandle.close - obCandle.open);
        if (obRange <= 0 || obBody / obRange < (preset?.min_ob_body_pct ?? 0.1)) return [];

        // VWAP Hard Filter
        const vwapZoneValid = isBull
            ? context?.vwapStatus === 'UNDER'
            : context?.vwapStatus === 'OVER';

        if (context?.vwapStatus && !vwapZoneValid) {
            return [];
        }
        const useBodyForOB = preset.use_body_for_ob !== undefined ? preset.use_body_for_ob : true;
        const obTop = isBull ? (useBodyForOB ? Math.max(obCandle.open, obCandle.close) : obCandle.high) : obCandle.high;
        const obBtm = isBull ? obCandle.low : (useBodyForOB ? Math.min(obCandle.open, obCandle.close) : obCandle.low);

        const swp = extremeIdx >= 2 && (isBull 
            ? this.history[extremeIdx].low < this.history[extremeIdx - 1].low && this.history[extremeIdx].low < this.history[extremeIdx - 2].low
            : this.history[extremeIdx].high > this.history[extremeIdx - 1].high && this.history[extremeIdx].high > this.history[extremeIdx - 2].high
        );

        let sumVol = 0;
        for (let i = searchStart; i <= breakIdx; i++) sumVol += this.history[i].volume;
        const avgVol = sumVol / Math.max(1, breakIdx - searchStart + 1);

        const legacyContext = { ...context, isLegacy: true };
        const score = this.calculateScore(obCandle, dispCandle, swp, isBull, avgVol, legacyContext);

        const ob: OrderBlock = {
            id: `OB-LEGACY-${isBull ? 'BULL' : 'BEAR'}-${obCandle.timestamp}`,
            timestamp: obCandle.timestamp,
            direction: isBull ? 'Bullish' : 'Bearish',
            top: obTop,
            bottom: obBtm,
            mitigated: false,
            score: score,
            category: 'Legacy',
            merged: false,
            touchCount: 0,
            ageBars: 0
        };
        const result = this.mergeOB(ob, preset, currentAtr);
        if (result.length > 0) {
            // E8: two consecutive BOS can pick the same OB candle — don't stack duplicates
            if (this.activeOBs.some(o => o.id === ob.id)) return [];
            this.activeOBs.push(ob);
        }
        return result;
    }

    private isDisplacement(candle: OHLCV, atr: number, direction: 'Bullish' | 'Bearish'): boolean {
        const bodySize = Math.abs(candle.close - candle.open);
        const minBody = atr * this.obAtrMultiplier;
        
        if (bodySize < minBody) return false;
        
        if (direction === 'Bullish') return candle.close > candle.open;
        if (direction === 'Bearish') return candle.close < candle.open;
        
        return false;
    }

    private scoreToMedal(score: number): 'Plata' | 'Oro' | 'Platino' | 'Diamante' {
        if (score >= 9) return 'Platino';
        if (score >= 7) return 'Oro';
        return 'Plata';
    }

    private calculateScore(obCandle: any, _dispCandle: any, swp: boolean, isBull: boolean, avgVol: number, context?: OBContext): number {
        let score = (context?.isLegacy || context?.isChoch) ? 0 : 2; 
        
        if (swp) { score += 2; }
        if (context?.hasFvgNear) { score += 1; }
        if (obCandle.volume > avgVol * 1.5) { score += 1; }

        // 🆕 Disc 5 Fix: las anotaciones estructurales ahora impactan el score
        if (context?.crtOrigin) { score += 2; }   // CRT: alta probabilidad direccional
        if (context?.isCoiled)  { score += 3; }    // Coiled: tasa de fakeout casi nula
        if (context?.isExhaustionZone) { score += 1; } // Banda K=2: agotamiento institucional
        
        if (context?.vwapStatus) {
            if ((isBull && context.vwapStatus === 'UNDER') || (!isBull && context.vwapStatus === 'OVER')) {
                score += 1;
            }
        }

        if (context?.htfTrend) {
            // Se debe verificar cómo se evalúa htfAligned, o usar htfTrend directamente
            if (isBull && context.htfTrend === 'Bullish') { score += 2; }
            else if (!isBull && context.htfTrend === 'Bearish') { score += 2; }
        }

        if (context?.hasIFVGOverlap) {
            const obTop = isBull ? obCandle.high : Math.max(obCandle.open, obCandle.close);
            const obBtm = isBull ? Math.min(obCandle.open, obCandle.close) : obCandle.low;
            if (context.hasIFVGOverlap(obTop, obBtm, isBull)) {
                score += 2;
            }
        }

        return Math.min(10, score);
    }
}
