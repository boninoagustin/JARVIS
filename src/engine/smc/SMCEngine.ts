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
    private preset: SMCPreset;
    private state: SMCState;
    private previousCandle?: OHLCV;

    // Math Modules
    private atr: ATRCalculator;
    private rsi: RSICalculator;
    private vwap: VWAPCalculator;
    private zscore: ZScoreCalculator;

    // Core Modules
    private pivots: PivotEngine;
    private structure: MarketStructureEngine;
    private orderBlocks: OrderBlockEngine;
    private imbalances: ImbalanceEngine;
    private liquidity: LiquidityEngine;
    private divergence: DivergenceEngine;

    // Internal Variables
    private currentAtrValue: number = 0;
    // 🆕 RSI indexado por timestamp de vela (lookup O(1) para divergencias).
    // Reemplaza al array rsiHistory: elimina la ambigüedad de timestamps duplicados
    // y el find() lineal sobre el buffer.
    private rsiByTimestamp = new Map<number, number>();
    private static readonly RSI_BUFFER_SIZE = 200;

    constructor(presetName: string = 'Forex - 3. Balanceado') {
        this.preset = getPreset(presetName);

        this.state = {
            pivotsHigh: [],
            pivotsLow: [],
            activeOBs: [],
            activeFVGs: [],
            currentTrend: 'Neutral'
        };

        this.atr = new ATRCalculator(14);
        this.rsi = new RSICalculator(14);
        this.vwap = new VWAPCalculator();
        this.zscore = new ZScoreCalculator(20);

        this.pivots = new PivotEngine(5, 5);
        this.structure = new MarketStructureEngine();
        this.orderBlocks = new OrderBlockEngine();
        this.imbalances = new ImbalanceEngine();
        this.liquidity = new LiquidityEngine();
        this.divergence = new DivergenceEngine();
    }

    /**
     * Reconfigura el motor para usar otro preset dinámicamente (Útil para backtesting).
     */
    public setPreset(presetName: string) {
        this.preset = getPreset(presetName);
    }

    /**
     * Retorna el estado actual del mercado (Zonas vivas, estructura, etc.)
     */
    public getState(): SMCState {
        // Sincronizar estado interno con el estado de los motores
        this.state.activeOBs = this.orderBlocks.activeOBs;
        this.state.activeFVGs = this.imbalances.activeFVGs;
        this.state.currentTrend = this.structure.currentTrend;
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
        
        this.vwap.nextValue(candle);
        this.zscore.nextValue(candle.close);

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

        // 3. Market Structure Update
        const structEvents = this.structure.processCandle(candle, this.state.pivotsHigh, this.state.pivotsLow, this.preset);
        events.push(...structEvents);

        // Reset VWAP en BOS o CHoCH
        if (structEvents.length > 0) {
            this.vwap.reset();
        }

        // 4. Order Blocks & Imbalances Update
        const obEvents = this.orderBlocks.processCandle(candle, this.currentAtrValue, this.preset);
        events.push(...obEvents);

        const fvgEvents = this.imbalances.processCandle(candle, this.currentAtrValue, this.preset);
        events.push(...fvgEvents);

        // 5. Liquidity Sweeps Update
        const liqEvents = this.liquidity.processCandle(candle);
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
