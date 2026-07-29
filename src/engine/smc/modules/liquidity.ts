import { OHLCV, Pivot, SMCEvents } from '../types.js';
import { PivotEngine } from './pivots.js';
import { ZScoreCalculator } from '../math/zscore.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ASIA_START_HOUR = 18; // inclusive (18:00 NY)
const ASIA_END_HOUR = 0;    // exclusive (00:00 NY)

// E7: formatter cacheado para extraer la fecha/hora NY sin reparsear strings
// (el reparseo con new Date(str) dependía del TZ del servidor y derivaba con DST)
const NY_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function getNyParts(timestamp: number): { year: number, month: number, day: number, hour: number, minute: number } {
    const parts = NY_FORMATTER.formatToParts(timestamp);
    const get = (type: string) => parseInt(parts.find(p => p.type === type)!.value, 10);
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

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
    private zscore: ZScoreCalculator;

    // 🆕 FP2 Fix: Buffer de sweeps pendientes de confirmación de cierre.
    // En tiempo real, la vela actual no tiene close definitivo. Un sweep
    // detectado intrabarra podría invalidarse si el close final retrocede
    // por debajo del nivel barrido. Diferir la emisión 1 barra elimina
    // el repainting: solo se emite cuando el close ES definitivo.
    private pendingSweepBull: { price: number; sweepType: 'CRT' | 'LIQ_GRAB'; candle: OHLCV } | null = null;
    private pendingSweepBear: { price: number; sweepType: 'CRT' | 'LIQ_GRAB'; candle: OHLCV } | null = null;

    public get sweepBullActive(): boolean {
        return (this.barCount - this.lastSweepDirBar.Bullish) < LiquidityEngine.SWEEP_COOLDOWN_BARS;
    }

    public get sweepBearActive(): boolean {
        return (this.barCount - this.lastSweepDirBar.Bearish) < LiquidityEngine.SWEEP_COOLDOWN_BARS;
    }
    
    private prevCandle: OHLCV | null = null;

    // 🆕 E3: Ventana deslizante para el modelo CRT estricto de 3 velas.
    // La teoría define:
    //   Vela 1 (Referencia)  — define el rango [low..high]
    //   Vela 2 (Purga)       — barre un extremo de Vela 1
    //   Vela 3 (Re-entrada)  — cierra dentro del rango de Vela 1, cuerpo opuesto
    //   Regla intermedia: ninguna vela entre Vela 1 y Vela 2 puede cerrar
    //   su cuerpo fuera de los límites de Vela 1.
    private crtWindow: OHLCV[] = [];
    private static readonly CRT_MAX_WINDOW = 10; // máximo de velas intermedias entre V1 y V2

    public constructor(zscore: ZScoreCalculator, strBars: number = 5) {
        this.zscore = zscore;
        this.swingPivots = new PivotEngine(strBars, strBars);
    }

    /**
     * 🆕 E1: Detecta si las últimas 3 velas forman un patrón CRT válido.
     * Usado por SMCEngine para etiquetar BOS/CHoCH con crtOrigin=true.
     */
    public hasActiveCRTPattern(): boolean {
        const w = this.crtWindow;
        if (w.length < 3) return false;
        const v1 = w[w.length - 3], v2 = w[w.length - 2], v3 = w[w.length - 1];
        const v1BodyHigh = Math.max(v1.open, v1.close);
        const v1BodyLow = Math.min(v1.open, v1.close);
        // CRT alcista: V2 barre low de V1, V3 cierra dentro del cuerpo
        const bullCRT = v2.low < v1.low && v3.close >= v1BodyLow && v3.close <= v1BodyHigh && v3.close > v3.open;
        // CRT bajista: V2 barre high de V1, V3 cierra dentro del cuerpo
        const bearCRT = v2.high > v1.high && v3.close >= v1BodyLow && v3.close <= v1BodyHigh && v3.close < v3.open;
        return bullCRT || bearCRT;
    }

    public hasNearbyLevel(price: number, type: 'High' | 'Low', tolerance: number): boolean {
        if (type === 'High') {
            return (!Number.isNaN(this.dailyHigh) && Math.abs(price - this.dailyHigh) <= tolerance) ||
                   (!Number.isNaN(this.h4High) && Math.abs(price - this.h4High) <= tolerance) ||
                   (!Number.isNaN(this.asiaHigh) && Math.abs(price - this.asiaHigh) <= tolerance) ||
                   (!Number.isNaN(this.lastSwingHigh) && Math.abs(price - this.lastSwingHigh) <= tolerance);
        } else {
            return (!Number.isNaN(this.dailyLow) && Math.abs(price - this.dailyLow) <= tolerance) ||
                   (!Number.isNaN(this.h4Low) && Math.abs(price - this.h4Low) <= tolerance) ||
                   (!Number.isNaN(this.asiaLow) && Math.abs(price - this.asiaLow) <= tolerance) ||
                   (!Number.isNaN(this.lastSwingLow) && Math.abs(price - this.lastSwingLow) <= tolerance);
        }
    }

    /**
     * 🆕 E3: Validador CRT estricto según teoría (Regla de las Tres Velas).
     *
     * @param candle    Vela actual = Vela 3 (Re-entrada)
     * @param isBullish true para patrón CRT alcista, false para bajista
     * @returns true si el patrón CRT de 3 velas se cumple estrictamente
     *
     * Estructura:
     *   Vela 1 (Referencia): la más antigua del trío — define [low, high]
     *   Vela 2 (Purga): barre el extremo de Vela 1 (low si alcista, high si bajista)
     *   Vela 3 (Re-entrada = candle): cierra su cuerpo dentro del rango de Vela 1
     *
     *   Regla intermedia: ninguna vela entre V1 y V2 cierra su cuerpo
     *   fuera de [V1.low, V1.high]. Si lo hace, la estructura se invalida.
     */
    private validateCRT(candle: OHLCV, isBullish: boolean): boolean {
        const w = this.crtWindow;
        if (w.length < 3) return false;

        // Vela 1 es la más antigua del trío
        const v1 = w[w.length - 3];
        const v2 = w[w.length - 2];
        // candle es Vela 3 (pasada como parámetro)
        const v1High = v1.high, v1Low = v1.low;
        const v1BodyHigh = Math.max(v1.open, v1.close);
        const v1BodyLow = Math.min(v1.open, v1.close);

        // Filtro de cierre intermedio: ninguna barra entre V1 y V2
        // (exclusive) puede cerrar su cuerpo fuera de [V1.low, V1.high]
        // En el caso mínimo (3 velas en ventana), no hay barras intermedias.
        if (w.length > 3) {
            for (let i = 0; i < w.length - 3; i++) {
                const mid = w[i];
                const midBodyHigh = Math.max(mid.open, mid.close);
                const midBodyLow = Math.min(mid.open, mid.close);
                if (midBodyHigh > v1High || midBodyLow < v1Low) {
                    return false; // cierre de cuerpo fuera del rango de Vela 1
                }
            }
        }

        if (isBullish) {
            // CRT Alcista: V2 barre el LOW de V1, V3 cierra cuerpo DENTRO del rango
            const v2Sweeps = v2.low < v1Low;
            const v3BodyInside = candle.close >= v1BodyLow && candle.close <= v1BodyHigh;
            const v3BullishBody = candle.close > candle.open;
            return v2Sweeps && v3BodyInside && v3BullishBody;
        } else {
            // CRT Bajista: V2 barre el HIGH de V1, V3 cierra cuerpo DENTRO del rango
            const v2Sweeps = v2.high > v1High;
            const v3BodyInside = candle.close >= v1BodyLow && candle.close <= v1BodyHigh;
            const v3BearishBody = candle.close < candle.open;
            return v2Sweeps && v3BodyInside && v3BearishBody;
        }
    }

    private sweepCooldownOk(direction: 'Bullish' | 'Bearish'): boolean {
        return (this.barCount - this.lastSweepDirBar[direction]) >= LiquidityEngine.SWEEP_COOLDOWN_BARS;
    }

    public registerPivot(_pivot: Pivot, _currentAtr: number) {
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
        // E7: pseudo-epoch UTC construido desde las partes NY (+7h) — independiente del TZ del host
        const ny = getNyParts(candle.timestamp);
        const nyShiftedMs = Date.UTC(ny.year, ny.month - 1, ny.day, ny.hour + 7, ny.minute);
        const dayIdx = Math.floor(nyShiftedMs / DAY_MS);

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
        const inH4 = Math.floor(new Date(nyShiftedMs).getUTCHours() / 4);
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

        // Asia: ventana 18:00-00:00 hora NY (getNyParts ya aplica DST correctamente)
        const inAsia = ny.hour >= ASIA_START_HOUR || ny.hour < ASIA_END_HOUR;
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
        preset: any,
        zScoreVal: number | null = null  // 🆕 Bug 2 Fix: recibido de SMCEngine, no calculado internamente
    ): Array<{ type: 'EVENT_SWEEP' } & SMCEvents['EVENT_SWEEP']> {
        const events: any[] = [];
        this.barCount++;

        // 🆕 FP2 Fix: Flush de sweeps pendientes de la barra ANTERIOR.
        // Ahora que estamos en la barra N+1, el close de la barra N es definitivo.
        // Solo emitimos el sweep si el close final REALMENTE validó el barrido.
        if (this.pendingSweepBull) {
            const p = this.pendingSweepBull;
            if (p.candle.close > p.price) {
                events.push({
                    type: 'EVENT_SWEEP', direction: 'Bullish',
                    price: p.price, sweepType: p.sweepType,
                    timestamp: p.candle.timestamp
                });
            }
            this.pendingSweepBull = null;
        }
        if (this.pendingSweepBear) {
            const p = this.pendingSweepBear;
            if (p.candle.close < p.price) {
                events.push({
                    type: 'EVENT_SWEEP', direction: 'Bearish',
                    price: p.price, sweepType: p.sweepType,
                    timestamp: p.candle.timestamp
                });
            }
            this.pendingSweepBear = null;
        }
        
        const totalRange = candle.high - candle.low;
        if (totalRange === 0) {
            this.updateLevels(candle);
            this.prevCandle = candle;
            return events;
        }

        const topWickPct = (candle.high - Math.max(candle.open, candle.close)) / totalRange;
        const bottomWickPct = (Math.min(candle.open, candle.close) - candle.low) / totalRange;

        // 🆕 E3: Alimentar la ventana CRT antes de evaluar
        this.crtWindow.push(candle);
        if (this.crtWindow.length > LiquidityEngine.CRT_MAX_WINDOW) this.crtWindow.shift();

        // PineScript Sweep checks
        const sweepDl = !Number.isNaN(this.dailyLow) && candle.low < this.dailyLow && candle.close > this.dailyLow;
        const sweepDh = !Number.isNaN(this.dailyHigh) && candle.high > this.dailyHigh && candle.close < this.dailyHigh;
        const sweepM4l = !Number.isNaN(this.h4Low) && candle.low < this.h4Low && candle.close > this.h4Low;
        const sweepM4h = !Number.isNaN(this.h4High) && candle.high > this.h4High && candle.close < this.h4High;
        const sweepAsiaL = !Number.isNaN(this.asiaLow) && candle.low < this.asiaLow && candle.close > this.asiaLow;
        const sweepAsiaH = !Number.isNaN(this.asiaHigh) && candle.high > this.asiaHigh && candle.close < this.asiaHigh;
        const sweepSwingL = !Number.isNaN(this.lastSwingLow) && candle.low < this.lastSwingLow && candle.close > this.lastSwingLow;
        const sweepSwingH = !Number.isNaN(this.lastSwingHigh) && candle.high > this.lastSwingHigh && candle.close < this.lastSwingHigh;

        if (currentAtr > 0) {
            // Resolve highest priority sweep
            const currentSweepL = sweepDl ? this.dailyLow : sweepM4l ? this.h4Low : sweepAsiaL ? this.asiaLow : sweepSwingL ? this.lastSwingLow : NaN;
            const currentSweepH = sweepDh ? this.dailyHigh : sweepM4h ? this.h4High : sweepAsiaH ? this.asiaHigh : sweepSwingH ? this.lastSwingHigh : NaN;

            const minWickPct = preset?.min_sweep_wick_pct ?? 0.5;
            const EPSILON = 0.0001;
            const crt3CandleModel = preset?.crt_3candle_model ?? false;

        // Bullish Sweep (Sweeping a Low)
        if (!Number.isNaN(currentSweepL) && (Number.isNaN(this.lastSweptLow) || this.lastSweptLow !== currentSweepL)) {
            const isCrtBigEnough = totalRange >= (currentAtr * 0.5);
            const validBullRej = candle.close > candle.open;
            
            // 🆕 E3: CRT estricto con ventana de 3 velas + filtro intermedio
            const crt3CandleOk = !crt3CandleModel || this.validateCRT(candle, true);
            const isFreshSweep = !Number.isNaN(currentSweepL) && currentSweepL !== this.lastSweptLow;

            const isGrab = isCrtBigEnough && bottomWickPct >= this.grabWickPct && totalRange >= (currentAtr * this.grabAtrMin);
            const isCrtTrap = isFreshSweep && validBullRej && isCrtBigEnough && (bottomWickPct + EPSILON) >= minWickPct && this.sweepCooldownOk('Bullish') && crt3CandleOk;
            
            const isInstitutional = zScoreVal !== null && Math.abs(zScoreVal) >= 2.0;

            if ((isCrtTrap || isGrab) && isInstitutional && this.sweepCooldownOk('Bullish')) {
                this.lastSweptLow = currentSweepL;
                this.lastSweepDirBar.Bullish = this.barCount;
                const sweepType: 'CRT' | 'LIQ_GRAB' = isGrab ? 'LIQ_GRAB' : 'CRT';
                // 🆕 FP2 Fix: NO emitir inmediatamente. Almacenar como pendiente.
                // Se emitirá en la PRÓXIMA barra cuando el close sea definitivo.
                this.pendingSweepBull = { price: currentSweepL, sweepType, candle };
            }
        }

        // Bearish Sweep (Sweeping a High)
        if (!Number.isNaN(currentSweepH) && (Number.isNaN(this.lastSweptHigh) || this.lastSweptHigh !== currentSweepH)) {
            const isCrtBigEnough = totalRange >= (currentAtr * 0.5);
            const validBearRej = candle.close < candle.open;
            
            const crt3CandleOk = !crt3CandleModel || this.validateCRT(candle, false);
            const isFreshSweep = !Number.isNaN(currentSweepH) && currentSweepH !== this.lastSweptHigh;

            const isGrab = isCrtBigEnough && topWickPct >= this.grabWickPct && totalRange >= (currentAtr * this.grabAtrMin);
            const isCrtTrap = isFreshSweep && validBearRej && isCrtBigEnough && (topWickPct + EPSILON) >= minWickPct && this.sweepCooldownOk('Bearish') && crt3CandleOk;
            
            const isInstitutional2 = zScoreVal !== null && Math.abs(zScoreVal) >= 2.0;

            if ((isCrtTrap || isGrab) && isInstitutional2 && this.sweepCooldownOk('Bearish')) {
                this.lastSweptHigh = currentSweepH;
                this.lastSweepDirBar.Bearish = this.barCount;
                const sweepType: 'CRT' | 'LIQ_GRAB' = isGrab ? 'LIQ_GRAB' : 'CRT';
                // 🆕 FP2 Fix: diferir emisión a la barra siguiente
                this.pendingSweepBear = { price: currentSweepH, sweepType, candle };
            }
        }
        } // Close if (currentAtr > 0)

        // Update levels AFTER processing sweeps (PineScript updates ta.pivothigh at the end)
        this.updateLevels(candle);

        this.prevCandle = candle;
        return events;
    }


}
