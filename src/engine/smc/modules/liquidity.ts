import { OHLCV, Pivot, SMCEvents } from '../types.js';
import { PivotEngine } from './pivots.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const H4_MS = 4 * 60 * 60 * 1000;
const ART_OFFSET_HOURS = -3;
const ASIA_START_HOUR = 18; // inclusive (18:00 Local/NY)
const ASIA_END_HOUR = 0;    // exclusive (00:00 Local/NY)

export class LiquidityEngine {
    private grabWickPct: number = 0.6;
    private grabAtrMin: number = 0.5;

    // Tracker for dynamic Swings based on strBars
    private swingPivots: PivotEngine;
    public lastSwingHigh: number = NaN;
    public lastSwingLow: number = NaN;

    // Trackers for Macro Levels
    private curDayIdx: number = -1;
    private cur4HIdx: number = -1;
    private wasInAsia: boolean = false;
    
    // In-progress bars
    private currentDayHigh: number = NaN;
    private currentDayLow: number = NaN;
    private currentDayClose: number = NaN;
    private current4HHigh: number = NaN;
    private current4HLow: number = NaN;
    private current4HClose: number = NaN;
    private currentAsiaHigh: number = NaN;
    private currentAsiaLow: number = NaN;

    // Completed static levels (the ones actually sweepable)
    public dailyHigh: number = NaN;
    public dailyLow: number = NaN;
    public h4High: number = NaN;
    public h4Low: number = NaN;
    public asiaHigh: number = NaN;
    public asiaLow: number = NaN;

    // Sweep tracking
    private barCount: number = 0;
    private lastSweepDirBar: Record<'Bullish' | 'Bearish', number> = { Bullish: -1000, Bearish: -1000 };
    private static readonly SWEEP_COOLDOWN_BARS = 8;
    
    // Last swept levels to prevent duplicate triggers on the EXACT same level
    private lastSweptHigh: number = NaN;
    private lastSweptLow: number = NaN;

    public get sweepBullActive(): boolean {
        return (this.barCount - this.lastSweepDirBar.Bullish) <= LiquidityEngine.SWEEP_COOLDOWN_BARS;
    }

    public get sweepBearActive(): boolean {
        return (this.barCount - this.lastSweepDirBar.Bearish) <= LiquidityEngine.SWEEP_COOLDOWN_BARS;
    }
    
    private prevCandle: OHLCV | null = null;

    constructor(strBars: number = 5) {
        this.swingPivots = new PivotEngine(strBars, strBars);
    }

    public hasNearbyLevel(price: number, type: 'High' | 'Low', tolerance: number): boolean {
        const levels = type === 'High' 
            ? [this.lastSwingHigh, this.dailyHigh, this.h4High, this.asiaHigh]
            : [this.lastSwingLow, this.dailyLow, this.h4Low, this.asiaLow];
            
        return levels.some(l => !Number.isNaN(l) && Math.abs(l - price) <= tolerance);
    }

    private sweepCooldownOk(direction: 'Bullish' | 'Bearish'): boolean {
        return (this.barCount - this.lastSweepDirBar[direction]) >= LiquidityEngine.SWEEP_COOLDOWN_BARS;
    }

    public registerPivot(pivot: Pivot, currentAtr: number) {
        // Deprecated: Swings are now tracked internally via ta.pivothigh(5,5) logic
    }

    private updateLevels(candle: OHLCV) {
        // Swings (5, 5)
        const pivot = this.swingPivots.nextCandle(candle);
        if (pivot) {
            if (pivot.type === 'High') this.lastSwingHigh = pivot.price;
            else this.lastSwingLow = pivot.price;
        }

        // Daily - TradingView aligns forex to NY 17:00
        const d = new Date(candle.timestamp);
        const nyTimeStr = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
        const nyDate = new Date(nyTimeStr);
        nyDate.setHours(nyDate.getHours() + 7);
        const dayIdx = Math.floor(nyDate.getTime() / DAY_MS);

        if (this.curDayIdx === -1) {
            this.curDayIdx = dayIdx;
            this.currentDayHigh = candle.high;
            this.currentDayLow = candle.low;
            this.currentDayClose = candle.close;
        } else if (dayIdx !== this.curDayIdx) {
            const body_broke_up = this.currentDayClose > this.dailyHigh;
            const body_broke_dn = this.currentDayClose < this.dailyLow;
            const engulfed = this.currentDayHigh > this.dailyHigh && this.currentDayLow < this.dailyLow;
            
            if (Number.isNaN(this.dailyHigh) || body_broke_up || body_broke_dn || engulfed) {
                this.dailyHigh = this.currentDayHigh;
                this.dailyLow = this.currentDayLow;
            }
            
            this.curDayIdx = dayIdx;
            this.currentDayHigh = candle.high;
            this.currentDayLow = candle.low;
            this.currentDayClose = candle.close;
        } else {
            this.currentDayHigh = Math.max(this.currentDayHigh, candle.high);
            this.currentDayLow = Math.min(this.currentDayLow, candle.low);
            this.currentDayClose = candle.close;
        }

        // 4H - aligned to NY daily open (17:00 NY)
        const inH4 = Math.floor(nyDate.getHours() / 4);
        if (this.cur4HIdx === -1) {
            this.cur4HIdx = inH4;
            this.current4HHigh = candle.high;
            this.current4HLow = candle.low;
            this.current4HClose = candle.close;
        } else if (inH4 !== this.cur4HIdx) {
            const body_broke_up = this.current4HClose > this.h4High;
            const body_broke_dn = this.current4HClose < this.h4Low;
            const engulfed = this.current4HHigh > this.h4High && this.current4HLow < this.h4Low;
            
            if (Number.isNaN(this.h4High) || body_broke_up || body_broke_dn || engulfed) {
                this.h4High = this.current4HHigh;
                this.h4Low = this.current4HLow;
            }
            
            this.cur4HIdx = inH4;
            this.current4HHigh = candle.high;
            this.current4HLow = candle.low;
            this.current4HClose = candle.close;
        } else {
            this.current4HHigh = Math.max(this.current4HHigh, candle.high);
            this.current4HLow = Math.min(this.current4HLow, candle.low);
            this.current4HClose = candle.close;
        }

        // Asia
        const artHour = ((candle.timestamp / 3600000 + ART_OFFSET_HOURS) % 24 + 24) % 24;
        const inAsia = artHour >= ASIA_START_HOUR || artHour < ASIA_END_HOUR;
        if (inAsia && !this.wasInAsia) {
            this.currentAsiaHigh = candle.high;
            this.currentAsiaLow = candle.low;
        } else if (inAsia) {
            this.currentAsiaHigh = Math.max(this.currentAsiaHigh, candle.high);
            this.currentAsiaLow = Math.min(this.currentAsiaLow, candle.low);
        } else if (!inAsia && this.wasInAsia) {
            this.asiaHigh = this.currentAsiaHigh;
            this.asiaLow = this.currentAsiaLow;
        }
        this.wasInAsia = inAsia;
        
        // PineScript: Se resetean si se rompen
        if (!Number.isNaN(this.lastSwingHigh) && candle.high > this.lastSwingHigh) this.lastSwingHigh = NaN;
        if (!Number.isNaN(this.lastSwingLow) && candle.low < this.lastSwingLow) this.lastSwingLow = NaN;
    }

    public processCandle(
        candle: OHLCV,
        currentAtr: number,
        preset: any
    ): Array<SMCEvents['EVENT_SWEEP']> {
        const events: any[] = [];
        this.barCount++;
        
        this.updateLevels(candle);
        
        const totalRange = candle.high - candle.low;
        if (totalRange === 0) {
            this.prevCandle = candle;
            return events;
        }

        const topWickPct = (candle.high - Math.max(candle.open, candle.close)) / totalRange;
        const bottomWickPct = (Math.min(candle.open, candle.close) - candle.low) / totalRange;

        // 3-Candle Model logic (ICT Purist)
        let validRangeCandle = false;
        let closeInsidePrevBull = false;
        let closeInsidePrevBear = false;

        if (this.prevCandle) {
            const v1Range = this.prevCandle.high - this.prevCandle.low;
            const v1Body = Math.abs(this.prevCandle.open - this.prevCandle.close);
            validRangeCandle = v1Range > 0 ? (v1Body / v1Range) < 0.75 : false;
            
            closeInsidePrevBull = candle.close >= this.prevCandle.low && candle.close <= this.prevCandle.high && candle.close > candle.open;
            closeInsidePrevBear = candle.close >= this.prevCandle.low && candle.close <= this.prevCandle.high && candle.close < candle.open;
        }

        // PineScript Sweep checks
        const sweepDl = !Number.isNaN(this.dailyLow) && candle.low < this.dailyLow && candle.close > this.dailyLow;
        const sweepDh = !Number.isNaN(this.dailyHigh) && candle.high > this.dailyHigh && candle.close < this.dailyHigh;
        const sweepM4l = !Number.isNaN(this.h4Low) && candle.low < this.h4Low && candle.close > this.h4Low;
        const sweepM4h = !Number.isNaN(this.h4High) && candle.high > this.h4High && candle.close < this.h4High;
        const sweepAsiaL = !Number.isNaN(this.asiaLow) && candle.low < this.asiaLow && candle.close > this.asiaLow;
        const sweepAsiaH = !Number.isNaN(this.asiaHigh) && candle.high > this.asiaHigh && candle.close < this.asiaHigh;
        const sweepSwingL = !Number.isNaN(this.lastSwingLow) && candle.low < this.lastSwingLow && candle.close > this.lastSwingLow;
        const sweepSwingH = !Number.isNaN(this.lastSwingHigh) && candle.high > this.lastSwingHigh && candle.close < this.lastSwingHigh;

        // Resolve highest priority sweep
        const currentSweepL = sweepDl ? this.dailyLow : sweepM4l ? this.h4Low : sweepAsiaL ? this.asiaLow : sweepSwingL ? this.lastSwingLow : NaN;
        const currentSweepH = sweepDh ? this.dailyHigh : sweepM4h ? this.h4High : sweepAsiaH ? this.asiaHigh : sweepSwingH ? this.lastSwingHigh : NaN;

        // Bullish Sweep (Sweeping a Low)
        if (!Number.isNaN(currentSweepL) && (Number.isNaN(this.lastSweptLow) || this.lastSweptLow !== currentSweepL)) {
            const isCrtBigEnough = totalRange >= (currentAtr * 0.5);
            const isGrabBigEnough = totalRange >= (currentAtr * 0.5);

            const isGrab = isGrabBigEnough && bottomWickPct >= this.grabWickPct;
            const validBullRej = candle.close > candle.open; // CRT Trap needs rejection body
            
            const minWickPct = preset?.min_sweep_wick_pct || 0 || 0.5;
            const EPSILON = 0.0001;
            const crt3CandleOk = !preset.crt_3candle_model || (validRangeCandle && (!preset.crt_close_inside || closeInsidePrevBull));
            const isFreshSweep = !Number.isNaN(currentSweepL) && currentSweepL !== this.lastSweptLow;
            const isCrtTrap = isFreshSweep && validBullRej && isCrtBigEnough && (bottomWickPct + EPSILON) >= minWickPct && this.sweepCooldownOk('Bullish') && crt3CandleOk;
            
            if(false) console.error(`[SWEEP ATTEMPT BULL] ${new Date(candle.timestamp).toISOString()} isCrtTrap=${isCrtTrap} (validRej=${validBullRej} bigEnough=${isCrtBigEnough} wickPct=${bottomWickPct.toFixed(2)} cooldownOk=${this.sweepCooldownOk('Bullish')} crt3CandleOk=${crt3CandleOk} validRange=${validRangeCandle} closeInside=${closeInsidePrevBull} sweptLevel=${currentSweepL})`);
            if (isCrtTrap) {
                this.lastSweptLow = currentSweepL;
                this.lastSweepDirBar.Bullish = this.barCount;
                events.push({
                    type: 'EVENT_SWEEP',
                    direction: 'Bullish',
                    price: currentSweepL,
                    sweepType: 'CRT',
                    timestamp: candle.timestamp
                });
            }
        }

        // Bearish Sweep (Sweeping a High)
        if (!Number.isNaN(currentSweepH) && (Number.isNaN(this.lastSweptHigh) || this.lastSweptHigh !== currentSweepH)) {
            const isCrtBigEnough = totalRange >= (currentAtr * 0.5);
            const isGrabBigEnough = totalRange >= (currentAtr * 0.5);

            const isGrab = isGrabBigEnough && topWickPct >= this.grabWickPct;
            const validBearRej = candle.close < candle.open; // CRT Trap needs rejection body
            
            const minWickPct = preset?.min_sweep_wick_pct || 0 || 0.5;
            const EPSILON = 0.0001; // Allow for JS float imprecision compared to PineScript
            const crt3CandleOk = !preset.crt_3candle_model || (validRangeCandle && (!preset.crt_close_inside || closeInsidePrevBear));
            const isFreshSweep = !Number.isNaN(currentSweepH) && currentSweepH !== this.lastSweptHigh;
            const isCrtTrap = isFreshSweep && validBearRej && isCrtBigEnough && (topWickPct + EPSILON) >= minWickPct && this.sweepCooldownOk('Bearish') && crt3CandleOk;
            
            if(false) console.error(`[SWEEP ATTEMPT BEAR] ${new Date(candle.timestamp).toISOString()} isCrtTrap=${isCrtTrap} (validRej=${validBearRej} bigEnough=${isCrtBigEnough} wickPct=${topWickPct.toFixed(2)} minWickPct=${minWickPct} cooldownOk=${this.sweepCooldownOk('Bearish')} crt3CandleOk=${crt3CandleOk} preset3=${preset.crt_3candle_model} validRange=${validRangeCandle} closeInside=${closeInsidePrevBear} sweptLevel=${currentSweepH})`);
            
            if (isCrtTrap) {
                this.lastSweptHigh = currentSweepH;
                this.lastSweepDirBar.Bearish = this.barCount;

                events.push({
                    type: 'EVENT_SWEEP',
                    direction: 'Bearish',
                    price: currentSweepH,
                    sweepType: 'CRT',
                    timestamp: candle.timestamp
                });
            }
        }

        // Update levels AFTER processing sweeps (PineScript updates ta.pivothigh at the end)
        this.updateLevels(candle);

        this.prevCandle = candle;
        return events;
    }
}
