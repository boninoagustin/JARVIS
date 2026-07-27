import { SMCEngine } from './SMCEngine.js';
import { OHLCV } from './types.js';
import { broadcastCandle, broadcastEvent, broadcastState } from '../../services/ws_server.js';

class SMCManager {
    private engines: Map<string, SMCEngine> = new Map();

    public getEngine(ticker: string, period: string): SMCEngine {
        const key = `${ticker}:${period}`;
        if (!this.engines.has(key)) {
            // Default preset
            this.engines.set(key, new SMCEngine('Forex - 3. Balanceado'));
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

    public processLiveCandles(ticker: string, period: string, newCandles: OHLCV[]) {
        const key = `${ticker}:${period}`;
        const engine = this.getEngine(ticker, period);

        // Process each candle
        for (const candle of newCandles) {
            const events = engine.nextCandle(candle);
            
            // Broadcast live candle (para actualizar el gráfico)
            broadcastCandle(key, candle);

            // Si se dispararon eventos, retransmitirlos todos
            for (const event of events) {
                broadcastEvent(key, event);
            }
        }
        
        // Retransmitir el estado actualizado si hubo un cierre de vela o un evento importante
        const state = engine.getState();
        broadcastState(key, state);
    }
}

export const smcManager = new SMCManager();
