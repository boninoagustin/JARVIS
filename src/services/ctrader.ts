/**
 * cTrader Open API Service — JARVIS Trading Execution
 * 
 * Connects to cTrader via the `ctrader-ts` SDK to execute real trades
 * on Funding Pips or any cTrader-compatible broker.
 * 
 * Features:
 * - Market order execution (BUY/SELL) with SL/TP
 * - Dynamic lot sizing based on risk percentage
 * - Position management (modify SL, close partial, close full)
 * - Account info & equity streaming
 * - Demo/Live mode toggle via .env
 */

import { config } from '../config.js';
import { refreshIfNeeded, startTokenAutoRenewal, refreshCtraderToken } from './ctraderToken.js';
import { TrendbarPeriod, PayloadType } from 'ctrader-ts';
import { db } from '../db/memory.js';
import { addCandles, OHLCV } from '../db/market_data.js';
import { tickFlow } from '../engine/TickFlow.js';
import { computeRMultipleFromPnlUsd } from '../engine/FrictionModel.js';

// ─── Types ───

export interface CTraderOrderParams {
    ticker: string;
    direction: 'BUY' | 'SELL';
    entryPrice: number;
    slPrice: number;
    tp1Price: number;
    tp2Price?: number;
    riskPercent?: number;   // Override risk per trade (default from config)
    tradeId: string;        // JARVIS internal trade ID for tracking
}

export interface CTraderOrderResult {
    success: boolean;
    positionId?: string;
    executedPrice?: number;
    lots?: number;
    error?: string;
}

export interface CTraderAccountInfo {
    balance: number;
    equity: number;
    currency: string;
    openPositions: number;
}

// ─── Connection State ───

export let ctClient: any = null;
// 🛡️ 24-sep-2026: moneda de depósito de la cuenta detectada de cTrader (no fija).
// detectAccountCurrency() la setea al conectar; getAccountInfo la usa para account_state.
let accountCurrency: string | null = null;
export function getAccountCurrency(): string { return accountCurrency || 'USD'; }

/** Lee trader.depositAssetId y lo mapea con el catálogo de activos → "EUR"/"USD"/... */
async function detectAccountCurrency(): Promise<string> {
    if (!ctClient) return 'USD';
    try {
        const traderResp: any = await ctClient.raw.account.getTrader();
        const trader = traderResp?.trader ?? traderResp;
        const depId = Number(trader?.depositAssetId);
        if (!depId) return 'USD';
        const assets: any[] = await ctClient.raw.market.getAssets();
        const a = assets.find(x => Number(x.assetId) === depId);
        const name = String(a?.name ?? a?.displayName ?? '').toUpperCase();
        if (name.length >= 3 && name.length <= 6 && /^[A-Z]+$/.test(name)) return name;
        return 'USD';
    } catch {
        return 'USD';
    }
}
let isConnected = false;
let connectingPromise: Promise<boolean> | null = null;
const MAX_RECONNECT_ATTEMPTS = 5;
const CONNECT_TIMEOUT_MS = 60_000; // 🛡️ 60s: el handshake de cTrader demo a veces tarda >20s

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timeout`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ─── Connection Management ───

/**
 * Initialize connection to cTrader Open API.
 * Uses lazy initialization — connects on first use.
 */
export async function connectCTrader(): Promise<boolean> {
    if (!config.CTRADER_CLIENT_ID || !config.CTRADER_ACCESS_TOKEN) {
        console.warn('[CTRADER] ⚠️ Credenciales no configuradas en .env. Servicio deshabilitado.');
        return false;
    }

    // 🆕 sep-2026 renovación automática del token: al primer connect se chequea el vencimiento
    // (renueva si falta <3 días) y se arranca el chequeo periódico cada 12h.
    void refreshIfNeeded().catch(() => { });
    startTokenAutoRenewal();

    if (isConnected && ctClient) return true;
    if (connectingPromise) return connectingPromise; // single-flight
    
    connectingPromise = connectWithRetry().finally(() => { connectingPromise = null; });
    return connectingPromise;
}

async function connectWithRetry(): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        try {
            console.log(`[CTRADER] 🔌 Conectando a cTrader Open API (intento ${attempt})...`);
            console.log(`[CTRADER] Modo: ${config.CTRADER_DEMO ? 'DEMO 🧪' : 'LIVE 🔴'}`);
            
            const { connect } = await import('ctrader-ts');
            let timedOut = false;
            
            const connectPromise = connect({
                clientId: config.CTRADER_CLIENT_ID,
                clientSecret: config.CTRADER_CLIENT_SECRET,
                accessToken: config.CTRADER_ACCESS_TOKEN,
                accountId: parseInt(config.CTRADER_ACCOUNT_ID, 10) || 0,
                environment: config.CTRADER_DEMO ? 'demo' : 'live',
            });
            
            connectPromise.then(c => { 
                if (timedOut) { 
                    try { c.disconnect(); } catch {} 
                } 
            }).catch(() => {});
            
            const client = await withTimeout(connectPromise, CONNECT_TIMEOUT_MS, 'connectCTrader')
                .catch(err => { timedOut = true; throw err; });
                
            ctClient = client;
            isConnected = true;
            console.log('[CTRADER] ✅ Conectado exitosamente a cTrader.');
            // 🛡️ 24-sep-2026: detectar la moneda REAL de depósito de la cuenta (EUR, USD, …).
            // ctrader-ts getState() NO expone currency — se lee trader.depositAssetId y se
            // mapea con el catálogo de activos. Fallback 'USD' solo si no se puede detectar.
            detectAccountCurrency().then(c => {
                accountCurrency = c;
                console.log(`[CTRADER] 💱 Moneda de la cuenta detectada: ${c}`);
            }).catch(() => { /* sin moneda → queda 'USD' */ });
            
            setupCTraderEvents(client);

            // 🆕 FIX (ago-2026): al (re)conectarse, disparar la reconciliación en caliente para
            // re-adoptar posiciones abiertas sin esperar el ciclo de 10 min. El reconciler tiene
            // throttle de 5 min, así que no spamea. Import dinámico para evitar ciclos.
            import('../db/trading.js').then(m => m.reconcileCTraderPositions()).catch(() => { });
            
            // 🛡️ FIX B: ante desconexión, reintentar en el MISMO proceso (no matar todo con exit(1)).
            // El SDK reporta 'disconnected' en caídas transitorias del feed; antes esto forzaba
            // un reinicio completo de PM2 (932 restarts) y un handshake nuevo que a veces daba timeout.
            client.connection.onEvent('stateChange', (s: any) => {
                if (s.status === 'disconnected' && ctClient === client) {
                    console.error('[CTRADER] 🚨 Feed perdido. Reintentando reconexión en caliente (sin reiniciar el proceso)...');
                    handleDisconnectAndReconnect(client);
                }
            });
            
            return true;
        } catch (err: any) {
            // 🆕 sep-2026: si el error es de CREDENCIALES (token), renovar con el refresh token
            // y dejar que el próximo intento del loop use el token nuevo (config actualizada).
            // Errores de red (timeout, CANT_ROUTE_REQUEST) NO matchean → no se malgasta el refresh.
            const msg = String(err?.message || '');
            if (/token|access|auth|credential|authoriz/i.test(msg)) {
                console.error(`[CTRADER-TOKEN] 🔑 Error de credenciales detectado (${msg}). Intentando renovar el token...`);
                await refreshCtraderToken(true);
            }
            console.error(`[CTRADER] ❌ Error de conexión (intento ${attempt}):`, err.message);
            try { ctClient?.disconnect(); } catch { /* noop */ } // ✅ matar al huérfano
            ctClient = null;
            isConnected = false;
            
            if (attempt < MAX_RECONNECT_ATTEMPTS) {
                const delay = Math.min(5000 * attempt, 30000);
                console.log(`[CTRADER] 🔄 Reintentando en ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    
    console.error('[CTRADER] ⛔ Max reintentos alcanzado. Servicio offline.');
    return false;
}

// 🛡️ FIX B: reconexión en caliente ante caída del feed. Desloguea el cliente viejo,
// limpia estado de suscripción y reintenta en el MISMO proceso. No usa process.exit(1).
let reconnectInFlight = false;
let reconnectConsecutiveFailures = 0;

async function handleDisconnectAndReconnect(oldClient: any): Promise<void> {
    if (reconnectInFlight) return; // ya hay una reconexión en curso
    reconnectInFlight = true;
    try {
        // 1. Desloguear el cliente caído y limpiar estado
        try { oldClient?.disconnect?.(); } catch { /* noop */ }
        if (ctClient === oldClient) { ctClient = null; isConnected = false; }
        clearSubscriptionState();

        // 2. Backoff exponencial entre intentos de reconexión
        const baseDelay = Math.min(5000 * (1 + reconnectConsecutiveFailures), 30000);
        console.log(`[CTRADER] 🔄 Reconexión en caliente en ${baseDelay / 1000}s...`);
        await new Promise(r => setTimeout(r, baseDelay));

        // 3. Reintentar conectar (connectWithRetry ya trae su propio backoff interno)
        connectingPromise = null;
        const ok = await connectCTrader();
        if (ok) {
            reconnectConsecutiveFailures = 0;
            console.log('[CTRADER] ✅ Reconexión exitosa. Re-inicializando escáner SMC...');
            try { await initializeScanner(); } catch (e: any) { console.warn('[CTRADER] ⚠️ No se pudo re-inicializar el escáner tras reconexión:', e.message); }
        } else {
            reconnectConsecutiveFailures++;
            console.error(`[CTRADER] ❌ Reconexión fallida (${reconnectConsecutiveFailures} fallo(s) consecutivos).`);
            // Si falla repetidamente, caer a reinicio de PM2 como último recurso
            if (reconnectConsecutiveFailures >= 5) {
                console.error('[CTRADER] ⛔ 5 reconexiones fallidas. Cediendo a PM2 (reinicio limpio).');
                process.exit(1);
            } else {
                // reintentar de nuevo en caliente
                reconnectInFlight = false;
                handleDisconnectAndReconnect(ctClient).catch(() => {});
            }
        }
    } catch (e: any) {
        console.error('[CTRADER] ❌ Error en reconexión en caliente:', e.message);
        reconnectConsecutiveFailures++;
    } finally {
        reconnectInFlight = false;
    }
}

/**
 * Check if cTrader is connected and ready.
 */
export function isCTraderReady(): boolean {
    return isConnected && ctClient !== null;
}

// ─── Event Listeners ───

function setupCTraderEvents(client: any) {
    client.onExecution(async (event: any) => {
        try {
            // 🆕 ago-2026: loguear deals RECHAZADOS para diagnóstico. cTrader acepta la orden,
            // devuelve positionId y puede rechazar el deal internamente ~400ms después
            // (filledVolume=0, dealStatus=5 INTERNALLY_REJECTED). Antes estos eventos eran invisibles.
            const dealStatus = Number(event?.deal?.dealStatus ?? 0);
            if (dealStatus >= 4) {
                console.warn(`[CTRADER-EVENT] ⚠️ Deal RECHAZADO (status=${dealStatus}): posId=${event?.position?.positionId ?? event?.order?.positionId ?? '?'} orderId=${event?.deal?.orderId ?? '?'} reasonCode=${event?.deal?.reasonCode ?? '?'} reason=${event?.deal?.reason ?? ''}`);
                return;
            }
            if (!event.position || !event.position.positionId) return;
            
            const positionId = event.position.positionId.toString();
            const executionType = event.executionType;
            
            // executionType 2 = ORDER_FILLED (Apertura, Modificación, Parcial o Cierre Total)
            if (executionType !== 2) return;
            
            console.log(`[CTRADER-EVENT] ExecutionEvent recibido para Position ID: ${positionId}`);
            
            if (!db) return;
            const tradesRef = db.collection('trade_journal');
            const snapshot = await tradesRef.where('ctraderPositionId', '==', positionId).limit(1).get();
            
            if (snapshot.empty) return;
            
            const tradeDoc = snapshot.docs[0];
            const trade = tradeDoc.data();
            
            // ─── Extraer PnL NETO del deal (gross + commission + swap) ───
            // 🛡️ sep-2026: antes se sumaba SOLO grossProfit → el acumulado no coincidía
            // con el neto del historial de cTrader (la comisión se cobra en CADA deal:
            // apertura, parcial TP1 y cierre final). Ahora: neto real por deal.
            let dealPnl = 0;
            if (event.deal && event.deal.closePositionDetail) {
                const cp = event.deal.closePositionDetail;
                const rawProfit = Number(cp.grossProfit || 0) + Number(cp.commission || 0) + Number(cp.swap || 0);
                const moneyDigits = event.deal.moneyDigits || cp.moneyDigits || 2;
                dealPnl = rawProfit / Math.pow(10, moneyDigits);
            } else if (event.deal && (event.deal.commission || event.deal.grossProfit)) {
                const moneyDigits = event.deal.moneyDigits || 2;
                dealPnl = Number(event.deal.commission || 0) / Math.pow(10, moneyDigits);
            }

            const positionStatus = event.position.positionStatus; // 1 = OPEN, 2 = CLOSED, 3 = CREATED

            // Acumular PnL de deals parciales (no sobreescribir)
            const previousPnl = trade.ctrader_real_pnl || 0;
            const accumulatedPnl = Number((previousPnl + dealPnl).toFixed(2));

            // 3 = CREATED: evento transitorio de apertura — nada que hacer
            if (positionStatus === 3) {
                console.log(`[CTRADER-EVENT] Trade #${tradeDoc.id} creado (evento transitorio) — sin acción.`);
            }
            // 2 = CLOSED: la posición cerró del todo (SL, TP2 o manual)
            else if (positionStatus === 2) {
                let resultStatus: string;
                if (accumulatedPnl > 0.5) resultStatus = 'WIN';
                else if (accumulatedPnl < -0.5) resultStatus = 'LOSS';
                else resultStatus = 'BREAKEVEN';
                const trigger = (event.deal?.stopTriggerBase ?? event.deal?.closePositionDetail?.closeTriggerBase ?? '').toString().toUpperCase();
                // 🛡️ sep-2026: rMultiple real = PnL neto / riesgo real (SL estructural, lots reales).
                // Sanidad: SL del lado correcto (BUY: sl<entry | SELL: sl>entry); si no, null.
                const evEntry = Number(trade.entryPrice ?? 0);
                const evSl = Number(trade.initialSlPrice ?? trade.originalSlPrice ?? trade.slPrice ?? evEntry);
                const evDir = String(trade.direction || '').toUpperCase();
                const evSlOk = !evDir || (evDir === 'BUY' ? evSl < evEntry : evSl > evEntry);
                const usdjpy = (trade.ticker || '').toUpperCase().includes('JPY')
                    ? (lastBidAsk.get('USDJPY')?.bid ?? undefined) : undefined;
                const rMultiple = evSlOk ? computeRMultipleFromPnlUsd(
                    trade.ticker || '', evEntry, evSl,
                    Number(trade.ctraderLots ?? trade.lots ?? 0), accumulatedPnl, usdjpy,
                ) : null;
                if (trade.manualResult) {
                    console.log(`[CTRADER-EVENT] ⏭️ #${tradeDoc.id} manualResult — se respeta, no se escribe resultado automático.`);
                } else {
                    await tradeDoc.ref.update({
                        result: resultStatus,
                        ctrader_real_pnl: accumulatedPnl,
                        rMultiple,
                        status: 'CLOSED',
                        slHit: trigger === 'STOP_LOSS',
                        tp2Hit: trigger === 'TAKE_PROFIT',
                    });
                }
                console.log(`[CTRADER-EVENT] Trade #${tradeDoc.id} cerrado. PnL neto acumulado: $${accumulatedPnl} -> ${resultStatus} (${rMultiple}R, trigger: ${trigger || 'n/d'})`);
            }
            // 1 = OPEN + deal con closePositionDetail: cierre parcial (TP1)
            else if (positionStatus === 1 && event.deal && event.deal.closePositionDetail) {
                await tradeDoc.ref.update({
                    result: 'PARTIAL_TP1',
                    ctrader_real_pnl: accumulatedPnl,
                    tp1Hit: true
                });
                console.log(`[CTRADER-EVENT] Trade #${tradeDoc.id} cierre parcial. Deal PnL: $${dealPnl}, Acumulado: $${accumulatedPnl}`);
            }
        } catch (err: any) {
            console.error('[CTRADER-EVENT] Error procesando ExecutionEvent:', err.message);
        }
    });
    
    console.log('[CTRADER-EVENT] ✅ Listener de ExecutionEvent registrado.');

    // Listener para Live Trendbars y Ticks (SpotEvent payloadType 2131)
    if (client.connection) {
        client.connection.on(2131, (msg: any) => {
            try {
                const symbolId = msg.symbolId;
                const divider = 100000; // cTrader Open API always multiplies prices by 100000
                
                // 1. Process real-time ticks (msg.bid) for visual chart animation
                if (msg.bid) {
                    const currentPrice = msg.bid / divider;
                    const askPrice = msg.ask ? msg.ask / divider : NaN;

                    // 🌊 TickFlow: micro-estructura (velocidad, spread, sweeps) — 1 vez por tick
                    const flowTicker = symbolToTicker.get(symbolId);
                    if (flowTicker) {
                        try { tickFlow.onTick(flowTicker, Date.now(), currentPrice, askPrice); } catch { /* nunca romper el feed */ }
                    }
                    // 📊 Guardar último bid/ask por ticker (TP/SL del lado correcto + spread en radar)
                    if (flowTicker && !Number.isNaN(askPrice)) {
                        lastBidAsk.set(flowTicker, { bid: currentPrice, ask: askPrice, ts: Date.now() });
                    }
                    
                    // Buscar si tenemos el activo en buffer para actualizar visualmente
                    for (const [key, subSymbolId] of subscribedSymbols.entries()) {
                        if (subSymbolId === symbolId) {
                            const [baseTicker, periodStr] = key.split(':');
                            
                            // Import dinámico para evitar ciclos si los hay (market_data es seguro)
                            import('../db/market_data.js').then(({ getCandles }) => {
                                const candles = getCandles(baseTicker, periodStr);
                                if (candles && candles.length > 0) {
                                    const lastCandle = { ...candles[candles.length - 1] }; // Clonamos para no mutar el buffer directamente de forma sucia
                                    // 🛡️ sep-2026 fix OTE: la vela ANTERIOR es la última CERRADA — el
                                    // estiramiento del extreme del leg debe usar vela cerrada, no la
                                    // vela en formación (la OTE "huía" del precio).
                                    const prevCandle = candles.length >= 2 ? { ...candles[candles.length - 2] } : null;
                                    let updated = false;
                                    
                                    if (currentPrice !== lastCandle.close) {
                                        lastCandle.close = currentPrice;
                                        updated = true;
                                    }
                                    if (currentPrice > lastCandle.high) {
                                        lastCandle.high = currentPrice;
                                        updated = true;
                                    }
                                    if (currentPrice < lastCandle.low) {
                                        lastCandle.low = currentPrice;
                                        updated = true;
                                    }
                                    
                                    if (updated) {
                                        // 🆕 Hook para SMCBridge: PING de precio nativo hacia JARVIS
                                        // (el bridge throttlear por ticker; reemplaza al PING de TradingView)
                                        spotTickListener?.(baseTicker, lastCandle, prevCandle ?? undefined);

                                        // Broadcast tick to UI without triggering heavy SMC Engine logic
                                        import('./ws_server.js').then(({ broadcastCandle }) => {
                                            broadcastCandle(key, lastCandle);
                                        }).catch(err => console.error("Error broadcast tick:", err));
                                    }
                                }
                            }).catch(err => console.error("Error import market_data:", err));
                        }
                    }
                }

                // 2. Process trendbars (closed or periodically updated bars by broker)
                if (msg.trendbar && msg.trendbar.length > 0) {
                    const baseTicker = symbolToTicker.get(symbolId);
                    if (baseTicker) {
                        // 🔧 FIX (19-ago): cada Trendbar trae su propio `period` (M5=5, M15=7, H1=9…).
                        // Antes se enrutaba por `.find()` sobre subscribedSymbols → SIEMPRE caía en la
                        // primera key del símbolo (M5, que se suscribe primero). Eso dejó M15/H1/H4/D1
                        // sin velas desde ~14-ago y contaminó la serie M5 con barras de otros TFs.
                        // Ahora agrupamos por period y enrutamos cada grupo a su key correcta.
                        const PERIOD_TO_STR: Record<number, string> = {
                            5: 'M5', 7: 'M15', 8: 'M30', 9: 'H1', 10: 'H4', 12: 'D1', 13: 'W1',
                        };
                        const groups = new Map<string, any[]>();
                        for (const tb of msg.trendbar as any[]) {
                            const p = tb.period;
                            const periodStr = PERIOD_TO_STR[p] ?? null;
                            if (!periodStr) continue; // TF no suscripto → ignorar
                            if (!groups.has(periodStr)) groups.set(periodStr, []);
                            groups.get(periodStr)!.push(tb);
                        }
                        for (const [periodStr, tbs] of groups) {
                            const key = `${baseTicker}:${periodStr}`;
                            const newCandles = tbs.map((tb: any) => {
                                const lowRaw = tb.low || 0;
                                return {
                                    timestamp: (tb.utcTimestampInMinutes || 0) * 60000,
                                    open: (lowRaw + (tb.deltaOpen || 0)) / divider,
                                    high: (lowRaw + (tb.deltaHigh || 0)) / divider,
                                    low: lowRaw / divider,
                                    close: tb.deltaClose != null
                                        ? (lowRaw + tb.deltaClose) / divider
                                        : (msg.bid ? msg.bid / divider : (lowRaw + (tb.deltaOpen || 0)) / divider),
                                    volume: tb.volume || 0
                                };
                            });

                            // 🔍 DIAGNÓSTICO: loguear trendbars recibidos para confirmar que cTrader los envía
                            const tsFirst = newCandles[0]?.timestamp ? new Date(newCandles[0].timestamp).toISOString() : '???';
                            const tsLast = newCandles[newCandles.length - 1]?.timestamp ? new Date(newCandles[newCandles.length - 1].timestamp).toISOString() : '???';
                            console.log(`[CTRADER-TB] 📊 Trendbars recibidos: ${key} ×${newCandles.length} (${tsFirst} → ${tsLast})`);

                            // Agregar o actualizar las velas en el buffer
                            import('../db/market_data.js').then(({ addCandles }) => {
                                addCandles(baseTicker, periodStr, newCandles);

                                // Enviar al motor SMC (heavy processing)
                                import('../engine/smc/SMCManager.js').then(({ smcManager }) => {
                                    smcManager.processLiveCandles(baseTicker, periodStr, newCandles);
                                }).catch(err => console.error('[CTRADER] Error procesando SMC:', err));
                            });
                        }
                    }
                }
            } catch (err: any) {
                console.error('[CTRADER-EVENT] Error procesando SpotEvent:', err.message);
            }
        });
        console.log('[CTRADER-EVENT] ✅ Listener de Live Trendbars registrado.');
    }
}

// Mapa para asociar "TICKER:PERIOD" -> symbolId de cTrader
const subscribedSymbols = new Map<string, number>();
// Mapa inverso symbolId -> baseTicker (para tickFlow: 1 llamada por tick, no por TF)
const symbolToTicker = new Map<number, string>();
// 🛡️ FIX C: Set de suscripciones ya activas en la conexión ACTUAL (symbolId y symbolId:period).
// Evita el ALREADY_SUBSCRIBED al re-suscribir tras una reconexión en caliente.
const subscribedSpots = new Set<number>();
const subscribedTrendbars = new Set<string>();

function clearSubscriptionState(): void {
    subscribedSymbols.clear();
    symbolToTicker.clear();
    subscribedSpots.clear();
    subscribedTrendbars.clear();
    scannerProcessed.clear();
}

// 🆕 Fase 1: listener de ticks spot para el SMCBridge (PING de precio nativo).
// Se invoca con (baseTicker, vela actualizada por el tick) desde el handler de SpotEvent.
type SpotTickListener = (baseTicker: string, candle: OHLCV, prevCandle?: OHLCV) => void;
let spotTickListener: SpotTickListener | null = null;
export function setSpotTickListener(fn: SpotTickListener | null) {
    spotTickListener = fn;
}

// 📊 Último bid/ask por ticker (el SpotEvent trae ambos; se guardan para
// detección de TP/SL del lado de ejecución correcto y para el spread en el radar).
const lastBidAsk = new Map<string, { bid: number; ask: number; ts: number }>();
export function getLastBidAsk(ticker: string): { bid: number; ask: number; ts: number } | null {
    return lastBidAsk.get(ticker.toUpperCase()) ?? null;
}

/**
 * Suscribe a un activo y temporalidad para recibir Live Trendbars.
 */
export async function subscribeToLiveTrendbars(ticker: string, period: TrendbarPeriod, periodStr: string) {
    if (!isConnected || !ctClient) {
        const connected = await connectCTrader();
        if (!connected) throw new Error("No se pudo conectar a cTrader para suscripción.");
    }

    const ctraderSymbol = mapToCTraderSymbol(ticker);
    try {
        const info = await ctClient.getSymbolInfo(ctraderSymbol);
        if (!info || !info.symbolId) throw new Error(`Symbol no encontrado: ${ctraderSymbol}`);

        const symbolId = info.symbolId;
        // MUST use periodStr to match frontend expects like "EURUSD:M15" instead of "EURUSD:7"
        const key = `${ticker}:${periodStr}`;
        
        // Guardamos la relación para cuando llegue el SpotEvent
        subscribedSymbols.set(key, symbolId);
        symbolToTicker.set(symbolId, ticker);
        
        // Suscribirse vía la API de bajo nivel
        // REQUIRES subscribing to Spots first!
        // 🛡️ FIX C: solo suscribir si no está ya activo en esta conexión (evita ALREADY_SUBSCRIBED)
        if (!subscribedSpots.has(symbolId)) {
            await ctClient.raw.market.subscribeSpots([symbolId]);
            subscribedSpots.add(symbolId);
        }
        const tbKey = `${symbolId}:${period}`;
        if (!subscribedTrendbars.has(tbKey)) {
            await ctClient.raw.market.subscribeLiveTrendbar(symbolId, period);
            subscribedTrendbars.add(tbKey);
        }
        console.log(`[CTRADER] 📡 Suscrito exitosamente a Live Trendbars para ${ctraderSymbol} (${periodStr})`);
        
    } catch (err: any) {
        console.error(`[CTRADER] ❌ Error suscribiendo a Live Trendbars para ${ctraderSymbol}:`, err.message);
        throw err;
    }
}

/**
 * Inicializa el escáner global suscribiéndose a todos los activos y temporalidades.
 */
// 🆕 27-sep-2026: roster dinámico del escáner — seed = los 10 clásicos; se actualiza
// desde el listener de asset_configs (trading.ts) vía syncScannerRoster. En reconexión
// de cTrader, initializeScanner re-suscribe TODO el roster cacheado.
const DEFAULT_SCANNER_TICKERS = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40'];
const scannerRoster = new Set<string>(DEFAULT_SCANNER_TICKERS);
// tickers cuyo histórico + suscripciones ya se procesaron en la conexión ACTUAL
const scannerProcessed = new Set<string>();

const SCANNER_TFS = [
    { p: TrendbarPeriod.M5, str: 'M5' },
    { p: TrendbarPeriod.M15, str: 'M15' },
    { p: TrendbarPeriod.H1, str: 'H1' },
    { p: TrendbarPeriod.H4, str: 'H4' },
    { p: TrendbarPeriod.D1, str: 'D1' },
    { p: TrendbarPeriod.W1, str: 'W1' },
];

export function getScannerRoster(): string[] {
    return [...scannerRoster];
}

export async function syncScannerRoster(tickers: string[]): Promise<void> {
    const wanted = [...new Set(tickers.map(t => t.toUpperCase()).filter(t => t && t !== 'GLOBAL'))];
    if (wanted.length === 0) return;
    for (const t of wanted) scannerRoster.add(t);
    const newOnes = wanted.filter(t => !scannerProcessed.has(t));
    if (newOnes.length === 0) return;
    console.log(`[CTRADER] 🛰️ Roster dinámico: ${newOnes.length} activo(s) nuevo(s) → ${newOnes.join(', ')}`);
    for (const asset of newOnes) {
        for (const tf of SCANNER_TFS) {
            try {
                // 1. Historial (alimenta el motor SMC) + 2. suscripción live
                await getHistoricalCandles(asset, tf.p, 500);
                await subscribeToLiveTrendbars(asset, tf.p, tf.str);
                await new Promise(r => setTimeout(r, 100));
            } catch (err) {
                console.error(`[CTRADER] ⚠️ Error roster dinámico ${asset}:${tf.str}`);
            }
        }
        scannerProcessed.add(asset);
    }
    console.log(`[CTRADER] ✅ Roster dinámico completo: ${scannerProcessed.size} activos con streams.`);
}

export async function initializeScanner() {
    console.log(`[CTRADER] 🚀 Inicializando Escáner Global SMC (roster: ${scannerRoster.size} activos)...`);
    
    if (!isConnected || !ctClient) {
        const connected = await connectCTrader();
        if (!connected) {
            console.error('[CTRADER] No se pudo iniciar el escáner por falta de conexión.');
            return;
        }
    }

    const assets = [...scannerRoster];
    const timeframes = SCANNER_TFS;

    let successCount = 0;
    
    for (const asset of assets) {
        for (const tf of timeframes) {
            try {
                // 1. Obtener historial (que automáticamente alimenta al SMC Engine)
                await getHistoricalCandles(asset, tf.p, 500);
                
                // 2. Suscribirse a ticks en vivo
                await subscribeToLiveTrendbars(asset, tf.p, tf.str);
                
                successCount++;
                
                // Pequeño delay para no saturar la API
                await new Promise(r => setTimeout(r, 100));
            } catch (err) {
                console.error(`[CTRADER] ⚠️ Error inicializando escáner para ${asset}:${tf.str}`);
            }
        }
        scannerProcessed.add(asset);
    }
    
    console.log(`[CTRADER] ✅ Escáner SMC Global inicializado. (${successCount}/${assets.length * timeframes.length} streams activos)`);
}

/**
 * Recupera el historial de velas y las inyecta en el motor SMC.
 */
export async function getHistoricalCandles(ticker: string, period: TrendbarPeriod, count: number = 500): Promise<OHLCV[]> {
    if (!isConnected || !ctClient) {
        const connected = await connectCTrader();
        if (!connected) return [];
    }

    const ctraderSymbol = mapToCTraderSymbol(ticker);
    try {
        const info = await ctClient.getSymbolInfo(ctraderSymbol);
        if (!info || !info.symbolId) throw new Error(`Symbol no encontrado: ${ctraderSymbol}`);
        
        // Obtener historial desde hace X minutos dependiendo del timeframe
        // En cTrader la API raw acepta fromTimestamp y toTimestamp
        const now = Date.now();
        function getPeriodDuration(period: TrendbarPeriod): number {
    switch (period) {
        case TrendbarPeriod.M1: return 60000;
        case TrendbarPeriod.M5: return 300000;
        case TrendbarPeriod.M15: return 900000;
        case TrendbarPeriod.H1: return 3600000;
        case TrendbarPeriod.H4: return 14400000;
        case TrendbarPeriod.D1: return 86400000;
        case TrendbarPeriod.W1: return 604800000;
        default: return 300000;
    }
}
        const periodMs = getPeriodDuration(period);
        
        const fromTimestamp = now - (periodMs * count);
        const toTimestamp = now;

        const res = await ctClient.raw.market.getTrendbars({
            symbolId: info.symbolId,
            period: period,
            fromTimestamp,
            toTimestamp
        });
        
        if (res && res.trendbars) {
            const divider = 100000;
            const newCandles: OHLCV[] = res.trendbars.map((tb: any) => {
                const lowRaw = tb.low || 0;
                return {
                    timestamp: (tb.utcTimestampInMinutes || 0) * 60000,
                    open: (lowRaw + (tb.deltaOpen || 0)) / divider,
                    high: (lowRaw + (tb.deltaHigh || 0)) / divider,
                    low: lowRaw / divider,
                    close: (lowRaw + (tb.deltaClose || 0)) / divider,
                    volume: tb.volume || 0
                };
            });
            const periodStr = TrendbarPeriod[period];
            
            // Llenar buffer inicial
            addCandles(ticker, periodStr, newCandles);
            
            // Inicializar el SMC con este historial (isHistorical = true)
            import('../engine/smc/SMCManager.js').then(({ smcManager }) => {
                smcManager.processLiveCandles(ticker, periodStr, newCandles, true);
            });
            
            return newCandles;
        }
    } catch (err: any) {
        console.error(`[CTRADER] ❌ Error obteniendo historial para ${ctraderSymbol}:`, err.message);
    }
    return [];
}

// ─── Lot Size Calculator ───

/**
 * Calculate lot size based on risk percentage and SL distance.
 * Respects Funding Pips' 3% max loss per trade rule.
 * 
 * @param equity Account equity
 * @param entryPrice Entry price
 * @param slPrice Stop loss price
 * @param riskPercent Risk per trade as percentage (e.g., 1 = 1%)
 * @param ticker Symbol to trade
 * @returns Lot size (e.g., 0.10)
 */
// 🛡️ 16-sep-2026: centavos de moneda base por LOTE según clase de activo.
// Forex = 10,000,000 (100k unidades × 100 centavos); XAU/XAG/OIL = 10,000 (100 unidades);
// BTC/índices = 100 (1 unidad). Convierte filledVolume (centavos del proto) → lotes reales.
export function getLotSizeCents(ticker: string): number {
    const t = (ticker || '').toUpperCase();
    if (t.includes('XAU') || t.includes('GOLD')) return 10000;
    if (t.includes('BTC') || t.includes('ETH') || t.includes('US30') || t.includes('NAS')
        || t.includes('SPX') || t.includes('US100') || t.includes('USTEC')
        || t.includes('US500') || t.includes('GER') || t.includes('DE40') || t.includes('DAX') || t.includes('JP225')) return 100;
    if (t.includes('XAG') || t.includes('SILVER')) return 500000;
    if (t.includes('OIL') || t.includes('WTI') || t.includes('BRENT') || t.includes('XTI')) return 10000;
    return 10000000; // forex por defecto
}

/**
 * 🛡️ FIX (30-sep-2026): clasifica índices del broker para el lotaje.
 * Antes solo US30/NAS/US100/SPX/GER/DE40/DAX/JP225/NIKKEI caían en la rama índices
 * y el resto (US500, USTECH100, NL25, ITALY40, FRA40, UK100, SPAIN35, EUROPE50,
 * AUSTRALIA200...) caía en la rama forex (pip=0.0001) → volumen ~0 → abort por
 * mínimo del broker. Fuente del universo: scripts/asset_scout.ts UNIVERSE.
 */
function isIndexTicker(t: string): boolean {
    return t.includes('US30') || t.includes('DOW') || t.includes('WALLSTREET')
        || t.includes('NAS') || t.includes('US100') || t.includes('USTEC') || t.includes('USTECH') || t.includes('NDX')
        || t.includes('SPX') || t.includes('US500') || t.includes('SP500')
        || t.includes('GER') || t.includes('DE40') || t.includes('DAX')
        || t.includes('JP225') || t.includes('NIKKEI') || t.includes('JAPAN')
        || t.includes('NL25') || t.includes('NETHERLANDS')
        || t.includes('ITALY') || t.includes('IT40') || t.includes('MIB')
        || t.includes('FRA40') || t.includes('FRANCE') || t.includes('CAC')
        || t.includes('UK100') || t.includes('FTSE')
        || t.includes('SPAIN') || t.includes('IBEX') || t.includes('ES35')
        || t.includes('EUROPE') || t.includes('EU50') || t.includes('ESTX') || t.includes('STOXX')
        || t.includes('AUSTRALIA') || t.includes('AUS200') || t.includes('ASX')
        || t.includes('NIFTY') || t.includes('INDIA') || t.includes('IN50')
        || t.includes('HK50') || t.includes('HSI') || t.includes('HANGSENG')
        || t.includes('CN50') || t.includes('CHINA')
        || t.includes('KOSPI') || t.includes('SGX') || t.includes('SING')
        || t.includes('US2000') || t.includes('RUSSELL');
}

export function calculateLotSize(
    equity: number,
    entryPrice: number,
    slPrice: number,
    riskPercent: number,
    ticker: string
): number {
    // Enforce Funding Pips 3% max rule
    const effectiveRisk = Math.min(riskPercent, 3);
    const riskAmount = equity * (effectiveRisk / 100);
    const slDistance = Math.abs(entryPrice - slPrice);
    
    if (slDistance === 0) {
        console.warn('[CTRADER] ⚠️ SL distance es 0, usando lot mínimo.');
        return 0.01;
    }

    // Pip value calculation depends on the instrument
    let pipValue: number;
    const t = ticker.toUpperCase();
    
    if (t.includes('JPY')) {
        // JPY pairs: 1 pip = 0.01, lot = 100,000 units
        pipValue = slDistance / 0.01;
        const lotSize = riskAmount / (pipValue * (1000 / 100)); // ~$9.xx per pip per lot
        return Math.max(0, parseFloat(lotSize.toFixed(4)));
    } else if (t.includes('XAU') || t.includes('GOLD')) {
        // Gold: 1 pip = 0.1, lot = 100 oz
        const pips = slDistance / 0.1;
        const costPerPip = 10; // ~$10 per pip for 1 lot of gold
        const lotSize = riskAmount / (pips * costPerPip);
        return Math.max(0, parseFloat(lotSize.toFixed(4)));
    } else if (t.includes('XAG') || t.includes('SILVER')) {
        // 🛡️ FIX (30-sep-2026): Plata. 1 lote = 5000 oz → $50 por centavo (0.01).
        // Antes caía en la rama forex (pip 0.0001) y el volumen salía ~0 → abort por mínimo.
        const pips = slDistance / 0.01;
        const costPerPip = 50; // 5000 oz × $0.01
        const lotSize = riskAmount / (pips * costPerPip);
        return Math.max(0, parseFloat(lotSize.toFixed(4)));
    } else if (t.includes('XPT') || t.includes('PLATINUM') || t.includes('XPD') || t.includes('PALLADIUM')) {
        // 🛡️ FIX (30-sep-2026): Platino/Paladio. 1 lote = 100 oz → $1 por centavo (0.01).
        const pips = slDistance / 0.01;
        const costPerPip = 1; // 100 oz × $0.01
        const lotSize = riskAmount / (pips * costPerPip);
        return Math.max(0, parseFloat(lotSize.toFixed(4)));
    } else if (t.includes('BTC') || t.includes('ETH')) {
        // Bitcoin/Ethereum: no standard pip, use raw price distance
        const costPerUnit = 1; // $1 per unit per 1 lot (varies by broker)
        const lotSize = riskAmount / (slDistance * costPerUnit);
        return Math.max(0, parseFloat(lotSize.toFixed(4)));
    } else if (isIndexTicker(t)) {
        // Indices: 1 punto = 1 unidad de precio, ~$1 (o moneda local) por punto por lote.
        const costPerPoint = 1; // $1 per point per 1 lot (varies)
        const lotSize = riskAmount / (slDistance * costPerPoint);
        return Math.max(0, parseFloat(lotSize.toFixed(4)));
    } else if (t.includes('OIL') || t.includes('XTI') || t.includes('WTI') || t.includes('BRENT') || t.includes('XBR') || t.includes('UKOIL')) {
        // 🛡️ FIX: Oil (USOIL/XTIUSD, Brent/XBRUSD): 1 pip = 0.01 (1 cent), lot = 100 barriles.
        // Con SL distance en dólares y costPerPip=1 (100 barriles × $0.01 = $1 por pip por lote),
        // el lote sale correcto y NO cae por debajo del mínimo del broker (minVolume=0.1 lotes).
        const pips = slDistance / 0.01;
        const costPerPip = 1; // $1 por pip por lote (100 barriles × 1 centavo)
        const lotSize = riskAmount / (pips * costPerPip);
        return Math.max(0, parseFloat(lotSize.toFixed(4)));
    } else if (t.includes('NATGAS') || t.includes('NGAS')) {
        // 🛡️ FIX (30-sep-2026): Gas natural. 1 lote = 10000 MMBtu → $10 por 0.001.
        const pips = slDistance / 0.001;
        const costPerPip = 10; // 10000 MMBtu × $0.001
        const lotSize = riskAmount / (pips * costPerPip);
        return Math.max(0, parseFloat(lotSize.toFixed(4)));
    } else {
        // Standard Forex: 1 pip = 0.0001, lot = 100,000 units
        const pips = slDistance / 0.0001;
        const costPerPip = 10; // ~$10 per pip for 1 standard lot
        const lotSize = riskAmount / (pips * costPerPip);
        return Math.max(0, parseFloat(lotSize.toFixed(4)));
    }
}

// ─── Order Execution ───

/**
 * Execute a market order on cTrader.
 * Returns the result with positionId for tracking.
 */
export async function executeMarketOrder(params: CTraderOrderParams): Promise<CTraderOrderResult> {
    const {
        ticker,
        direction,
        slPrice,
        tp1Price,
        tp2Price,
        riskPercent = config.CTRADER_RISK_PERCENT
    } = params;

    // Ensure connection
    if (!isCTraderReady()) {
        const connected = await connectCTrader();
        if (!connected) {
            return { success: false, error: 'No se pudo conectar a cTrader' };
        }
    }

    // Check max positions
    try {
        const state = await ctClient.getState();
        const positions = state?.positions || [];
        if (positions && positions.length >= config.CTRADER_MAX_POSITIONS) {
            return { 
                success: false, 
                error: `Máximo de posiciones abiertas alcanzado (${config.CTRADER_MAX_POSITIONS})` 
            };
        }
    } catch (err: any) {
        console.warn('[CTRADER] ⚠️ No se pudo verificar posiciones abiertas:', err.message);
    }

    // 🛡️ FIX (30-sep-2026): guardrail de sanidad de niveles ANTES de tocar el broker.
    // Caso real NZDUSD 30-sep: SELL con SL POR DEBAJO del entry → TRADING_BAD_STOPS.
    // Abortar acá evita la ronda de ida/vuelta con el broker y deja el SKIP limpio.
    const entryNum = Number(params.entryPrice);
    const slNum = Number(slPrice);
    if (Number.isFinite(entryNum) && Number.isFinite(slNum)) {
        const slSideOk = direction === 'BUY' ? slNum < entryNum : slNum > entryNum;
        if (!slSideOk) {
            const msg = `Niveles inválidos para ${direction}: SL (${slNum}) del lado equivocado del entry (${entryNum}). Trade abortado por seguridad.`;
            console.warn(`[CTRADER] 🛡️ ${msg}`);
            return { success: false, error: msg };
        }
    }
    if (tp2Price !== undefined && tp2Price !== null && Number.isFinite(Number(tp2Price)) && Number.isFinite(entryNum)) {
        const tpNum = Number(tp2Price);
        const tpSideOk = direction === 'BUY' ? tpNum > entryNum : tpNum < entryNum;
        if (!tpSideOk) {
            const msg = `Niveles inválidos para ${direction}: TP2 (${tpNum}) del lado equivocado del entry (${entryNum}). Trade abortado por seguridad.`;
            console.warn(`[CTRADER] 🛡️ ${msg}`);
            return { success: false, error: msg };
        }
    }

    // 🛡️ FIX Paso 2 (05-oct-2026): validar SL contra el spread VIVO, no solo contra el entry.
    // El broker exige BUY: SL <= bid actual; SELL: SL >= ask actual. Casos reales medidos:
    // BAD_STOPS en rollover (spread ~19 pips) y spikes de noticias → posición abierta sin
    // protección → cierre de emergencia pagando comisión+spread. Abortar ANTES del broker.
    const liveBA = lastBidAsk.get(ticker);
    if (liveBA && Date.now() - liveBA.ts < 30_000 && Number.isFinite(slNum)) {
        const liveSpread = Math.abs(liveBA.ask - liveBA.bid);
        const pad = 0.5 * liveSpread;
        const slVsLive = direction === 'BUY' ? slNum < liveBA.bid - pad : slNum > liveBA.ask + pad;
        if (!slVsLive) {
            const msg = `SL (${slNum}) no despeja el spread vivo (bid=${liveBA.bid}, ask=${liveBA.ask}) para ${direction}. Trade abortado antes del broker.`;
            console.warn(`[CTRADER] 🛡️ ${msg}`);
            return { success: false, error: msg };
        }
    }

    try {
        // Get account info for lot calculation
        const accountInfo = await getAccountInfo();
        if (!accountInfo) {
            return { success: false, error: 'No se pudo obtener info de la cuenta' };
        }

        // Get current market price
        const currentPrice = params.entryPrice;
        
        // Calculate lot size
        let lots = calculateLotSize(
            accountInfo.equity,
            currentPrice,
            slPrice,
            riskPercent,
            ticker
        );

        // Map JARVIS ticker to cTrader symbol name
        const ctraderSymbol = mapToCTraderSymbol(ticker);
        
        let info: any = null;
        try {
            info = await ctClient.getSymbolInfo(ctraderSymbol);
        } catch(e) {
            console.warn('[CTRADER] ⚠️ No se pudo obtener symbolInfo para ajustar lotaje');
        }

        const tUpper = ctraderSymbol.toUpperCase();
        
        let lotSizeCents = info?.lotSize;
        let stepVolumeCents = info?.stepVolume || 100000; // default for forex
        let minVolumeCents = info?.minVolume || stepVolumeCents;

        // 🛡️ FIX (15-sep-2026): micro-lotes en XAUUSD VERIFICADOS empíricamente en demo —
        // orden de 0.01 lote enviada y ACEPTADA por el broker. El override previo de
        // 1.00 lote se basaba en UN rechazo del 07-sep (cuando el API reportaba minVolume
        // inconsistente) y abortaba los trades de oro sin motivo (ej. 15/9: 0.0648 lotes
        // necesarios vs "mínimo" falso de 1.00). minVolumeCents=100 = 0.01 lote (lotSize 10000).
        // NOTA: US 500 SÍ exige 1.00 lote real (TRADING_BAD_VOLUME verificado) — sin override,
        // se respeta el minVolume reportado por el broker.
        if (tUpper.includes('XAU') || tUpper.includes('GOLD')) {
            minVolumeCents = Math.max(minVolumeCents, 100); // 0.01 lote de oro (mínimo real)
        }
        
        if (!lotSizeCents) {
            if (tUpper.includes('XAU') || tUpper.includes('GOLD')) lotSizeCents = 10000; // 100 units
            else if (tUpper.includes('BTC') || tUpper.includes('ETH')) lotSizeCents = 100; // 1 unit
            else if (tUpper.includes('US30') || tUpper.includes('NAS') || tUpper.includes('SPX') || tUpper.includes('US100') || tUpper.includes('USTEC')) lotSizeCents = 100; // 1 unit
            else if (tUpper.includes('XAG') || tUpper.includes('SILVER')) lotSizeCents = 500000; // 5000 units
            else lotSizeCents = 10000000; // 100k units (forex)
        }

        if (!info || !info.stepVolume) {
            if (tUpper.includes('BTC') || tUpper.includes('ETH')) {
                stepVolumeCents = 1; // 0.01 units
                minVolumeCents = 1;
            } else if (tUpper.includes('US30') || tUpper.includes('NAS') || tUpper.includes('SPX') || tUpper.includes('US100') || tUpper.includes('USTEC')) {
                stepVolumeCents = 10; // 0.1 units
                minVolumeCents = 10;
            } else if (tUpper.includes('XAU') || tUpper.includes('GOLD')) {
                stepVolumeCents = 100; // 1 unit
                minVolumeCents = 100;
            }
        }

        // El lotSize que devuelve la API ya está en centavos (ej: EURUSD = 10,000,000; BTCUSD = 100)
        let exactRequiredCents = lots * lotSizeCents;
        
        // GUARDRAIL DE RIESGO: Si el volumen necesario para mantener el 1% es menor al mínimo del broker,
        // no debemos forzar el mínimo ni redondear hacia arriba, porque expondríamos la cuenta a una pérdida mayor.
        if (exactRequiredCents < minVolumeCents) {
            const riskMsg = `Volumen requerido exacto (${(exactRequiredCents / lotSizeCents).toFixed(4)} lotes) es menor al mínimo del broker (${minVolumeCents / lotSizeCents} lotes). Trade abortado por exceso de riesgo.`;
            console.warn(`[CTRADER] ⛔ ${riskMsg}`);
            return { success: false, error: riskMsg };
        }

        // Alinear al stepVolume (incremento mínimo)
        let correctVolumeCents = Math.round(exactRequiredCents / stepVolumeCents) * stepVolumeCents;

        if (info && info.maxVolume) {
            correctVolumeCents = Math.min(info.maxVolume, correctVolumeCents);
        }

        // Convertir a lotes reales SOLO para el display y el fallback MARKET (ctClient.buy/sell).
        // 🛡️ FIX display: correctVolumeCents está en CENTAVOS de moneda base (1 lote forex = 10,000,000 centavos).
        // Antes se dividía por 100,000 (factor de unidades) → el log mostraba "24 lotes" cuando eran 0.24.
        // El `volume` que se manda al protocolo SIGUE siendo correctVolumeCents (centavos), sin tocar.
        lots = correctVolumeCents / (lotSizeCents || 10000000);

        console.log(`[CTRADER] 📊 Calculado: ${lots} lotes | Equity: $${accountInfo.equity} | Risk: ${riskPercent}% | SL dist: ${Math.abs(currentPrice - slPrice).toFixed(5)}`);

        // ─── Ejecución con cap de slippage + telemetría (arrival vs fill) ───
        const digits = info?.digits ?? await getSymbolDigits(info?.symbolId, ctraderSymbol);
        const roundTo = (val: number, d: number) => Number(val.toFixed(d));
        // pipSize derivado de digits: 5d→0.0001, 4d→0.0001, 3d→0.01, 2d→0.01, 1d→1 punto
        const pipSize = digits % 2 === 1 ? 10 * Math.pow(10, -digits) : Math.pow(10, -digits);

        // 🆕 ago-2026: anclar el rango al ÚLTIMO precio VIVO del feed (SpotEvent de cTrader).
        // El currentPrice del radar puede tener minutos de atraso en pares de bajo tickeo
        // (madrugada asiática) → el MARKET_RANGE quedaba anclado a un precio viejo, el
        // mercado se había movido → INTERNALLY_REJECTED. Con el precio vivo (<10s), el
        // rango se calcula contra el mercado REAL del instante.
        const live = lastBidAsk.get(ticker);
        const arrivalPrice = (live && Date.now() - live.ts < 10_000)
            ? (direction === 'BUY' ? live.ask : live.bid)
            : currentPrice;
        const t0 = Date.now();
        const tp = tp2Price || tp1Price;
        const formattedSl = roundTo(slPrice, digits);
        const formattedTp = tp ? roundTo(tp, digits) : undefined;

        let positionId = '';
        let executedPrice = arrivalPrice;
        let orderType: 'MARKET_RANGE' | 'MARKET' = 'MARKET';
        let sltpAttached = false;

        // 🛡️ MARKET_RANGE: mercado con cap de slippage nativo de cTrader + SL/TP atómico.
        // Cap adaptativo: max(2 × spread estructural, 0.2 pip), techo CTRADER_MAX_SLIPPAGE_PIPS.
        if (config.CTRADER_MARKET_RANGE && info?.symbolId) {
            try {
                const structuralSpread = tickFlow.getStructuralSpread(ticker) ?? tickFlow.getSpread(ticker) ?? 0;
                let capDist = Math.max(2 * structuralSpread, 0.2 * pipSize);
                capDist = Math.min(capDist, config.CTRADER_MAX_SLIPPAGE_PIPS * pipSize);
                const slippageInPoints = Math.max(1, Math.round(capDist * Math.pow(10, digits)));

                const ev: any = await (ctClient as any).raw.trading.marketRangeOrder({
                    symbolId: info.symbolId,
                    tradeSide: direction === 'BUY' ? 1 : 2, // TradeSide.BUY=1, SELL=2
                    volume: correctVolumeCents, // centavos de moneda base (protocolo cTrader)
                    baseSlippagePrice: arrivalPrice,
                    slippageInPoints,
                    stopLoss: formattedSl,
                    ...(formattedTp !== undefined ? { takeProfit: formattedTp } : {}),
                    label: params.tradeId,
                });

                if (ev?.errorCode) {
                    // Rechazo limpio del servidor → NO se llenó nada, es seguro el fallback
                    throw Object.assign(new Error(`MARKET_RANGE rechazada (${ev.errorCode})`), { rejected: true });
                }
                // 🛡️ FIX: cTrader puede reservar positionId PERO rechazar el deal internamente.
                // Señal confiable de rechazo = dealStatus >= 4 (REJECTED/INTERNALLY_REJECTED/ERROR/MISSED)
                // o executionType ORDER_REJECTED (7).
                // ⚠️ NO tratar ORDER_ACCEPTED (execType=2) con filled=0 como rechazo: el fill llega
                // en un evento posterior. Eso disparaba el fallback MARKET y DUPLICABA la orden.
                const dealStatus = Number(ev?.deal?.dealStatus ?? 0);
                const execType = Number(ev?.executionType ?? 0);
                // DealStatus: FILLED=2, PARTIALLY_FILLED=3, REJECTED=4, INTERNALLY_REJECTED=5, ERROR=6, MISSED=7
                const rejectedDeal = dealStatus >= 4; // 4,5,6,7 = rechazos/errores
                if (execType === 7 || rejectedDeal) {
                    throw Object.assign(
                        new Error(`MARKET_RANGE rechazada internamente (dealStatus=${dealStatus}, execType=${execType})`),
                        { rejected: true }
                    );
                }
                const rawPid = ev?.position?.positionId ?? ev?.order?.positionId;
                if (rawPid === undefined || rawPid === null) {
                    throw new Error('MARKET_RANGE ejecutada sin positionId en el ExecutionEvent.');
                }
                positionId = String(rawPid);
                executedPrice = Number(ev?.deal?.executionPrice ?? ev?.position?.price ?? arrivalPrice) || arrivalPrice;
                orderType = 'MARKET_RANGE';
                sltpAttached = true;
            } catch (mrErr: any) {
                if (!mrErr.rejected) {
                    // Timeout/ambigüedad: la orden PUDO haberse llenado. No reintentar → posible doble fill.
                    throw mrErr;
                }
                console.warn(`[CTRADER] ⚠️ ${mrErr.message}. Fallback a MARKET clásico (sin cap de slippage).`);
            }
        }

        if (orderType === 'MARKET') {
            // 🛡️ FIX: fallback MARKET clásico. Usamos el raw protocol con correctVolumeCents (centavos),
            // igual que MARKET_RANGE. NO usar ctClient.buy/sell: su lotsToUnits() asume 1 lote=100,000
            // unidades, pero el protocolo cTrader espera centavos (1 lote=10,000,000) → mandaría 100× menos.
            let symbolId = info?.symbolId;
            if (symbolId === undefined) {
                symbolId = await (ctClient as any).symbols.resolveId(ctraderSymbol);
            }
            const ev: any = await (ctClient as any).raw.trading.marketOrder({
                symbolId,
                tradeSide: direction === 'BUY' ? 1 : 2,
                volume: correctVolumeCents,
                stopLoss: formattedSl,
                ...(formattedTp !== undefined ? { takeProfit: formattedTp } : {}),
                label: params.tradeId,
            });
            // 🛡️ FIX ago-2026: el fallback MARKET no leía el errorCode — un rechazo limpio del
            // servidor (errorCode presente) dejaba pasar una "posición fantasma".
            if (ev?.errorCode) {
                throw Object.assign(
                    new Error(`MARKET rechazada por el broker (${ev.errorCode})`),
                    { rejected: true }
                );
            }
            const dealStatus = Number(ev?.deal?.dealStatus ?? 0);
            if (dealStatus >= 4) { // REJECTED / INTERNALLY_REJECTED / ERROR / MISSED
                throw Object.assign(
                    new Error(`MARKET rechazada internamente (dealStatus=${dealStatus})`),
                    { rejected: true }
                );
            }
            const rawPositionId = ev?.position?.positionId ?? ev?.order?.positionId;
            if (rawPositionId === undefined || rawPositionId === null) {
                throw new Error('Orden ejecutada pero sin positionId en la respuesta.');
            }
            positionId = String(rawPositionId);
            executedPrice = Number(ev?.deal?.executionPrice ?? ev?.position?.price ?? currentPrice) || currentPrice;
            // 🛡️ Paso 2 (05-oct-2026): el fallback MARKET ahora manda SL/TP atómicos en la orden.
            // Marcar attached para saltear el amend post-fill (que era la fuente de BAD_STOPS
            // con posición desnuda y cierre de emergencia pagando comisión+spread).
            sltpAttached = true;
        }

        // 🛡️ FIX ago-2026: confirmar el FILL antes de tocar SL/TP (ver confirmOrderFilled).
        // Si el broker rechazó el deal, NO hay posición: error limpio, sin cierre de emergencia
        // ni ghost alerts. Si llenó (o no se confirma a tiempo), se sigue el flujo normal.
        const fillConfirm = await confirmOrderFilled(Number(positionId));
        if (fillConfirm.rejected) {
            // 🛡️ Paso 2 (05-oct-2026): enriquecer el rechazo con el detalle interno del broker
            // para poder diagnosticar INTERNALLY_REJECTED (horarios del símbolo, breaks, margen).
            const rejDetail = fillConfirm.deal
                ? (fillConfirm.deal.errorDescription ?? fillConfirm.deal.errorCode ?? fillConfirm.deal.rejectReason ?? `deal=${JSON.stringify(fillConfirm.deal).slice(0, 200)}`)
                : 'sin detalle del deal';
            throw new Error(`Orden rechazada por el broker (${fillConfirm.dealStatusName} | ${rejDetail}): el deal no se llenó. No se abrió posición.`);
        }
        // 🆕 ago-2026: corregir el precio de ejecución con el deal REAL del broker. El evento
        // inmediato de la orden puede reportar el precio del radar (ej. USOIL: bot creía 83.1312,
        // deal real 83.22). Con el precio real, slippage/journal/Telegram quedan exactos.
        if (fillConfirm.deal && Number(fillConfirm.deal.executionPrice) > 0) {
            const realPx = Number(fillConfirm.deal.executionPrice);
            if (Math.abs(realPx - executedPrice) > pipSize / 10) {
                console.log(`[CTRADER] 🔧 Precio de entrada corregido con deal real: ${executedPrice} → ${realPx} (${ticker})`);
                executedPrice = realPx;
            }
        }

        // SL/TP ABSOLUTOS sobre la posición ya abierta (skip si MARKET_RANGE ya los adjuntó)
        try {
            if (!sltpAttached) {
                // 🛡️ FIX ago-2026: reintentar el amend ante POSITION_NOT_OPEN — en aperturas de
                // mercado el fill puede registrarse segundos después del ExecutionEvent.
                const sltpParams = {
                    stopLoss: formattedSl,
                    ...(formattedTp !== undefined ? { takeProfit: formattedTp } : {}),
                };
                let amendRes = await amendSltpChecked(Number(positionId), sltpParams);
                for (let retry = 0; retry < 3 && !amendRes.ok && amendRes.errorCode === 'POSITION_NOT_OPEN'; retry++) {
                    console.warn(`[CTRADER] ⏳ Amend SL/TP con POSITION_NOT_OPEN (fill demorado?). Reintento ${retry + 1}/3 en 1.5s...`);
                    await new Promise(r => setTimeout(r, 1500));
                    amendRes = await amendSltpChecked(Number(positionId), sltpParams);
                }
                if (!amendRes.ok) {
                    throw new Error(`Broker rechazó SL/TP (${amendRes.errorCode}): ${amendRes.description ?? ''}`);
                }
            }
            // 🛡️ VERIFICACIÓN OBLIGATORIA: el broker debe reflejar la protección antes de declarar éxito.
            // (La lib descarta respuestas con errorCode → sin esto, un rechazo silencioso dejaría la
            // posición ABIERTA SIN SL/TP. Caso real: XTIUSD, TRADING_BAD_STOPS por decimales.)
            const verified = await verifyPositionProtection(Number(positionId), {
                stopLoss: formattedSl,
                ...(formattedTp !== undefined ? { takeProfit: formattedTp } : {}),
            }, 5, 1000);
            if (!verified) {
                throw new Error('SL/TP no verificados en el broker tras la orden (posible rechazo silencioso).');
            }
        } catch (amendErr: any) {
                console.error(`[CTRADER] 🚨 Error al establecer SL/TP en posID ${positionId}:`, amendErr.message);
                console.error(`[CTRADER] 🔴 Cerrando posición de emergencia para evitar riesgo no acotado...`);
                try {
                    await ctClient.close(Number(positionId));
                    console.log(`[CTRADER] ✅ Posición ${positionId} cerrada de emergencia exitosamente.`);
                } catch (closeErr: any) {
                    console.error(`[CTRADER] ❌ FATAL: No se pudo cerrar la posición ${positionId} de emergencia!`, closeErr.message);

                    // 🆕 (a) Persistir ghost_position para reconciliación al arranque
                    if (db) {
                        try {
                            await db.collection('ghost_positions').doc(String(positionId)).set({
                                positionId: String(positionId),
                                ticker,
                                direction,
                                lots,
                                reason: `SL/TP no adjuntado y cierre de emergencia falló: ${closeErr.message}`,
                                status: 'UNPROTECTED',
                                createdAt: Date.now(),
                            });
                        } catch (persistErr: any) {
                            console.error('[CTRADER] ❌ No se pudo persistir ghost_position:', persistErr.message);
                        }
                    }

                    // 🆕 (b) Retry del cierre con backoff
                    let closed = false;
                    for (const delayMs of [2000, 5000, 10000]) {
                        await new Promise(r => setTimeout(r, delayMs));
                        try {
                            await ctClient.close(Number(positionId));
                            closed = true;
                            console.log(`[CTRADER] ✅ Posición ${positionId} cerrada en reintento (backoff ${delayMs}ms).`);
                            if (db) db.collection('ghost_positions').doc(String(positionId)).delete().catch(() => {});
                            break;
                        } catch (retryErr: any) {
                            console.error(`[CTRADER] 🔄 Reintento fallido (${delayMs}ms):`, retryErr.message);
                        }
                    }

                    // 🆕 (c) Alerta Telegram crítica
                    try {
                        const { bot } = await import('../bot/telegram.js');
                        const statusTxt = closed ? 'CERRADA en reintento' : 'AÚN ABIERTA — CERRAR MANUALMENTE YA';
                        const msg = `🚨 <b>[GHOST POSITION — RIESGO NO ACOTADO]</b> 🚨\n\n` +
                            `Posición <b>${positionId}</b> (${ticker} ${direction}, ${lots} lotes) sin SL/TP y con cierre de emergencia fallido.\n` +
                            `Estado tras reintentos: <b>${statusTxt}</b>\n` +
                            `Causa: ${closeErr.message}\n\n` +
                            `💡 Revisar en cTrader y cerrar manualmente si sigue abierta.`;
                        for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                            await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' }).catch(() => {});
                        }
                    } catch (tgErr: any) {
                        console.error('[CTRADER] ❌ No se pudo enviar alerta Telegram de ghost position:', tgErr.message);
                    }
                }
                throw new Error(`Fallo al establecer SL/TP: ${amendErr.message}. Posición abortada por seguridad.`);
        }

        // 📈 Telemetría de ejecución: slippage (arrival vs fill) y latencia decisión→ack
        const ackLatencyMs = Date.now() - t0;
        const signedSlippage = direction === 'BUY' ? executedPrice - arrivalPrice : arrivalPrice - executedPrice;
        const slippagePips = signedSlippage / pipSize;
        console.log(`[EXEC] ${orderType} ${direction} ${ticker} | arrival=${arrivalPrice} fill=${executedPrice} | slip=${slippagePips.toFixed(2)} pips | ack=${ackLatencyMs}ms | posID=${positionId}`);
        if (db) {
            db.collection('execution_metrics').add({
                ticker, direction, orderType,
                arrivalPrice, executedPrice,
                slippagePips: Number(slippagePips.toFixed(3)),
                ackLatencyMs,
                lots,
                tradeId: params.tradeId,
                demo: config.CTRADER_DEMO,
                timestamp: Date.now(),
            }).catch((err: any) => console.error('[CTRADER] ❌ Fallo guardando execution_metrics:', err?.message ?? err));
        }

        console.log(`[CTRADER] ✅ Orden ejecutada: ${direction} ${ticker} | ${lots} lotes @ ${executedPrice} | posID: ${positionId}`);

        return {
            success: true,
            positionId: String(positionId),
            executedPrice,
            lots,
        };
    } catch (err: any) {
        console.error(`[CTRADER] ❌ Error ejecutando orden ${direction} ${ticker}:`, err.message);
        return { success: false, error: err.message };
    }
}

// ─── SL/TP helpers (verificación contra el broker) ───
// 🛡️ FIX ago-2026 (posición XTIUSD abierta SIN SL/TP): el broker rechaza protecciones
// con más decimales de los que el símbolo permite (TRADING_BAD_STOPS), y la lib ctrader-ts
// DESCARTA la respuesta de los amend/close → rechazo silencioso. Estos helpers:
// 1) resuelven los digits reales por symbolId (nunca 5 a ciegas),
// 2) leen el errorCode del server vía connection.request directo,
// 3) verifican el estado real de la posición tras cada operación.

const digitsCache = new Map<number, number>();

async function getSymbolDigits(symbolId?: number, fallbackName?: string): Promise<number> {
    if (symbolId && digitsCache.has(symbolId)) return digitsCache.get(symbolId)!;
    let digits: number | undefined;
    try {
        if (symbolId) {
            const info = await ctClient.getSymbolInfo(symbolId);
            if (info?.digits != null) digits = info.digits;
        }
    } catch { /* reintentamos por nombre */ }
    if (digits == null && fallbackName) {
        try {
            const info = await ctClient.getSymbolInfo(fallbackName);
            if (info?.digits != null) digits = info.digits;
        } catch { /* último recurso por clase de activo */ }
    }
    if (digits == null) {
        const n = (fallbackName ?? '').toUpperCase();
        if (n.includes('JPY') || n.includes('BTC') || n.includes('ETH')) digits = 3;
        else if (n.includes('XAU') || n.includes('XAG') || n.includes('XTI') || n.includes('OIL')
            || n.includes('500') || n.includes('TECH') || n.includes('SPX') || n.includes('NAS')
            || n.includes(' 30') || n.includes('US30') || n.includes('GER') || n.includes('DAX') || n.includes('DE40')) digits = 2;
        else digits = 5; // forex
    }
    if (symbolId) digitsCache.set(symbolId, digits);
    return digits;
}

async function amendSltpChecked(
    positionId: number,
    params: { stopLoss?: number; takeProfit?: number }
): Promise<{ ok: boolean; errorCode?: string; description?: string }> {
    const payload: any = {
        ctidTraderAccountId: parseInt(config.CTRADER_ACCOUNT_ID, 10) || 0,
        positionId,
    };
    if (params.stopLoss !== undefined) payload.stopLoss = params.stopLoss;
    if (params.takeProfit !== undefined) payload.takeProfit = params.takeProfit;
    const res = await (ctClient as any).connection.request(PayloadType.AMEND_POSITION_SLTP_REQ, payload);
    if (res?.errorCode) {
        return { ok: false, errorCode: String(res.errorCode), description: String(res.description ?? '') };
    }
    return { ok: true };
}

// 🛡️ FIX ago-2026: confirmar el FILL de la orden antes de tocar SL/TP.
// cTrader acepta la orden, devuelve positionId, y puede rechazar el deal internamente
// ~400ms después (filledVolume=0, dealStatus=5 INTERNALLY_REJECTED). La respuesta del
// marketOrder/marketRangeOrder llega ANTES del rechazo → el bot trataba una orden muerta
// como posición viva ("SL/TP no verificados" + cierre fantasma "Position not found").
async function confirmOrderFilled(positionId: number, timeoutMs = 8000): Promise<{ rejected: boolean; dealStatusName?: string; deal?: any }> {
    const deadline = Date.now() + timeoutMs;
    const names: Record<number, string> = { 1: 'UNKNOWN', 2: 'FILLED', 3: 'PARTIALLY_FILLED', 4: 'REJECTED', 5: 'INTERNALLY_REJECTED', 6: 'ERROR', 7: 'MISSED' };
    while (Date.now() < deadline) {
        try {
            const deals = await (ctClient as any).getDealsByPosition(positionId, Date.now() - 10 * 60 * 1000, Date.now());
            if (deals && deals.length > 0) {
                const last = deals[deals.length - 1];
                const st = Number(last.dealStatus ?? 0);
                if (st >= 4) {
                    return { rejected: true, dealStatusName: names[st] ?? `status_${st}`, deal: last };
                }
                if (st === 2 || st === 3) {
                    return { rejected: false, dealStatusName: names[st], deal: last };
                }
                // st 0/1 (in progress/unknown): seguir esperando el deal definitivo
            }
        } catch { /* reintentar */ }
        await new Promise(r => setTimeout(r, 500));
    }
    // Timeout sin deal definitivo → optimista (fills demorados los cubre verifyPositionProtection)
    return { rejected: false, dealStatusName: 'UNCONFIRMED' };
}

async function verifyPositionProtection(
    positionId: number,
    expected: { stopLoss?: number; takeProfit?: number },
    maxAttempts = 3,
    delayMs = 800
): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const state = await ctClient.getState();
            const pos = (state?.positions || []).find((p: any) => Number(p.positionId || p.id) === positionId);
            // 🛡️ FIX ago-2026: si la posición aún no aparece en el snapshot local (lag del broker
            // tras la orden, fill demorado), NO devolver false de inmediato — esperar y reintentar.
            // Sin esto, trades con fill demorado (apertura de semana) se abortaban en falso.
            if (!pos) {
                if (i < maxAttempts - 1) {
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }
                return false;
            }
            const slOk = expected.stopLoss === undefined
                || Math.abs(Number(pos.stopLoss ?? NaN) - expected.stopLoss) < 1e-6;
            const tpOk = expected.takeProfit === undefined
                || Math.abs(Number(pos.takeProfit ?? NaN) - expected.takeProfit) < 1e-6;
            if (slOk && tpOk) return true;
            await new Promise(r => setTimeout(r, delayMs));
        } catch { /* reintentar */ }
    }
    return false;
}

async function verifyVolumeReduced(
    positionId: number,
    expectedVolume: number,
    maxAttempts = 4,
    delayMs = 1000
): Promise<{ ok: boolean; volume?: number }> {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const state = await ctClient.getState();
            const pos = (state?.positions || []).find((p: any) => Number(p.positionId || p.id) === positionId);
            if (!pos) return { ok: true, volume: 0 }; // posición cerrada por completo: éxito
            const vol = Number(pos.tradeData?.volume ?? 0);
            if (vol <= expectedVolume + 1e-6) return { ok: true, volume: vol };
        } catch { /* reintentar */ }
        await new Promise(r => setTimeout(r, delayMs));
    }
    return { ok: false };
}

// ─── Position Management ───

/**
 * Modify stop loss of an existing position (e.g., move to breakeven).
 */
export async function modifyStopLoss(positionId: string, newSlPrice: number, _currentPrice?: number): Promise<boolean> {
    if (!isCTraderReady()) {
        const connected = await connectCTrader();
        if (!connected) return false;
    }

    try {
        const state = await ctClient.getState();
        const positions = state?.positions || [];
        const pos = positions?.find((p: any) => Number(p.positionId || p.id) === Number(positionId));
        if (!pos) {
            console.warn(`[CTRADER] ⚠️ Posición ${positionId} no encontrada para modificar SL.`);
            return false;
        }

        // 🛡️ digits REALES por symbolId — el payload de Position NO trae symbolName,
        // así que el camino viejo (symbolName → getSymbolInfo('')) SIEMPRE fallaba y
        // usaba digits=5 → TRADING_BAD_STOPS en símbolos de 2-3 dec (XTIUSD, XAUUSD...).
        const symbolId = Number(pos.tradeData?.symbolId ?? pos.symbolId ?? 0);
        const fallbackTicker = symbolToTicker.get(symbolId) ?? '';
        const digits = await getSymbolDigits(symbolId, fallbackTicker);

        const roundTo = (val: number, d: number) => Number(val.toFixed(d));
        const formattedSl = roundTo(newSlPrice, digits);

        let existingTp = undefined;
        if (pos && pos.takeProfit) {
            existingTp = pos.takeProfit;
        }

        // 🛡️ amend directo para leer el errorCode del server (la lib lo descarta)
        const amendRes = await amendSltpChecked(Number(positionId), {
            stopLoss: formattedSl,
            ...(existingTp !== undefined ? { takeProfit: existingTp } : {}),
        });
        if (!amendRes.ok) {
            console.error(`[CTRADER] ❌ Amend SL rechazado por el broker (${amendRes.errorCode}): ${amendRes.description ?? ''}`);
            return false;
        }

        // 🛡️ Verificación post-amend: el broker debe reflejar el SL pedido
        const verified = await verifyPositionProtection(Number(positionId), { stopLoss: formattedSl });
        if (!verified) {
            console.error(`[CTRADER] ❌ El broker no refleja el SL pedido (${formattedSl}) para posID ${positionId}.`);
            return false;
        }

        console.log(`[CTRADER] 🔧 SL modificado para posición ${positionId} → ${formattedSl} (Mantenido TP: ${existingTp ?? 'Ninguno'}) [verificado en broker]`);
        return true;
    } catch (err: any) {
        console.error(`[CTRADER] ❌ Error modificando SL de ${positionId}:`, err.message);
        return false;
    }
}

/**
 * Close a position completely.
 */
export async function closePosition(positionId: string): Promise<boolean> {
    if (!isCTraderReady()) {
        const connected = await connectCTrader();
        if (!connected) return false;
    }

    try {
        await ctClient.close(Number(positionId));
        console.log(`[CTRADER] 🔴 Posición ${positionId} cerrada completamente.`);
        return true;
    } catch (err: any) {
        console.error(`[CTRADER] ❌ Error cerrando posición ${positionId}:`, err.message);
        return false;
    }
}

/**
 * Close a partial volume of a position (e.g., 50% at TP1).
 */
export async function closePartial(positionId: string, percentToClose: number = 50): Promise<boolean> {
    if (!isCTraderReady()) {
        const connected = await connectCTrader();
        if (!connected) return false;
    }

    try {
        // Get current position volume
        const state = await ctClient.getState();
        const positions = state?.positions || [];
        const pos = positions?.find((p: any) => Number(p.positionId || p.id) === Number(positionId));
        
        if (!pos || !pos.tradeData || !pos.tradeData.volume) {
            console.warn(`[CTRADER] ⚠️ Posición ${positionId} no encontrada o sin volumen.`);
            return false;
        }

        const totalVolume = pos.tradeData.volume;
        
        // stepVolume REAL del símbolo por symbolId (el payload de Position NO trae symbolName)
        const symbolId = Number(pos.tradeData?.symbolId ?? pos.symbolId ?? 0);
        let step = 1;
        if (symbolId > 0) {
            try {
                const info = await ctClient.getSymbolInfo(symbolId);
                if (info?.stepVolume) step = info.stepVolume;
            } catch { /* fallback step=1 */ }
        }

        const volumeToClose = Math.floor((totalVolume * (percentToClose / 100)) / step) * step;

        // 🛡️ request directo para leer el errorCode (la lib lo descarta → falsos éxitos)
        const sendClose = async (vol: number) => {
            const res = await (ctClient as any).connection.request(PayloadType.CLOSE_POSITION_REQ, {
                ctidTraderAccountId: parseInt(config.CTRADER_ACCOUNT_ID, 10) || 0,
                positionId: Number(positionId),
                volume: vol,
            });
            if (res?.errorCode) {
                throw new Error(`Broker rechazó el cierre (${res.errorCode}): ${res.description ?? ''}`);
            }
        };

        if (volumeToClose < step) {
            // Cerrar el mínimo permitido en lugar de no cerrar nada
            const minClose = Math.min(step, totalVolume);
            await sendClose(minClose);
            const vrf = await verifyVolumeReduced(Number(positionId), totalVolume - minClose);
            if (!vrf.ok) {
                console.error(`[CTRADER] ❌ El broker no refleja el cierre mínimo (${minClose} unidades).`);
                return false;
            }
            console.log(`[CTRADER] 🟡 Posición ${positionId}: cerrado mínimo posible (${minClose} unidades). Restante en broker: ${vrf.volume} unidades.`);
            return true;
        }

        // Llamada a bajo nivel para cerrar exactamente el volumen deseado
        await sendClose(volumeToClose);

        // 🛡️ Verificación post-cierre: el broker debe reflejar el volumen reducido
        const verified = await verifyVolumeReduced(Number(positionId), totalVolume - volumeToClose);
        if (!verified.ok) {
            console.error(`[CTRADER] ❌ El broker no refleja el cierre parcial de ${volumeToClose} unidades (volumen sin cambios).`);
            return false;
        }
        console.log(`[CTRADER] 🟡 Posición ${positionId}: ${percentToClose}% cerrado (${volumeToClose} unidades). Restante en broker: ${verified.volume} unidades.`);
        return true;
    } catch (err: any) {
        console.error(`[CTRADER] ❌ Error cerrando parcial de ${positionId}:`, err.message);
        return false;
    }
}

// ─── Account Info ───

/**
 * 🆕 (ago-2026) Lee el último deal de cierre (parcial o total) de una posición:
 * precio ejecutado + PnL bruto en moneda de la cuenta (grossProfit / 10^moneyDigits).
 * Devuelve null si no hay deal de cierre. Lo usa el TP1-parcial para persistir
 * los datos del parcial en el journal (Diario Analítico).
 */
export async function getLastCloseDealForPosition(positionId: string): Promise<{ executionPrice: number; grossProfit: number } | null> {
    if (!isCTraderReady()) return null;
    try {
        const deals = await ctClient.getDealsByPosition(Number(positionId), Date.now() - 864e5, Date.now());
        const closeDeal = [...deals].reverse().find((d: any) => d?.closePositionDetail);
        if (!closeDeal) return null;
        const cp: any = closeDeal.closePositionDetail || {};
        const moneyDigits = Number((closeDeal as any).moneyDigits ?? cp.moneyDigits ?? 2);
        return {
            executionPrice: Number(closeDeal.executionPrice),
            grossProfit: Number(cp.grossProfit || 0) / Math.pow(10, moneyDigits),
        };
    } catch (e: any) {
        console.warn(`[CTRADER] no se pudo leer el deal de cierre de posID ${positionId}: ${e.message}`);
        return null;
    }
}

/**
 * Get current account balance, equity, and open positions count.
 */
export async function getAccountInfo(): Promise<CTraderAccountInfo | null> {
    if (!isCTraderReady()) {
        const connected = await connectCTrader();
        if (!connected) return null;
    }

    try {
        const state = await ctClient.getState();
        
        return {
            balance: state?.balance || 0,
            equity: state?.equity || state?.balance || 0,
            currency: accountCurrency || 'USD', // 🛡️ 24-sep-2026: moneda DETECTADA de cTrader (depositAssetId), no fija
            openPositions: state?.positions?.length || 0,
        };
    } catch (err: any) {
        console.error('[CTRADER] ❌ Error obteniendo info de cuenta:', err.message);
        return null;
    }
}

/**
 * Get open positions from cTrader.
 * @param ticker Optional ticker to filter by.
 */
export async function getOpenPositions(ticker?: string): Promise<any[]> {
    if (!isCTraderReady()) {
        return [];
    }
    try {
        const state = await ctClient.getState();
        let positions = state?.positions || [];
        if (ticker) {
            const want = ticker.toUpperCase();
            // El payload de Position NO trae symbolName — se resuelve con el mapa
            // local symbolToTicker (symbolId → ticker de las suscripciones del bot).
            // Antes el filtro comparaba contra campos inexistentes → devolvía todo.
            positions = positions.filter((p: any) => {
                const symId = p?.tradeData?.symbolId ?? p?.symbolId;
                if (symId == null) return false;
                const tk = symbolToTicker.get(Number(symId));
                return tk != null && tk.toUpperCase() === want;
            });
        }
        return positions;
    } catch (err: any) {
        console.error('[CTRADER] ❌ Error obteniendo posiciones:', err.message);
        return [];
    }
}

// ─── Emergency Close All ───

/**
 * KILLSWITCH: Close all open positions immediately.
 * Used for emergency risk management.
 */
/**
 * Deals históricos de una posición (para reconciliar cierres que el stream perdió).
 * 🛡️ FIX: el proto ProtoOADealListByPositionIdReq exige fromTimestamp/toTimestamp
 * como REQUERIDOS, pero el SDK ctrader-ts solo los envía si se los pasás. Sin rango,
 * el encode hace int64(undefined) → crash "Cannot read properties of undefined (reading 'low')".
 * Por eso pasamos un rango amplio (30 días) siempre.
 */
export async function getDealsByPosition(positionId: string): Promise<any[]> {
    if (!isCTraderReady()) return [];
    try {
        const to = Date.now();
        const from = to - 30 * 24 * 60 * 60 * 1000;
        // Nota: ctClient es el cliente HIGH-LEVEL de ctrader-ts → firma POSICIONAL
        // getDealsByPosition(positionId, from, to), que mapea a fromTimestamp/toTimestamp.
        return await ctClient.getDealsByPosition(Number(positionId), from, to);
    } catch (err: any) {
        console.error('[CTRADER] ❌ Error obteniendo deals de posición:', err.message);
        return [];
    }
}

/**
 * Nombre de símbolo desde symbolId (para adopción de huérfanos).
 */
export async function getSymbolName(symbolId: number): Promise<string> {
    if (!isCTraderReady()) return '';
    try {
        const symbols: any[] = await ctClient.getSymbols();
        const s = symbols.find((x: any) => x.symbolId === symbolId);
        return s?.symbolName || '';
    } catch (err: any) {
        console.error('[CTRADER] ❌ Error obteniendo símbolos:', err.message);
        return '';
    }
}

export async function closeAllPositions(): Promise<{ closed: number; failed: number }> {
    if (!isCTraderReady()) {
        const connected = await connectCTrader();
        if (!connected) return { closed: 0, failed: 0 };
    }

    try {
        const state = await ctClient.getState();
        const positions = state?.positions || [];
        if (!positions || positions.length === 0) {
            console.log('[CTRADER] No hay posiciones abiertas para cerrar.');
            return { closed: 0, failed: 0 };
        }

        let closed = 0;
        let failed = 0;

        for (const pos of positions) {
            const id = String(pos.positionId || pos.id);
            try {
                await ctClient.close(Number(id));
                closed++;
                console.log(`[CTRADER] 🔴 Posición ${id} cerrada (killswitch).`);
            } catch {
                failed++;
                console.error(`[CTRADER] ❌ No se pudo cerrar posición ${id} (killswitch).`);
            }
        }

        console.log(`[CTRADER] 🚨 KILLSWITCH: ${closed} cerradas, ${failed} fallidas.`);
        return { closed, failed };
    } catch (err: any) {
        console.error('[CTRADER] ❌ Error en killswitch:', err.message);
        return { closed: 0, failed: 0 };
    }
}

// ─── Symbol Mapping ───

/**
 * Map JARVIS/TradingView ticker names to cTrader symbol names.
 * cTrader symbol names vary by broker, so this may need adjustment.
 */
function mapToCTraderSymbol(ticker: string): string {
    const t = ticker.toUpperCase();
    
    // Common mappings (Funding Pips cTrader)
    const map: Record<string, string> = {
        'EURUSD': 'EURUSD',
        'GBPUSD': 'GBPUSD',
        'USDJPY': 'USDJPY',
        'USDCAD': 'USDCAD',
        'AUDUSD': 'AUDUSD',
        'AUDCAD': 'AUDCAD',
        'NZDUSD': 'NZDUSD',
        'USDCHF': 'USDCHF',
        'EURJPY': 'EURJPY',
        'GBPJPY': 'GBPJPY',
        'EURGBP': 'EURGBP',
        'XAUUSD': 'XAUUSD',
        'USOIL': 'XTIUSD',
        'BTCUSD': 'BTCUSD',
        'AUDJPY': 'AUDJPY',
        'GER40': 'GERMANY 40',
        'DE40': 'GERMANY 40',
        'JP225': 'JAPAN 225',
        'NIKKEI225': 'JAPAN 225',
        'JAPAN225': 'JAPAN 225',
        'NIKKEI': 'JAPAN 225',
        'US100': 'US TECH 100',   // Usuario reporta que su broker lo llama 'US TECH 100'
        'NAS100': 'US TECH 100',
        'US30': 'US 30',          // Mapeo corregido a 'US 30'
        'DOW30': 'US 30',
        'US500': 'US 500',        // Mapeo corregido a 'US 500'
        'SPX500': 'US 500',
        // 🆕 27-sep-2026: universo completo Funding Pips (fuente: scripts/asset_scout.ts UNIVERSE)
        'USTECH100': 'US TECH 100',
        'FRA40': 'FRANCE 40',
        'UK100': 'UK 100',
        'SPAIN35': 'SPAIN 35',
        'NL25': 'NETHERLANDS 25',
        'ITALY40': 'ITALY 40',
        'EUROPE50': 'EUROPE 50',
        'AUSTRALIA200': 'AUSTRALIA 200',
        'XAGUSD': 'XAGUSD',
        'XPTUSD': 'XPTUSD',
        'XPDUSD': 'XPDUSD',
        'XBRUSD': 'XBRUSD',
        'NATGAS': 'NAT.GAS',
        'CADJPY': 'CADJPY',
        'GBPAUD': 'GBPAUD',
        'AUDNZD': 'AUDNZD',
        'EURAUD': 'EURAUD',
        'EURCAD': 'EURCAD',
        'GBPCAD': 'GBPCAD',
        'AUDCHF': 'AUDCHF',
        'GBPNZD': 'GBPNZD',
        'CADCHF': 'CADCHF',
        'GBPCHF': 'GBPCHF',
        'NZDCHF': 'NZDCHF',
        'NZDCAD': 'NZDCAD',
        'EURNZD': 'EURNZD',
        'NZDJPY': 'NZDJPY',
        'CHFJPY': 'CHFJPY',
        'EURCHF': 'EURCHF',
    };

    // Try exact match first
    if (map[t]) return map[t];
    
    // Try partial match
    for (const [key, value] of Object.entries(map)) {
        if (t.includes(key)) return value;
    }
    
    // Fallback: return as-is
    console.warn(`[CTRADER] ⚠️ Símbolo ${ticker} no mapeado. Usando tal cual.`);
    return t;
}

// ─── Status for Health Check ───

export function getCTraderStatus(): {
    connected: boolean;
    demo: boolean;
    configured: boolean;
} {
    return {
        connected: isConnected,
        demo: config.CTRADER_DEMO,
        configured: !!(config.CTRADER_CLIENT_ID && config.CTRADER_ACCESS_TOKEN),
    };
}

export async function getCTraderTrendbars(ticker: string, period: TrendbarPeriod, count: number) {
    if (!isConnected || !ctClient) {
        throw new Error("cTrader no está conectado.");
    }
    const ctraderSymbol = mapToCTraderSymbol(ticker);
    try {
        const result = await ctClient.getTrendbars(ctraderSymbol, { period, count });
        return result.trendbars;
    } catch (e: any) {
        console.error(`[CTRADER] Error fetching trendbars for ${ticker}:`, e.message);
        throw e;
    }
}
