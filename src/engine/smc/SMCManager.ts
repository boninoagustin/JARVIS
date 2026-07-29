import { SMCEngine } from './SMCEngine.js';
import { OHLCV } from './types.js';
import { broadcastCandle, broadcastEvent, broadcastState } from '../../services/ws_server.js';
import { loadOptimizedPreset } from './smc_config.js';
class SMCManager {
    private engines: Map<string, SMCEngine> = new Map();

    // 🆕 Fase 1: listeners de eventos del motor (SMCBridge los usa para alimentar a JARVIS)
    private listeners: Array<(key: string, candle: OHLCV, events: any[]) => void> = [];

    public addListener(fn: (key: string, candle: OHLCV, events: any[]) => void) {
        this.listeners.push(fn);
    }

    public getEngines(): ReadonlyMap<string, SMCEngine> {
        return this.engines;
    }

    public getEngine(ticker: string, period: string): SMCEngine {
        const key = `${ticker}:${period}`;
        if (!this.engines.has(key)) {
            // Asignar el preset correcto según la temporalidad indicada por el usuario
            let basePresetName = 'Forex - 3. Balanceado';
            if (['H1', 'H4', 'D1', 'W1'].includes(period) || ['60', '240', 'D'].includes(period)) {
                basePresetName = 'Forex - 5. Ultra Agresivo';
            }
            
            // Load the preset directly, overriding with optimized json if available
            const preset = loadOptimizedPreset(ticker, period, basePresetName);
            
            const engine = new SMCEngine(preset, period);
            
            // 🆕 Fase 1: Inyectar sesgo HTF inicial si es un marco menor
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

    /**
     * 🆕 Proyección slim para el scanner WebSocket.
     * SMCState completo incluye pivotsHigh/pivotsLow (hasta 500 c/u por engine):
     * serializar eso cada segundo por cliente saturaba el event loop (~MBs/s).
     * El scanner solo necesita tendencia, contadores y últimos eventos (~300 bytes/key).
     */
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

    public processLiveCandles(ticker: string, period: string, newCandles: OHLCV[]) {
        const key = `${ticker}:${period}`;
        const engine = this.getEngine(ticker, period);

        // Process each candle
        for (const candle of newCandles) {
            const events = engine.nextCandle(candle);
            
            // Broadcast live candle (para actualizar el gráfico)
            broadcastCandle(key, candle);

            // 🆕 Notificar a los listeners (SMCBridge → JARVIS)
            if (events.length > 0) {
                for (const listener of this.listeners) {
                    try {
                        listener(key, candle, events);
                    } catch (err: any) {
                        console.error('[SMC-MANAGER] Error en listener:', err.message);
                    }
                }
            }

            // Si se dispararon eventos, retransmitirlos todos
            for (const event of events) {
                broadcastEvent(key, event);
            }
        }
        
        // Retransmitir el estado actualizado si hubo un cierre de vela o un evento importante
        const state = engine.getState();
        broadcastState(key, state);

        // 🆕 Fase 1: Propagar el sesgo HTF según el mapeo de temporalidades de Pine
        const htfMap: Record<string, string[]> = {
            'W1': ['D1', 'H4', 'H1', 'M30', 'M15', 'M5'], // WBias se propaga a todos
            'D1': ['H1'], // D1 es HTF para H1
            'H4': ['M30', 'M15'] // H4 es HTF para M15/M30
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
