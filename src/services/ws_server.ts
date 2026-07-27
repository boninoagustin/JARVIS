import { WebSocketServer, WebSocket } from 'ws';
import { SMCState } from '../engine/smc/types.js';

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
const scannerClients = new Set<WebSocket>();
let scannerInterval: NodeJS.Timeout | null = null;

export function initWebSocketServer(port: number = 8080) {
    wss = new WebSocketServer({ port });

    wss.on('connection', (ws: WebSocket) => {
        console.log('[WS] Nuevo cliente conectado al Dashboard');
        clients.add(ws);

        ws.on('message', async (message: string) => {
            try {
                const data = JSON.parse(message);
                if (data.type === 'SUBSCRIBE') {
                    console.log(`[WS] Cliente suscrito a: ${data.ticker}`);
                    const [tickerBase, periodStr] = data.ticker.split(':');
                    
                    import('ctrader-ts').then(({ TrendbarPeriod }) => {
                        const periodMap: Record<string, any> = {
                            'M15': TrendbarPeriod.M15,
                            'H1': TrendbarPeriod.H1,
                            'H4': TrendbarPeriod.H4,
                            'D1': TrendbarPeriod.D1,
                            'W1': TrendbarPeriod.W1
                        };
                        const periodEnum = periodMap[periodStr] || TrendbarPeriod.M15;
                        
                        // Enviar historial de velas (las últimas 500 para Lightweight Charts)
                        import('./ctrader.js').then(({ subscribeToLiveTrendbars, getHistoricalCandles }) => {
                            // 1. Nos suscribimos para recibir vivos a partir de ahora
                            subscribeToLiveTrendbars(tickerBase, periodEnum, periodStr).catch(e => console.error(e));
                            
                            // 2. Traemos el historial, lo mandamos al motor SMC y luego al cliente
                            getHistoricalCandles(tickerBase, periodEnum, 500).then(candles => {
                                const lightweightCandles = candles.map(c => ({
                                    time: (c.timestamp / 1000), // Segundos
                                    open: c.open,
                                    high: c.high,
                                    low: c.low,
                                    close: c.close
                                }));
                                ws.send(JSON.stringify({ type: 'HISTORY', ticker: data.ticker, candles: lightweightCandles }));
                                
                                if (candles.length > 0) {
                                    // También enviamos el estado actualizado después de procesar la historia

                                import('../engine/smc/SMCManager.js').then(({ smcManager }) => {
                                    const state = smcManager.getEngine(tickerBase, periodStr).getState();
                                    ws.send(JSON.stringify({ type: 'SMC_STATE', ticker: data.ticker, state }));
                                });
                            }
                        });
                    });
                    });
                } else if (data.type === 'SCANNER_SUBSCRIBE') {
                    console.log('[WS] Cliente suscrito al Escáner Global SMC');
                    scannerClients.add(ws);
                    
                    import('../engine/smc/SMCManager.js').then(({ smcManager }) => {
                        ws.send(JSON.stringify({ type: 'SCANNER_STATE', states: smcManager.getAllStates() }));
                    });

                    if (!scannerInterval) {
                        scannerInterval = setInterval(() => {
                            if (scannerClients.size === 0) {
                                clearInterval(scannerInterval!);
                                scannerInterval = null;
                                return;
                            }
                            import('../engine/smc/SMCManager.js').then(({ smcManager }) => {
                                const payload = JSON.stringify({ type: 'SCANNER_STATE', states: smcManager.getAllStates() });
                                scannerClients.forEach(client => {
                                    if (client.readyState === WebSocket.OPEN) {
                                        client.send(payload);
                                    }
                                });
                            });
                        }, 1000);
                    }
                }
            } catch (err) {
                console.error('[WS] Error parseando mensaje:', err);
            }
        });

        ws.on('close', () => {
            console.log('[WS] Cliente desconectado');
            clients.delete(ws);
            scannerClients.delete(ws);
        });
    });

    console.log(`[WS] Servidor WebSocket corriendo en el puerto ${port}`);
}

export function broadcastState(ticker: string, state: SMCState) {
    const payload = JSON.stringify({ type: 'SMC_STATE', ticker, state });
    clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    });
}

export function broadcastEvent(ticker: string, event: any) {
    const payload = JSON.stringify({ type: 'SMC_EVENT', ticker, event });
    clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    });
}

export function broadcastCandle(ticker: string, candle: any) {
    const payload = JSON.stringify({ type: 'NEW_CANDLE', ticker, candle });
    clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    });
}
