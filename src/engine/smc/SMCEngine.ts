// src/engine/smc/SMCEngine.ts
import { OHLCV, SMCState, SMCPreset } from './types.js';
import { getPreset } from './smc_config.js';
import { ATRCalculator } from './math/atr.js';
import { RSICalculator } from './math/rsi.js';
import { VWAPCalculator } from './math/vwap.js';
import { ZScoreCalculator } from './math/zscore.js';

import { PivotEngine } from './modules/pivots.js';
import { MarketStructureEngine } from './modules/market_structure.js';
import { OrderBlockEngine } from './modules/order_blocks.js';
import { ImbalanceEngine } from './modules/imbalances.js';
import { LiquidityEngine } from './modules/liquidity.js';
import { DivergenceEngine } from './modules/divergence.js';

export class SMCEngine {
    private state: SMCState;
    private previousCandle?: OHLCV;

    // Math Modules
    private atr: ATRCalculator;
    private rsi: RSICalculator;
    private vwap: VWAPCalculator;
    private zscore: ZScoreCalculator;

    private pivots: PivotEngine;
    private preset: SMCPreset;
    public period: string;
    
    // Sub-modules
    public orderBlocks: OrderBlockEngine;
    private structure: MarketStructureEngine;
    private imbalances: ImbalanceEngine;
    private liquidity: LiquidityEngine;
    private divergence: DivergenceEngine;

    // Internal Variables
    private currentAtrValue: number = 0;
    private lastVwapValue: number = 0;
    private prevVwapValue: number = 0;
    private lastZScoreUp: number | null = null;
    private lastZScoreDn: number | null = null;
    
    private currentTrend: 'Bullish' | 'Bearish' | 'Neutral' = 'Neutral';
    private simpleTrend: 'Bullish' | 'Bearish' | 'Neutral' = 'Neutral';
    public weeklyBias: string = 'Neutral';
    private htfTrend: 'Bullish' | 'Bearish' | 'Neutral' = 'Neutral';
    private pivotEngine33: PivotEngine;
    private lastPivotHigh33: number = NaN;
    private lastPivotLow33: number = NaN;
    private strBars: number = 5;
    // 🆕 RSI indexado por timestamp de vela (lookup O(1) para divergencias).
    // Reemplaza al array rsiHistory: elimina la ambigüedad de timestamps duplicados
    // y el find() lineal sobre el buffer.
    private rsiByTimestamp = new Map<number, number>();
    private static readonly RSI_BUFFER_SIZE = 200;

    public constructor(preset: SMCPreset | string, period: string = '1h') {
        if (typeof preset === 'string') {
            this.preset = getPreset(preset);
        } else {
            this.preset = preset;
        }
        this.period = period;

        this.state = {
            pivotsHigh: [],
            pivotsLow: [],
            activeOBs: [],
            activeBreakers: [],
            activeFVGs: [],
            currentTrend: 'Neutral'
        };

        this.atr = new ATRCalculator(14);
        this.rsi = new RSICalculator(14);
        this.vwap = new VWAPCalculator();
        this.zscore = new ZScoreCalculator(20);

        this.updateStrBars(period, this.preset);

        this.pivots = new PivotEngine(this.strBars, this.strBars);
        this.pivotEngine33 = new PivotEngine(3, 3);
        this.structure = new MarketStructureEngine();
        this.orderBlocks = new OrderBlockEngine();
        this.imbalances = new ImbalanceEngine();
        this.liquidity = new LiquidityEngine();
        this.divergence = new DivergenceEngine();
    }

    /**
     * Reconfigura el motor para usar otro preset dinámicamente (Útil para backtesting).
     */
    public setHTFContext(htfTrend: string, weeklyBias: string) {
        this.htfTrend = htfTrend as 'Bullish' | 'Bearish' | 'Neutral';
        this.weeklyBias = weeklyBias;
    }

    public setPreset(presetName: string) {
        this.preset = getPreset(presetName);
        this.updateStrBars(this.period, this.preset);
        // We might need to re-initialize pivot engine if str_bars changes, but usually preset is set once at startup.
        this.pivots = new PivotEngine(this.strBars, this.strBars);
    }

    private updateStrBars(period: string, preset: SMCPreset) {
        // Auto-detect timeframe multiplier
        let isIntraday = true;
        let multiplier = 60; // default 1h
        if (period.endsWith('m')) multiplier = parseInt(period.replace('m', ''));
        else if (period.endsWith('h')) multiplier = parseInt(period.replace('h', '')) * 60;
        else if (period.endsWith('d') || period.endsWith('D')) {
            multiplier = 1440;
            isIntraday = false;
        }

        let dynStrBars = 6;
        if (isIntraday) {
            if (multiplier <= 5) dynStrBars = 6;
            else if (multiplier <= 30) dynStrBars = 6;
            else if (multiplier <= 120) dynStrBars = 8;
            else dynStrBars = 10;
        } else {
            dynStrBars = 12;
        }

        // Apply risk adjustments
        // Risk level 3 is Balanced (no adjustment)
        const riskLvl = preset.risk_level || 3;
        const riskAdj = (3 - riskLvl) * 2;
        dynStrBars = Math.max(3, dynStrBars + riskAdj);

        this.strBars = dynStrBars;
    }

    /**
     * Retorna el estado actual del mercado (Zonas vivas, estructura, etc.)
     */
    public getState(): SMCState {
        // Sincronizar estado interno con el estado de los motores
        this.state.activeOBs = this.orderBlocks.activeOBs;
        this.state.activeBreakers = this.orderBlocks.activeBreakers;
        this.state.activeFVGs = this.imbalances.activeFVGs;
        this.state.currentTrend = this.structure.currentTrend;
        this.state.simpleTrend = this.simpleTrend as 'Bullish' | 'Bearish' | 'Neutral';
        this.state.atr = this.currentAtrValue;
        this.state.lastBOS = this.structure.lastBOS || undefined;
        this.state.lastCHoCH = this.structure.lastCHoCH || undefined;
        return this.state;
    }

    /**
     * Punto de entrada principal. Se llama con cada nueva vela (histórica o en vivo).
     * Devuelve una lista de todos los eventos SMC disparados en esta vela.
     */
    public nextCandle(candle: OHLCV): any[] {
        const events: any[] = [];

        // 🆕 Dedupe: el stream en vivo reenvía la vela en formación con el mismo
        // timestamp varias veces. Reprocesarla corrompe RSI/ATR (Wilder) y puede
        // duplicar pivots/eventos. La actualización visual de la vela viva va por
        // broadcastCandle en SMCManager, no necesita pasar por el motor.
        if (this.previousCandle && candle.timestamp === this.previousCandle.timestamp) {
            return events;
        }

        // 1. Math Update
        const atrVal = this.atr.nextValue(candle, this.previousCandle);
        if (atrVal !== null) this.currentAtrValue = atrVal;
        
        const rsiVal = this.rsi.nextValue(candle.close, this.previousCandle?.close);
        if (rsiVal !== null) {
            this.rsiByTimestamp.set(candle.timestamp, rsiVal);
            if (this.rsiByTimestamp.size > SMCEngine.RSI_BUFFER_SIZE) {
                // Map preserva orden de inserción: borrar el más viejo
                const oldestKey = this.rsiByTimestamp.keys().next().value!;
                this.rsiByTimestamp.delete(oldestKey);
            }
        }
        
        this.prevVwapValue = this.lastVwapValue;
        this.lastVwapValue = this.vwap.nextValue(candle);
        const zs = this.zscore.nextValue(candle);
        if (zs) {
            this.lastZScoreUp = zs.zUp;
            this.lastZScoreDn = zs.zDn;
        }

        // 2. Pivots Update
        const newPivot = this.pivots.nextCandle(candle);
        if (newPivot) {
            if (newPivot.type === 'High') {
                this.state.pivotsHigh.push(newPivot);
            } else {
                this.state.pivotsLow.push(newPivot);
            }
            // Enviar Pivot a Liquidity Engine
            this.liquidity.registerPivot(newPivot, this.currentAtrValue);
            
            // Evaluar Divergencias
            const divEvent = this.divergence.processPivot(newPivot, this.rsiByTimestamp);
            if (divEvent) {
                events.push({
                    type: 'EVENT_DIVERGENCE',
                    direction: divEvent.direction,
                    divergenceType: divEvent.type,
                    timestamp: divEvent.timestamp
                });
                this.state.lastDivergence = divEvent;
            }
        }

        // 2.1 Simple Trend Update
        const pivot33 = this.pivotEngine33.nextCandle(candle);
        if (pivot33) {
            if (pivot33.type === 'High') this.lastPivotHigh33 = pivot33.price;
            else this.lastPivotLow33 = pivot33.price;
            
            if (!Number.isNaN(this.lastPivotHigh33) && !Number.isNaN(this.lastPivotLow33)) {
                if (candle.close > this.lastPivotHigh33) this.simpleTrend = 'Bullish';
                else if (candle.close < this.lastPivotLow33) this.simpleTrend = 'Bearish';
            }
        }

        // 3. Market Structure Update
        const structEvents = this.structure.processCandle(candle, this.state.pivotsHigh, this.state.pivotsLow, this.preset);
        events.push(...structEvents);

        // Reset VWAP en BOS o CHoCH
        if (structEvents.length > 0) {
            this.vwap.reset();
        }

        // 4. Order Blocks & Imbalances Update
        this.orderBlocks.updateHistory(candle);
        
        const fvgEvents = this.imbalances.processCandle(candle, this.currentAtrValue, this.preset);
        events.push(...fvgEvents);

        const prevHl2 = this.previousCandle ? (this.previousCandle.high + this.previousCandle.low) / 2 : (candle.high + candle.low) / 2;
        const zScoreObj = this.lastZScoreUp !== null && this.lastZScoreDn !== null 
            ? { zUp: this.lastZScoreUp, zDn: this.lastZScoreDn } 
            : null;
            
        const obContext = {
            vwapStatus: this.prevVwapValue > 0 ? (prevHl2 > this.prevVwapValue ? 'OVER' : 'UNDER') : undefined,
            currentTrend: this.structure.currentTrend,
            simpleTrend: this.simpleTrend,
            hasIFVGOverlap: (top: number, bottom: number, isBull: boolean) => this.imbalances.activeFVGs.some(
                f => f.is_ifvg && f.direction === (isBull ? 'Bullish' : 'Bearish') && !(top < f.bottom || bottom > f.top)
            ),
            zScore: zScoreObj,
            htfTrend: this.htfTrend,
            weeklyBias: this.weeklyBias,
            htfAligned: (isBull: boolean) => {
                const targetDir = isBull ? 'Bullish' : 'Bearish';
                const isHtf2 = this.htfTrend === targetDir;
                const isWBias = this.weeklyBias === targetDir;
                
                if (['H1', 'H4', 'D1', 'W1'].includes(this.period)) {
                    return isHtf2 || isWBias;
                } else {
                    return isHtf2;
                }
            }
        };

        const obEvents = this.orderBlocks.evaluateZones(candle, this.currentAtrValue, this.preset);
        events.push(...obEvents);
        
        // Generate Structural OBs on BOS or CHoCH
        for (const ev of structEvents) {
            if (ev.type === 'EVENT_BOS' || ev.type === 'EVENT_CHOCH') {
                const newOBs = this.orderBlocks.createStructuralOB(ev, this.currentAtrValue, this.preset, obContext as any);
                events.push(...newOBs);
            }
        }

        // Generate Legacy OBs for new FVGs
        for (const ev of fvgEvents) {
            if (ev.type === 'EVENT_FVG_CREATED') {
                const newOBs = this.orderBlocks.createLegacyOB(ev.fvg, this.currentAtrValue, this.preset, obContext as any);
                events.push(...newOBs);
            }
        }


        // 5. Liquidity Sweeps Update
        const liqEvents = this.liquidity.processCandle(candle, this.currentAtrValue, this.preset);
        events.push(...liqEvents);
        
        for (const ev of liqEvents) {
            this.state.lastSweep = {
                direction: ev.direction,
                type: ev.type,
                timestamp: ev.timestamp
            };
        }

        // Cleanup: Mantener máximo 500 pivots para no saturar memoria
        if (this.state.pivotsHigh.length > 500) this.state.pivotsHigh.shift();
        if (this.state.pivotsLow.length > 500) this.state.pivotsLow.shift();

        this.previousCandle = candle;
        return events;
    }
}
