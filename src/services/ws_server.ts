import { WebSocketServer, WebSocket } from 'ws';
import { SMCState } from '../engine/smc/types.js';
import { smcManager } from '../engine/smc/SMCManager.js';

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

// 🆕 Suscripciones por cliente: ws -> Set de "TICKER:PERIOD"
// Antes los broadcasts iban a TODOS los clientes y cada cliente descartaba lo que no era suyo.
const subscriptions = new Map<WebSocket, Set<string>>();

// 🆕 Clientes del scanner: ws -> filtro de activo (null = todos)
const scannerClients = new Map<WebSocket, string | null>();
let scannerInterval: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;

// 🆕 Registro de feeds vivos ya suscriptos en cTrader (evita duplicar el stream
// si dos clientes piden el mismo ticker:period, o si el mismo cliente re-suscribe)
const liveSubscriptions = new Set<string>();

// Cliente lento: si acumula más de este buffer, se dropea el mensaje
// (los estados son reemplazables — el próximo tick trae el estado completo)
const MAX_BUFFERED_BYTES = 5 * 1024 * 1024;

function safeSend(ws: WebSocket, payload: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
    ws.send(payload);
}

function sendScannerState(ws: WebSocket) {
    const asset = scannerClients.get(ws);
    let states = smcManager.getScannerStates();
    if (asset) {
        states = Object.fromEntries(
            Object.entries(states).filter(([key]) => key.startsWith(asset + ':'))
        );
    }
    safeSend(ws, JSON.stringify({ type: 'SCANNER_STATE', states }));
}

function startScannerInterval() {
    if (scannerInterval) return;
    scannerInterval = setInterval(() => {
        if (scannerClients.size === 0) {
            clearInterval(scannerInterval!);
            scannerInterval = null;
            return;
        }
        scannerClients.forEach((_asset, client) => sendScannerState(client));
    }, 1000);
}

export function initWebSocketServer(port: number = 8080) {
    wss = new WebSocketServer({ port });

    // 🆕 Ping/pong: sin esto, una conexión TCP medio-muerta (laptop suspendida,
    // red caída) quedaba en los Sets para siempre y el server le emitía eternamente.
    heartbeatInterval = setInterval(() => {
        wss?.clients.forEach(ws => {
            if ((ws as any).isAlive === false) {
                clients.delete(ws);
                subscriptions.delete(ws);
                scannerClients.delete(ws);
                return ws.terminate();
            }
            (ws as any).isAlive = false;
            ws.ping();
        });
    }, 30000);

    wss.on('connection', (ws: WebSocket) => {
        console.log('[WS] Nuevo cliente conectado al Dashboard');
        clients.add(ws);
        subscriptions.set(ws, new Set());
        (ws as any).isAlive = true;
        ws.on('pong', () => { (ws as any).isAlive = true; });

        ws.on('message', async (message: string) => {
            try {
                const data = JSON.parse(message);
                if (data.type === 'SUBSCRIBE') {
                    console.log(`[WS] Cliente suscrito a: ${data.ticker}`);
                    subscriptions.get(ws)?.add(data.ticker);
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
                            // 🆕 Una sola suscripción viva por ticker:period a nivel servidor
                            if (!liveSubscriptions.has(data.ticker)) {
                                liveSubscriptions.add(data.ticker);
                                subscribeToLiveTrendbars(tickerBase, periodEnum, periodStr).catch(e => console.error(e));
                            }

                            // Traemos el historial y lo mandamos al cliente
                            getHistoricalCandles(tickerBase, periodEnum, 500).then(candles => {
                                const lightweightCandles = candles.map(c => ({
                                    time: (c.timestamp / 1000), // Segundos
                                    open: c.open,
                                    high: c.high,
                                    low: c.low,
                                    close: c.close
                                }));
                                safeSend(ws, JSON.stringify({ type: 'HISTORY', ticker: data.ticker, candles: lightweightCandles }));

                                if (candles.length > 0) {
                                    // También enviamos el estado actualizado después de procesar la historia
                                    const state = smcManager.getEngine(tickerBase, periodStr).getState();
                                    safeSend(ws, JSON.stringify({ type: 'SMC_STATE', ticker: data.ticker, state }));
                                }
                            });
                        });
                    });
                } else if (data.type === 'SCANNER_SUBSCRIBE') {
                    console.log('[WS] Cliente suscrito al Escáner Global SMC');
                    // 🆕 Filtro opcional por activo: el cliente solo recibe las keys de su activo
                    scannerClients.set(ws, typeof data.asset === 'string' ? data.asset : null);

                    sendScannerState(ws);
                    startScannerInterval();
                }
            } catch (err) {
                console.error('[WS] Error parseando mensaje:', err);
            }
        });

        ws.on('close', () => {
            console.log('[WS] Cliente desconectado');
            clients.delete(ws);
            subscriptions.delete(ws);
            scannerClients.delete(ws);
        });
    });

    console.log(`[WS] Servidor WebSocket corriendo en el puerto ${port}`);
}

// 🆕 Los broadcasts ahora rutean por suscripción: solo reciben el mensaje
// los clientes que pidieron ese ticker:period explícitamente.
export function broadcastState(ticker: string, state: SMCState) {
    const payload = JSON.stringify({ type: 'SMC_STATE', ticker, state });
    clients.forEach(ws => {
        if (subscriptions.get(ws)?.has(ticker)) safeSend(ws, payload);
    });
}

export function broadcastEvent(ticker: string, event: any) {
    const payload = JSON.stringify({ type: 'SMC_EVENT', ticker, event });
    clients.forEach(ws => {
        if (subscriptions.get(ws)?.has(ticker)) safeSend(ws, payload);
    });
}

export function broadcastCandle(ticker: string, candle: any) {
    const payload = JSON.stringify({ type: 'NEW_CANDLE', ticker, candle });
    clients.forEach(ws => {
        if (subscriptions.get(ws)?.has(ticker)) safeSend(ws, payload);
    });
}

// Apagado limpio: corta el heartbeat y cierra el servidor (para SIGTERM/tests)
export function closeWebSocketServer() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    if (scannerInterval) {
        clearInterval(scannerInterval);
        scannerInterval = null;
    }
    wss?.close();
    wss = null;
}
