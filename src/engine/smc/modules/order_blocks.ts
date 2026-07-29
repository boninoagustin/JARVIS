import { OHLCV, OrderBlock, SMCPreset, SMCEvents } from '../types.js';

export interface OBContext {
    vwapStatus?: 'OVER' | 'UNDER';
    currentTrend?: 'Bullish' | 'Bearish' | 'Neutral';
    simpleTrend?: 'Bullish' | 'Bearish' | 'Neutral';
    hasIFVGOverlap?: (top: number, bottom: number, isBull: boolean) => boolean;
    zScore?: { zUp: number, zDn: number } | null;
    htfTrend?: 'Bullish' | 'Bearish' | 'Neutral';
    isLegacy?: boolean;
    isChoch?: boolean;
    hasFvgNear?: boolean;
    htfAligned?: (isBull: boolean) => boolean;
}

export class OrderBlockEngine {
    private history: OHLCV[] = [];
    public activeOBs: OrderBlock[] = [];
    
    public get activeBreakers(): OrderBlock[] {
        return this.activeOBs.filter(ob => ob.category === 'Breaker');
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
        this.activeOBs.forEach(ob => {
            if (ob.mitigated || ob.category === 'Breaker') return;

            if (ob.direction === 'Bullish') {
                if (candle.low <= ob.top) { // Check intersection instead of exact bottom
                    if (candle.close < ob.bottom) { // Break
                        events.push({ type: 'ZONE_BROKEN', direction: ob.direction, category: ob.category, score: ob.score, top: ob.top, bottom: ob.bottom });
                        if (!preset.strict_breaker || this.isDisplacement(candle, currentAtr, 'Bearish')) {
                            const brk: OrderBlock = { ...ob, category: 'Breaker', direction: 'Bearish', id: `BRK-BEAR-${candle.timestamp}`, mitigated: false, touchCount: 0, ageBars: 0 };
                            this.activeOBs.unshift(brk);
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
                    if (candle.close > ob.top) { // Break
                        events.push({ type: 'ZONE_BROKEN', direction: ob.direction, category: ob.category, score: ob.score, top: ob.top, bottom: ob.bottom });
                        if (!preset.strict_breaker || this.isDisplacement(candle, currentAtr, 'Bullish')) {
                            const brk: OrderBlock = { ...ob, category: 'Breaker', direction: 'Bullish', id: `BRK-BULL-${candle.timestamp}`, mitigated: false, touchCount: 0, ageBars: 0 };
                            this.activeOBs.unshift(brk);
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

        this.activeOBs = this.activeOBs.filter(ob => !ob.mitigated || ob.category === 'Breaker');

        const normalOBs = this.activeOBs.filter(ob => ob.category !== 'Breaker');
        if (normalOBs.length > maxActiveOBs) {
            // Remove the oldest (first elements) of normal OBs
            const toRemove = normalOBs.slice(0, normalOBs.length - maxActiveOBs);
            const toRemoveIds = new Set(toRemove.map(o => o.id));
            this.activeOBs = this.activeOBs.filter(o => !toRemoveIds.has(o.id));
        }

        const breakerOBs = this.activeOBs.filter(ob => ob.category === 'Breaker');
        if (breakerOBs.length > 8) { // max active breakers hardcoded to 8 in pine
            const toRemove = breakerOBs.slice(0, breakerOBs.length - 8);
            const toRemoveIds = new Set(toRemove.map(o => o.id));
            this.activeOBs = this.activeOBs.filter(o => !toRemoveIds.has(o.id));
        }

        return events;
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
        let maxObVol = 0;
        const searchStart = Math.max(0, extremeIdx - 5);
        
        for (let i = extremeIdx; i >= searchStart; i--) {
            const c = this.history[i];
            const isOpposite = isBull ? c.close < c.open : c.close > c.open;
            if (isOpposite) {
                if (c.volume > maxObVol) {
                    maxObVol = c.volume;
                    obCandleIdx = i;
                }
            }
        }

        const obCandle = this.history[obCandleIdx];
        const dispCandle = this.history[breakIdx];
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
            touchCount: 0
        };
        this.activeOBs.push(ob);
        return [ob];
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
        let maxObVol = 0;
        const searchStart = Math.max(0, extremeIdx - 5);
        
        for (let i = extremeIdx; i >= searchStart; i--) {
            const c = this.history[i];
            const isOpposite = isBull ? c.close < c.open : c.close > c.open;
            if (isOpposite) {
                if (c.volume > maxObVol) {
                    maxObVol = c.volume;
                    obCandleIdx = i;
                }
            }
        }

        const obCandle = this.history[obCandleIdx];
        const dispCandle = this.history[breakIdx];
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
            touchCount: 0
        };
        this.activeOBs.push(ob);
        return [ob];
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

    private calculateScore(obCandle: any, dispCandle: any, swp: boolean, isBull: boolean, avgVol: number, context?: OBContext): number {
        let score = (context?.isLegacy || context?.isChoch) ? 0 : 2; 
        
        let d_swp=0, d_fvg=0, d_vol=0, d_vwap=0, d_htf=0, d_ifvg=0;

        if (swp) { score += 2; d_swp=2; }
        if (context?.hasFvgNear) { score += 1; d_fvg=1; }
        if (obCandle.volume > avgVol * 1.5) { score += 1; d_vol=1; }
        
        if (context?.vwapStatus) {
            if ((isBull && context.vwapStatus === 'UNDER') || (!isBull && context.vwapStatus === 'OVER')) {
                score += 1; d_vwap=1;
            }
        }

        if (context?.htfAligned) {
            if (context.htfAligned(isBull)) { score += 2; d_htf=2; }
        }

        if (context?.hasIFVGOverlap) {
            const obTop = isBull ? obCandle.high : Math.max(obCandle.open, obCandle.close);
            const obBtm = isBull ? Math.min(obCandle.open, obCandle.close) : obCandle.low;
            if (context.hasIFVGOverlap(obTop, obBtm, isBull)) {
                score += 2; d_ifvg=2;
            }
        }

        return Math.min(10, score);
    }
}
