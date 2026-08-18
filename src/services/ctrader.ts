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
import { TrendbarPeriod } from 'ctrader-ts';
import { db } from '../db/memory.js';
import { addCandles, OHLCV } from '../db/market_data.js';
import { tickFlow } from '../engine/TickFlow.js';

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
let isConnected = false;
let connectingPromise: Promise<boolean> | null = null;
const MAX_RECONNECT_ATTEMPTS = 5;
const CONNECT_TIMEOUT_MS = 20_000;

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
            
            setupCTraderEvents(client);
            
            // Invalidar el flag cuando el SDK reporte desconexión definitiva
            client.connection.onEvent('stateChange', (s: any) => {
                if (s.status === 'disconnected' && ctClient === client) {
                    isConnected = false;
                    ctClient = null;
                    console.error('[CTRADER] 🚨 Feed perdido. Reiniciando para re-suscripción limpia...');
                    setTimeout(() => process.exit(1), 2000); // PM2 re-levanta y re-suscribe
                }
            });
            
            return true;
        } catch (err: any) {
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
            
            // ─── Extraer PnL del deal ───
            // El grossProfit en cTrader Open API viene en centavos (moneyDigits=2),
            // pero para ser robustos, usamos moneyDigits si está disponible.
            let dealPnl = 0;
            if (event.deal && event.deal.closePositionDetail) {
                const rawProfit = Number(event.deal.closePositionDetail.grossProfit || 0);
                const moneyDigits = event.deal.moneyDigits || 2;
                dealPnl = rawProfit / Math.pow(10, moneyDigits);
            } else if (event.deal && event.deal.grossProfit) {
                const rawProfit = Number(event.deal.grossProfit);
                const moneyDigits = event.deal.moneyDigits || 2;
                dealPnl = rawProfit / Math.pow(10, moneyDigits);
            }
            
            const positionStatus = event.position.positionStatus; // 3 = CLOSED, 2 = OPEN, 1 = CREATED
            
            // Acumular PnL de deals parciales (no sobreescribir)
            const previousPnl = trade.ctrader_real_pnl || 0;
            const accumulatedPnl = Number((previousPnl + dealPnl).toFixed(2));
            
            // Posición cerrada completamente (Hit SL o Hit TP final)
            if (positionStatus === 3) {
                let resultStatus: string;
                if (accumulatedPnl > 1) resultStatus = 'WIN';
                else if (accumulatedPnl < -1) resultStatus = 'LOSS';
                else resultStatus = 'BREAKEVEN';
                
                await tradeDoc.ref.update({
                    result: resultStatus,
                    ctrader_real_pnl: accumulatedPnl,
                    status: 'CLOSED'
                });
                console.log(`[CTRADER-EVENT] Trade #${tradeDoc.id} cerrado. PnL Acumulado: $${accumulatedPnl} -> ${resultStatus}`);
            } 
            // Posición aún abierta pero hubo un deal (cierre parcial)
            else if (positionStatus === 2 && event.deal && dealPnl !== 0) {
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
                                        spotTickListener?.(baseTicker, lastCandle);

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
                    const tickerObj = Array.from(subscribedSymbols.entries()).find(([, v]) => v === symbolId);
                    
                    if (tickerObj) {
                        const ticker = tickerObj[0]; // e.g. "EURUSD:M5"
                        
                        const newCandles = msg.trendbar.map((tb: any) => {
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
                        
                        // 🔍 DIAGNÓSTICO: loguear trendbars recibidos para confirmar que cTrader los envía
                        const tsFirst = newCandles[0]?.timestamp ? new Date(newCandles[0].timestamp).toISOString() : '???';
                        const tsLast = newCandles[newCandles.length - 1]?.timestamp ? new Date(newCandles[newCandles.length - 1].timestamp).toISOString() : '???';
                        console.log(`[CTRADER-TB] 📊 Trendbars recibidos: ${ticker} ×${newCandles.length} (${tsFirst} → ${tsLast})`);
                        
                        // Agregar o actualizar las velas en el buffer
                        const [baseTicker, period] = ticker.split(':');
                        import('../db/market_data.js').then(({ addCandles }) => {
                            addCandles(baseTicker, period, newCandles);
                            
                            // Enviar al motor SMC (heavy processing)
                            import('../engine/smc/SMCManager.js').then(({ smcManager }) => {
                                smcManager.processLiveCandles(baseTicker, period, newCandles);
                            }).catch(err => console.error('[CTRADER] Error procesando SMC:', err));
                        });
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

// 🆕 Fase 1: listener de ticks spot para el SMCBridge (PING de precio nativo).
// Se invoca con (baseTicker, vela actualizada por el tick) desde el handler de SpotEvent.
type SpotTickListener = (baseTicker: string, candle: OHLCV) => void;
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
        await ctClient.raw.market.subscribeSpots([symbolId]);
        await ctClient.raw.market.subscribeLiveTrendbar(symbolId, period);
        console.log(`[CTRADER] 📡 Suscrito exitosamente a Live Trendbars para ${ctraderSymbol} (${periodStr})`);
        
    } catch (err: any) {
        console.error(`[CTRADER] ❌ Error suscribiendo a Live Trendbars para ${ctraderSymbol}:`, err.message);
        throw err;
    }
}

/**
 * Inicializa el escáner global suscribiéndose a todos los activos y temporalidades.
 */
export async function initializeScanner() {
    console.log('[CTRADER] 🚀 Inicializando Escáner Global SMC...');
    
    if (!isConnected || !ctClient) {
        const connected = await connectCTrader();
        if (!connected) {
            console.error('[CTRADER] No se pudo iniciar el escáner por falta de conexión.');
            return;
        }
    }

    const assets = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'USDCAD', 'NZDUSD', 'BTCUSD', 'USOIL'];
    const timeframes = [
        { p: TrendbarPeriod.M5, str: 'M5' },
        { p: TrendbarPeriod.M15, str: 'M15' },
        { p: TrendbarPeriod.H1, str: 'H1' },
        { p: TrendbarPeriod.H4, str: 'H4' },
        { p: TrendbarPeriod.D1, str: 'D1' },
        { p: TrendbarPeriod.W1, str: 'W1' }
    ];

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
        return Math.max(0.01, parseFloat(lotSize.toFixed(2)));
    } else if (t.includes('XAU') || t.includes('GOLD')) {
        // Gold: 1 pip = 0.1, lot = 100 oz
        const pips = slDistance / 0.1;
        const costPerPip = 10; // ~$10 per pip for 1 lot of gold
        const lotSize = riskAmount / (pips * costPerPip);
        return Math.max(0.01, parseFloat(lotSize.toFixed(2)));
    } else if (t.includes('BTC')) {
        // Bitcoin: no standard pip, use raw price distance
        const costPerUnit = 1; // $1 per unit per 1 lot (varies by broker)
        const lotSize = riskAmount / (slDistance * costPerUnit);
        return Math.max(0.01, parseFloat(lotSize.toFixed(2)));
    } else if (t.includes('US30') || t.includes('NAS') || t.includes('US100') || t.includes('SPX')) {
        // Indices: 1 pip = 1 point
        const costPerPoint = 1; // $1 per point per 1 lot (varies)
        const lotSize = riskAmount / (slDistance * costPerPoint);
        return Math.max(0.01, parseFloat(lotSize.toFixed(2)));
    } else {
        // Standard Forex: 1 pip = 0.0001, lot = 100,000 units
        const pips = slDistance / 0.0001;
        const costPerPip = 10; // ~$10 per pip for 1 standard lot
        const lotSize = riskAmount / (pips * costPerPip);
        return Math.max(0.01, parseFloat(lotSize.toFixed(2)));
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
            const riskMsg = `Volumen requerido exacto (${(exactRequiredCents / 100).toFixed(2)} lotes) es menor al mínimo del broker (${minVolumeCents / 100} lotes). Trade abortado por exceso de riesgo.`;
            console.warn(`[CTRADER] ⛔ ${riskMsg}`);
            return { success: false, error: riskMsg };
        }

        // Alinear al stepVolume (incremento mínimo)
        let correctVolumeCents = Math.round(exactRequiredCents / stepVolumeCents) * stepVolumeCents;
        
        if (info && info.maxVolume) {
            correctVolumeCents = Math.min(info.maxVolume, correctVolumeCents);
        }
        
        // Convertir al abstracción "lots" de ctrader-ts (siempre divide por 100,000)
        lots = correctVolumeCents / 100000;

        console.log(`[CTRADER] 📊 Calculado: ${lots} lotes | Equity: $${accountInfo.equity} | Risk: ${riskPercent}% | SL dist: ${Math.abs(currentPrice - slPrice).toFixed(5)}`);

        // ─── Ejecución con cap de slippage + telemetría (arrival vs fill) ───
        const digits = info?.digits ?? 5;
        const roundTo = (val: number, d: number) => Number(val.toFixed(d));
        // pipSize derivado de digits: 5d→0.0001, 4d→0.0001, 3d→0.01, 2d→0.01, 1d→1 punto
        const pipSize = digits % 2 === 1 ? 10 * Math.pow(10, -digits) : Math.pow(10, -digits);

        const arrivalPrice = currentPrice; // precio al decidir (proxy de arrival)
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
                    volume: correctVolumeCents, // unidades de protocolo (1 lote = 100.000)
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
            const position: any = direction === 'BUY'
                ? await ctClient.buy(ctraderSymbol, { lots })
                : await ctClient.sell(ctraderSymbol, { lots });

            const rawPositionId = position?.positionId ?? position?.id;
            if (rawPositionId === undefined || rawPositionId === null) {
                throw new Error('Orden ejecutada pero sin positionId en la respuesta.');
            }
            positionId = String(rawPositionId);
            executedPrice = position?.entryPrice || position?.price || currentPrice;
        }

        // SL/TP ABSOLUTOS sobre la posición ya abierta (skip si MARKET_RANGE ya los adjuntó)
        if (!sltpAttached) {
            try {
                await (ctClient as any).raw.trading.amendPositionSltp(Number(positionId), {
                    stopLoss: formattedSl,
                    ...(formattedTp !== undefined ? { takeProfit: formattedTp } : {})
                });
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
        
        // Obtener digits para el símbolo (fallback a 5)
        let digits = 5;
        try {
            const symbolName = pos.symbolName || pos.tradeData?.symbolName || '';
            if (symbolName) {
                const symInfo = await ctClient.getSymbolInfo(symbolName);
                if (symInfo?.digits) digits = symInfo.digits;
            }
        } catch { /* ignorar error y usar 5 */ }

        const roundTo = (val: number, d: number) => Number(val.toFixed(d));
        const formattedSl = roundTo(newSlPrice, digits);
        
        let existingTp = undefined;
        if (pos && pos.takeProfit) {
            existingTp = pos.takeProfit;
        }

        // Usar la API de bajo nivel de ctrader-ts para forzar el absolutePrice y preservar el TP si existe
        await (ctClient as any).raw.trading.amendPositionSltp(Number(positionId), { 
            stopLoss: formattedSl,
            ...(existingTp !== undefined ? { takeProfit: existingTp } : {})
        });
        console.log(`[CTRADER] 🔧 SL modificado para posición ${positionId} → ${formattedSl} (Mantenido TP: ${existingTp || 'Ninguno'})`);
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
        
        // stepVolume REAL del símbolo, no deducido por divisibilidad
        const symbolName = pos.symbolName || pos.tradeData?.symbolName || '';
        let step = 1;
        try {
            const info = await ctClient.getSymbolInfo(symbolName);
            if (info?.stepVolume) step = info.stepVolume;
        } catch { /* fallback step=1 */ }

        const volumeToClose = Math.floor((totalVolume * (percentToClose / 100)) / step) * step;

        if (volumeToClose < step) {
            // Cerrar el mínimo permitido en lugar de no cerrar nada
            const minClose = Math.min(step, totalVolume);
            await (ctClient as any).raw.trading.closePosition(Number(positionId), minClose);
            console.log(`[CTRADER] 🟡 Posición ${positionId}: cerrado mínimo posible (${minClose} unidades).`);
            return true;
        }

        // Llamada a bajo nivel para cerrar exactamente el volumen deseado
        await (ctClient as any).raw.trading.closePosition(Number(positionId), volumeToClose);
        console.log(`[CTRADER] 🟡 Posición ${positionId}: ${percentToClose}% cerrado (${volumeToClose} unidades).`);
        return true;
    } catch (err: any) {
        console.error(`[CTRADER] ❌ Error cerrando parcial de ${positionId}:`, err.message);
        return false;
    }
}

// ─── Account Info ───

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
            currency: state?.currency || 'USD',
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
 */
export async function getDealsByPosition(positionId: string): Promise<any[]> {
    if (!isCTraderReady()) return [];
    try {
        return await ctClient.getDealsByPosition(Number(positionId));
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
        'US100': 'US TECH 100',   // Usuario reporta que su broker lo llama 'US TECH 100'
        'NAS100': 'US TECH 100',
        'US30': 'US 30',          // Mapeo corregido a 'US 30'
        'DOW30': 'US 30',
        'US500': 'US 500',        // Mapeo corregido a 'US 500'
        'SPX500': 'US 500',
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
