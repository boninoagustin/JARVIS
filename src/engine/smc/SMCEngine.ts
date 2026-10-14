// src/engine/smc/SMCEngine.ts
import { OHLCV, SMCPreset, SMCState, SMCEvent } from './types.js';
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

    /** Timestamp de la última vela PROCESADA (no dedupeada). Útil para SMCManager. */
    public get lastProcessedTs(): number | undefined {
        return this.previousCandle?.timestamp;
    }

    // Math Modules
    private atr: ATRCalculator;
    private rsi: RSICalculator;
    private vwap: VWAPCalculator;
    private zscore: ZScoreCalculator;

    private pivots: PivotEngine;
    private rsiPivotEngine: PivotEngine;
    private preset: SMCPreset;
    public period: string;
    /** 🆕 Telemetría (sep-2026): ticker que aloja este engine, seteado por SMCManager. */
    public label: string = '';
    
    // 🆕 Telemetría de gates anti-whipsaw (sep-2026): resumen compacto con rate-limit
    // de 60s por engine (lección del anti-spam ML: nunca una línea por evento/tick).
    private gateTelemetryTs = 0;
    private gateTelemetrySuppressed = 0;
    private gatePrev = { sweep: 0, momentum: 0, bosPrior: 0, displacement: 0 };
    private gateAccepted = 0;
    
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
    private lastVwapStatus?: 'OVER' | 'UNDER';
    private lastZScore: number | null = null;
    
    private simpleTrend: 'Bullish' | 'Bearish' | 'Neutral' = 'Neutral';
    public weeklyBias: string = 'Neutral';
    private htfTrend: 'Bullish' | 'Bearish' | 'Neutral' = 'Neutral';
    private pivotEngine33: PivotEngine;
    private lastPivotHigh33: number = NaN;
    private lastPivotLow33: number = NaN;
    private strBars: number = 5;
    private periodMs: number; // E3/E10: duración nominal del período en ms (timestamps OHLCV están en ms)
    // 🆕 RSI indexado por timestamp de vela (lookup O(1) para divergencias).
    // Reemplaza al array rsiHistory: elimina la ambigüedad de timestamps duplicados
    // y el find() lineal sobre el buffer.
    private rsiByTimestamp = new Map<number, number>();
    private static readonly RSI_BUFFER_SIZE = 200;

    public constructor(preset: SMCPreset | string, period: string = '1h') {
        if (typeof preset === 'string') {
            this.preset = { ...getPreset(preset) };
        } else {
            this.preset = { ...preset };
        }
        this.period = period;
        this.periodMs = SMCEngine.parsePeriodMinutes(period) * 60000;
        this.deriveGates();

        this.state = {
            pivotsHigh: [],
            pivotsLow: [],
            activeOBs: [],
            activeBreakers: [],
            activeFVGs: [],
            currentTrend: 'Neutral'
        };

        this.atr = new ATRCalculator(14);
        this.rsi = new RSICalculator(this.preset.rsi_len ?? 14);
        this.vwap = new VWAPCalculator();
        // Inicialización de Z-Score (V2, no requiere window/decay explícito)
        this.zscore = new ZScoreCalculator();

        this.updateStrBars(period, this.preset);

        this.pivots = new PivotEngine(this.strBars, this.strBars);
        const divLen = this.preset.div_pivot_len || 5;
        this.rsiPivotEngine = new PivotEngine(divLen, divLen);
        this.pivotEngine33 = new PivotEngine(3, 3);
        this.structure = new MarketStructureEngine();
        this.orderBlocks = new OrderBlockEngine();
        this.imbalances = new ImbalanceEngine();
        this.liquidity = new LiquidityEngine(this.zscore);
        this.divergence = new DivergenceEngine(this.periodMs);
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
        this.deriveGates();
        this.updateStrBars(this.period, this.preset);
        // C8: reconstruir todo lo que depende de parámetros del preset.
        // Se pierde el estado interno (p.ej. el RMA de Wilder del RSI): esperado al cambiar de preset.
        this.pivots = new PivotEngine(this.strBars, this.strBars);
        this.rsi = new RSICalculator(this.preset.rsi_len ?? 14);
        this.zscore = new ZScoreCalculator();
        const divLen = this.preset.div_pivot_len || 5;
        this.rsiPivotEngine = new PivotEngine(divLen, divLen);
    }

    /**
     * 🆕 Paridad Pine: deriva los gates anti-whipsaw del motor de estructura a partir
     * del risk_level del preset y del timeframe del engine. El Pine original los
     * auto-deriva (auto_1h/auto_4h/auto_D + risk_lvl); al migrar a TS se perdieron y
     * quedaron apagados, causando flip-flop de tendencia y señales basura en vivo
     * (WR ≈ 0% desde ago-2026).
     *
     * Solo deriva si el preset NO los define explícitamente (override manual > auto).
     * Mapeo fiel a SMC_Master_5.2:
     *   - choch_req_sweep  = risk_lvl <= 2 OR auto_1h OR auto_4h OR auto_D
     *   - choch_req_mom    = risk_lvl == 1 OR auto_4h OR auto_D
     *   - valid_bos_displacement = true (require_displacement default true)
     *   - displ_atr_mult   = dyn_displ = 0.5 (forex) + (3 - risk_lvl) * 0.1
     */
    private deriveGates(): void {
        const pMin = this.periodMs / 60000;
        const isIntraday = pMin < 1440;
        const auto_1h = isIntraday && pMin > 30 && pMin <= 120;
        const auto_4h = isIntraday && pMin > 120;
        const auto_D = pMin >= 1440;
        const rl = this.preset.risk_level;
        if (this.preset.choch_require_sweep === undefined) {
            this.preset.choch_require_sweep = rl <= 2 || auto_1h || auto_4h || auto_D;
        }
        if (this.preset.choch_require_momentum === undefined) {
            this.preset.choch_require_momentum = rl === 1 || auto_4h || auto_D;
        }
        if (this.preset.valid_bos_displacement === undefined) {
            this.preset.valid_bos_displacement = true;
        }
        if (this.preset.displ_atr_mult === undefined) {
            this.preset.displ_atr_mult = 0.5 + (3 - rl) * 0.1;
        }
    }

    // E10: parser único de período — acepta 'M5','H4','D1','W1' (SMCManager) y '5m','4h','1d'
    private static parsePeriodMinutes(period: string): number {
        let m = /^([MHDW])(\d+)$/i.exec(period);          // 'H4', 'D1', 'M15'
        if (m) {
            const n = parseInt(m[2], 10);
            switch (m[1].toUpperCase()) {
                case 'M': return n;
                case 'H': return n * 60;
                case 'D': return n * 1440;
                case 'W': return n * 10080;
            }
        }
        m = /^(\d+)([mhdw])$/i.exec(period);              // '4h', '1d', '15m'
        if (m) {
            const n = parseInt(m[1], 10);
            switch (m[2].toLowerCase()) {
                case 'm': return n;
                case 'h': return n * 60;
                case 'd': return n * 1440;
                case 'w': return n * 10080;
            }
        }
        return 60; // default 1h
    }

    private updateStrBars(period: string, preset: SMCPreset) {
        // Auto-detect timeframe multiplier
        const multiplier = SMCEngine.parsePeriodMinutes(period);
        const isIntraday = multiplier < 1440;

        let dynStrBars: number;
        if (preset.pivot_len !== undefined) {
            // C8: pivot_len del preset sustituye al default por timeframe
            dynStrBars = preset.pivot_len;
        } else if (isIntraday) {
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
        // B3: exponer niveles de liquidez y estatus VWAP (NaN -> undefined)
        this.state.dailyHigh = Number.isNaN(this.liquidity.dailyHigh) ? undefined : this.liquidity.dailyHigh;
        this.state.dailyLow = Number.isNaN(this.liquidity.dailyLow) ? undefined : this.liquidity.dailyLow;
        this.state.asianHigh = Number.isNaN(this.liquidity.asiaHigh) ? undefined : this.liquidity.asiaHigh;
        this.state.asianLow = Number.isNaN(this.liquidity.asiaLow) ? undefined : this.liquidity.asiaLow;
        this.state.vwapStatus = this.lastVwapStatus;
        return this.state;
    }

    /**
     * Punto de entrada principal. Se llama con cada nueva vela (histórica o en vivo).
     * Devuelve una lista de todos los eventos SMC disparados en esta vela.
     */
    public nextCandle(candle: OHLCV): SMCEvent[] {
        const events: SMCEvent[] = [];

        // 🆕 Dedupe: el stream en vivo reenvía la vela en formación con el mismo
        // timestamp varias veces. Reprocesarla corrompe RSI/ATR (Wilder) y puede
        // duplicar pivots/eventos. La actualización visual de la vela viva va por
        // broadcastCandle en SMCManager, no necesita pasar por el motor.
        if (this.previousCandle && candle.timestamp <= this.previousCandle.timestamp) {
            // 🔍 DIAGNÓSTICO: loguear dedupe con timestamp legible
            console.log(`[SMC-ENGINE] ⏭️ Dedupe: ${new Date(candle.timestamp).toISOString().substring(11,19)} <= prev ${new Date(this.previousCandle.timestamp).toISOString().substring(11,19)}`);
            return events;
        }
        // 🔍 DIAGNÓSTICO: loguear vela NUEVA procesada
        console.log(`[SMC-ENGINE] 🕯️ Nueva vela: ${new Date(candle.timestamp).toISOString().substring(11,19)} → generando events...`);

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
            // Feed RSI Pivot Engine
            const rsiPivot = this.rsiPivotEngine.nextCandle({
                timestamp: candle.timestamp,
                open: rsiVal, high: rsiVal, low: rsiVal, close: rsiVal, volume: 0
            });
            if (rsiPivot) {
                const divEvent = this.divergence.addRsiPivot(rsiPivot, this.liquidity, this.currentAtrValue);
                if (divEvent) {
                    events.push({
                        type: 'EVENT_DIVERGENCE',
                        direction: divEvent.direction,
                        divergenceType: divEvent.type,
                        timestamp: candle.timestamp,
                        pivotTimestamp: divEvent.timestamp
                    });
                    this.state.lastDivergence = {
                        ...divEvent,
                        timestamp: candle.timestamp,
                        pivotTimestamp: divEvent.timestamp
                    };
                }
            }
        }
        
        this.prevVwapValue = this.lastVwapValue;
        this.lastVwapValue = this.vwap.nextValue(candle);
        
        // 🆕 Bug 2 Fix: una sola llamada a zscore por vela, resultado compartido
        const zsResult = this.zscore.nextValue(candle);
        const zScoreVal = zsResult?.zScore ?? null;
        const anchoredVwap = zsResult?.vwap ?? this.lastVwapValue;
        const anchoredSigma = zsResult?.sigma ?? 0;
        if (zsResult) this.lastZScore = zsResult.zScore;

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
            const divEvent = this.divergence.processPricePivot(newPivot, this.liquidity, this.currentAtrValue);
            if (divEvent) {
                events.push({
                    type: 'EVENT_DIVERGENCE',
                    direction: divEvent.direction,
                    divergenceType: divEvent.type,
                    timestamp: candle.timestamp,
                    pivotTimestamp: divEvent.timestamp
                });
                this.state.lastDivergence = {
                    ...divEvent,
                    timestamp: candle.timestamp,
                    pivotTimestamp: divEvent.timestamp
                };
            }
        }

        // 2.1 Simple Trend Update
        const pivot33 = this.pivotEngine33.nextCandle(candle);
        if (pivot33) {
            if (pivot33.type === 'High') this.lastPivotHigh33 = pivot33.price;
            else this.lastPivotLow33 = pivot33.price;
        }
        // A5: el close se compara contra los últimos niveles 3/3 en CADA vela,
        // no solo en las que confirman un pivote
        if (!Number.isNaN(this.lastPivotHigh33) && candle.close > this.lastPivotHigh33) this.simpleTrend = 'Bullish';
        else if (!Number.isNaN(this.lastPivotLow33) && candle.close < this.lastPivotLow33) this.simpleTrend = 'Bearish';

        // 3. Market Structure Update
        const zScoreForGates = this.lastZScore !== null ? this.lastZScore : null;
        const sweepEscapeDir = this.liquidity.sweepBullActive ? 'Bullish' as const
            : this.liquidity.sweepBearActive ? 'Bearish' as const
            : null;
        const structEvents = this.structure.processCandle(
            candle, this.state.pivotsHigh, this.state.pivotsLow, this.preset, this.currentAtrValue,
            { zScore: zScoreForGates, sweepEscapeDir, crtValid: this.liquidity.hasActiveCRTPattern() }
        );
        events.push(...structEvents);

        // 🆕 Telemetría de gates (sep-2026): contar aceptados y loguear rechazos (rate-limit 60s).
        // Solo instrumentación — no altera ningún camino de decisión.
        for (const ev of structEvents) {
            if (ev.type === 'EVENT_CHOCH' || ev.type === 'EVENT_BOS') this.gateAccepted++;
        }
        this.logGateTelemetry();

        // Reset VWAP y Z-Score en BOS o CHoCH (Disc 3: anclaje real del Z-Score)
        if (structEvents.length > 0) {
            this.vwap.reset();
            this.zscore.reset();
            // Re-anclar con la vela del evento
            this.lastVwapValue = this.vwap.nextValue(candle);
            const reanchored = this.zscore.nextValue(candle);
            if (reanchored) this.lastZScore = reanchored.zScore;
        }

        // 4. Order Blocks & Imbalances Update
        this.orderBlocks.updateHistory(candle);
        
        let fvgEvents: any[] = [];
        
        if (this.currentAtrValue > 0) {
            fvgEvents = this.imbalances.processCandle(candle, this.currentAtrValue, this.preset, this.periodMs);
            events.push(...fvgEvents);
        }

        const prevHl2 = this.previousCandle ? (this.previousCandle.high + this.previousCandle.low) / 2 : (candle.high + candle.low) / 2;
        const zScoreObj = zScoreVal;  // reutiliza zScoreVal declarado arriba (Bug 2 Fix)

        // B3: guardar el estatus calculado esta vela (undefined durante warm-up)
        this.lastVwapStatus = this.prevVwapValue > 0 ? (prevHl2 > this.prevVwapValue ? 'OVER' : 'UNDER') : undefined;

        // 🆕 E5: exhaustion zone = |Z| ≥ 2.0 (banda K=2 del VWAP adaptativo)
        const isExhaustionZone = zScoreVal !== null && Math.abs(zScoreVal) >= 2.0;

        const obContext = {
            vwapStatus: this.lastVwapStatus,
            currentTrend: this.structure.currentTrend,
            simpleTrend: this.simpleTrend,
            hasIFVGOverlap: (top: number, bottom: number, isBull: boolean) => this.imbalances.activeFVGs.some(
                f => f.is_ifvg && f.direction === (isBull ? 'Bullish' : 'Bearish') && !(top < f.bottom || bottom > f.top)
            ),
            zScore: zScoreObj,
            isExhaustionZone,  // 🆕 E5
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

        if (this.currentAtrValue > 0) {
            const obEvents = this.orderBlocks.evaluateZones(candle, this.currentAtrValue, this.preset, this.preset.max_active_obs ?? 50, this.preset.max_ob_touches ?? 4);
            events.push(...obEvents);
            
            // Generate Structural OBs on BOS or CHoCH
            for (const ev of structEvents) {
                if (ev.type === 'EVENT_BOS' || ev.type === 'EVENT_CHOCH') {
                    const newOBs = this.orderBlocks.createStructuralOB(ev, this.currentAtrValue, this.preset, obContext as any);
                    events.push(...newOBs.map(ob => ({ type: 'EVENT_OB_CREATED' as const, ob })));
                }
            }

            // Generate Legacy OBs for new FVGs
            for (const ev of fvgEvents) {
                if (ev.type === 'EVENT_FVG_CREATED') {
                    const newOBs = this.orderBlocks.createLegacyOB(ev.fvg, this.currentAtrValue, this.preset, obContext as any);
                    events.push(...newOBs.map(ob => ({ type: 'EVENT_OB_CREATED' as const, ob })));
                }
            }
        }


        // 5. Liquidity Sweeps Update
        const liqEvents = this.liquidity.processCandle(candle, this.currentAtrValue, this.preset, zScoreVal);
        events.push(...liqEvents);
        
        for (const ev of liqEvents) {
            this.state.lastSweep = {
                direction: ev.direction,
                type: ev.sweepType ?? 'CRT',
                timestamp: ev.timestamp
            };
        }

        // Cleanup: Mantener máximo 500 pivots para no saturar memoria
        if (this.state.pivotsHigh.length > 500) this.state.pivotsHigh.shift();
        if (this.state.pivotsLow.length > 500) this.state.pivotsLow.shift();

        this.previousCandle = candle;
        return events;
    }

    /**
     * 🆕 Telemetría de gates anti-whipsaw (sep-2026): imprime un resumen compacto de
     * rechazos por motor (label:period). Rate-limit de 60s por engine; los rechazos que
     * caen en la ventana suprimida se acumulan y se reportan en la línea siguiente.
     * Sirve para medir la tasa de filtrado en vivo (chochAtt/displAtt = intentos).
     */
    private logGateTelemetry(): void {
        const rej = this.structure.gateRejects;
        const delta = {
            sweep: rej.sweep - this.gatePrev.sweep,
            momentum: rej.momentum - this.gatePrev.momentum,
            bosPrior: rej.bosPrior - this.gatePrev.bosPrior,
            displacement: rej.displacement - this.gatePrev.displacement,
        };
        this.gatePrev = { ...rej };
        const totalDelta = delta.sweep + delta.momentum + delta.bosPrior + delta.displacement;
        if (totalDelta === 0) return;

        const now = Date.now();
        if (now - this.gateTelemetryTs < 60_000) {
            this.gateTelemetrySuppressed += totalDelta;
            return;
        }
        const sup = this.gateTelemetrySuppressed > 0 ? ` (+${this.gateTelemetrySuppressed} suprimidos)` : '';
        this.gateTelemetrySuppressed = 0;
        this.gateTelemetryTs = now;
        const att = this.structure.gateAttempts;
        console.log(
            `[SMC-GATES] ${this.label || '?'}:${this.period} | rechazos: sweep=${delta.sweep} mom=${delta.momentum} bosPrior=${delta.bosPrior} displ=${delta.displacement}${sup} | aceptados=${this.gateAccepted} | intentos: choch=${att.choch} displ=${att.displacement}`
        );
    }
}
