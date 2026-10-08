import { SMCEngine } from './SMCEngine.js';
import { OHLCV } from './types.js';
import { broadcastCandle, broadcastEvent, broadcastState } from '../../services/ws_server.js';
import { loadOptimizedPreset } from './smc_config.js';
class SMCManager {
    private engines: Map<string, SMCEngine> = new Map();

    constructor() {
        // 🆕 Marca de versión (sep-2026): confirma en el log que el proceso vivo carga
        // el código con la telemetría de gates anti-whipsaw (grep: [SMC-MANAGER]).
        console.log('[SMC-MANAGER] 📡 Telemetría de gates anti-whipsaw ACTIVA (sep-2026)');
    }

    // 🆕 Fase 1: listeners de eventos del motor (SMCBridge los usa para alimentar a JARVIS)
    private listeners: Array<(key: string, candle: OHLCV, events: any[], isHistorical: boolean) => void> = [];
    private forming = new Map<string, OHLCV>();

    public addListener(fn: (key: string, candle: OHLCV, events: any[], isHistorical: boolean) => void) {
        this.listeners.push(fn);
    }

    public getEngines(): ReadonlyMap<string, SMCEngine> {
        return this.engines;
    }

    public getEngine(ticker: string, period: string): SMCEngine {
        const key = `${ticker}:${period}`;
        if (!this.engines.has(key)) {
            let basePresetName = 'Forex - 3. Balanceado';
            if (['H1', 'H4', 'D1', 'W1'].includes(period) || ['60', '240', 'D'].includes(period)) {
                basePresetName = 'Forex - 5. Ultra Agresivo';
            }
            const preset = loadOptimizedPreset(ticker, period, basePresetName);
            const engine = new SMCEngine(preset, period);
            engine.label = ticker; // 🆕 telemetría de gates: incluir ticker en los logs
            if (['M5', 'M15', 'M30', 'H1', 'H4'].includes(period)) {
                const wBias = this.engines.get(`${ticker}:W1`)?.getState().simpleTrend || 'Neutral';
                const targetHTF = period === 'H1' ? 'D1' : period === 'M15' || period === 'M30' ? 'H4' : 'W1';
                const htfTrend = this.engines.get(`${ticker}:${targetHTF}`)?.getState().simpleTrend || 'Neutral';
                engine.setHTFContext(htfTrend, wBias);
            }
            this.engines.set(key, engine);
        }
        return this.engines.get(key)!;
    }

    public getAllStates(): Record<string, any> {
        const states: Record<string, any> = {};
        for (const [key, engine] of this.engines.entries()) {
            states[key] = engine.getState();
        }
        return states;
    }

    public getScannerStates(): Record<string, any> {
        const states: Record<string, any> = {};
        for (const [key, engine] of this.engines.entries()) {
            const s = engine.getState();
            states[key] = {
                currentTrend: s.currentTrend,
                obCount: s.activeOBs.length,
                topOB: s.activeOBs[0] ?? null,
                fvgCount: s.activeFVGs.length,
                hasIFVG: s.activeFVGs.some(f => f.is_ifvg),
                lastBOS: s.lastBOS ?? null,
                lastCHoCH: s.lastCHoCH ?? null,
                lastSweep: s.lastSweep ?? null,
                lastDivergence: s.lastDivergence ?? null
            };
        }
        return states;
    }

    public processLiveCandles(ticker: string, period: string, newCandles: OHLCV[], isHistorical: boolean = false) {
        const key = `${ticker}:${period}`;
        const engine = this.getEngine(ticker, period);

        // Sort chronologically (oldest first). cTrader sends newest-first;
        // processing in that order corrupts `forming` and breaks the loop.
        const sorted = [...newCandles].sort((a, b) => a.timestamp - b.timestamp);
        for (const candle of sorted) {
            const prev = this.forming.get(key);
            if (prev && candle.timestamp > prev.timestamp) {
                // Skip engine call if it already processed this timestamp or newer
                // (avoids eternal dedupe when historical load leaves previousCandle ahead of forming)
                const lastTs = engine.lastProcessedTs;
                const skipEngine = !isHistorical && lastTs !== undefined && prev.timestamp <= lastTs;
                if (!skipEngine) {
                    const events = engine.nextCandle(prev);
                    // 🔍 DIAGNÓSTICO: loguear eventos generados por el engine
                    if (!isHistorical && events.length > 0) {
                        const types = [...new Set(events.map((e: any) => e.type))];
                        console.log(`[SMC-MANAGER] 📤 ${key}: ${events.length} eventos (${types.join(',')})`);
                    }
                    // 🔧 FIX (19-ago): llamar a los listeners SIEMPRE (no solo con eventos).
                    // El listener de SMCBridge ingesta la vela cerrada al bridge TimesFM
                    // ANTES de iterar eventos; si solo se llama con eventos, las velas
                    // "silenciosas" (sin CHoCH/BOS/zona) no llegan al bridge y el forecast
                    // envejece → el filtro degrada por stale. Con events=[] no se
                    // despacha ninguna alerta, así que el cambio es seguro.
                    for (const listener of this.listeners) {
                        try {
                            listener(key, prev, events, isHistorical);
                        } catch (err: any) {
                            console.error('[SMC-MANAGER] Error en listener:', err.message);
                        }
                    }
                    if (!isHistorical) {
                        for (const event of events) {
                            broadcastEvent(key, event);
                        }
                    }
                }
            }
            // 🔧 Monotonic forming: solo actualizar si la vela es más nueva.
            // cTrader reenvía el mismo batch → sin esta guarda, forming oscila
            // hacia atrás en cada batch repetido y los eventos nunca se generan.
            const curForming = this.forming.get(key);
            if (!curForming || candle.timestamp >= curForming.timestamp) {
                this.forming.set(key, candle);
            }
            if (!isHistorical) {
                broadcastCandle(key, candle);
            }
        }

        const state = engine.getState();
        broadcastState(key, state);

        const htfMap: Record<string, string[]> = {
            'W1': ['D1', 'H4', 'H1', 'M30', 'M15', 'M5'],
            'D1': ['H1'],
            'H4': ['M30', 'M15']
        };
        if (htfMap[period]) {
            for (const tf of htfMap[period]) {
                const targetEngine = this.engines.get(`${ticker}:${tf}`);
                if (targetEngine) {
                    const wBias = this.engines.get(`${ticker}:W1`)?.getState().simpleTrend || 'Neutral';
                    const targetHTF = tf === 'H1' ? 'D1' : tf === 'M15' || tf === 'M30' ? 'H4' : 'W1';
                    const htfTrend = this.engines.get(`${ticker}:${targetHTF}`)?.getState().simpleTrend || 'Neutral';
                    targetEngine.setHTFContext(htfTrend, wBias);
                }
            }
        }
    }
}

export const smcManager = new SMCManager();
