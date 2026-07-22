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

let ctClient: any = null;
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
    let lotMultiplier: number;
    const t = ticker.toUpperCase();
    
    if (t.includes('JPY')) {
        // JPY pairs: 1 pip = 0.01, lot = 100,000 units
        pipValue = slDistance / 0.01;
        lotMultiplier = 100000;
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
        riskPercent = config.CTRADER_RISK_PERCENT,
        tradeId
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
        let correctVolumeCents = lots * lotSizeCents;
        
        // Alinear al stepVolume (incremento mínimo)
        correctVolumeCents = Math.round(correctVolumeCents / stepVolumeCents) * stepVolumeCents;
        
        // Asegurar límites min y max
        correctVolumeCents = Math.max(minVolumeCents, correctVolumeCents);
        if (info && info.maxVolume) {
            correctVolumeCents = Math.min(info.maxVolume, correctVolumeCents);
        }
        
        // Convertir al abstracción "lots" de ctrader-ts (siempre divide por 100,000)
        lots = correctVolumeCents / 100000;

        console.log(`[CTRADER] 📊 Calculado: ${lots} lotes | Equity: $${accountInfo.equity} | Risk: ${riskPercent}% | SL dist: ${Math.abs(currentPrice - slPrice).toFixed(5)}`);

        // Execute order
        let position: any;
        if (direction === 'BUY') {
            position = await ctClient.buy(ctraderSymbol, { lots });
        } else {
            position = await ctClient.sell(ctraderSymbol, { lots });
        }

        const rawPositionId = position?.positionId ?? position?.id;
        if (rawPositionId === undefined || rawPositionId === null) {
            throw new Error('Orden ejecutada pero sin positionId en la respuesta.');
        }
        const positionId = String(rawPositionId);
        const executedPrice = position?.entryPrice || position?.price || currentPrice;

        // SL/TP ABSOLUTOS sobre la posición ya abierta
        await (ctClient as any).raw.trading.amendPositionSltp(Number(positionId), {
            stopLoss: slPrice,
            takeProfit: tp2Price || tp1Price,
        });

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
export async function modifyStopLoss(positionId: string, newSlPrice: number, currentPrice?: number): Promise<boolean> {
    if (!isCTraderReady()) {
        const connected = await connectCTrader();
        if (!connected) return false;
    }

    try {
        const state = await ctClient.getState();
        const positions = state?.positions || [];
        const pos = positions?.find((p: any) => Number(p.positionId || p.id) === Number(positionId));
        
        let existingTp = undefined;
        if (pos && pos.takeProfit) {
            existingTp = pos.takeProfit;
        }

        // Usar la API de bajo nivel de ctrader-ts para forzar el absolutePrice y preservar el TP si existe
        await (ctClient as any).raw.trading.amendPositionSltp(Number(positionId), { 
            stopLoss: newSlPrice,
            ...(existingTp !== undefined ? { takeProfit: existingTp } : {})
        });
        console.log(`[CTRADER] 🔧 SL modificado para posición ${positionId} → ${newSlPrice} (Mantenido TP: ${existingTp || 'Ninguno'})`);
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
            const mappedTicker = mapToCTraderSymbol(ticker).toUpperCase();
            positions = positions.filter((p: any) => {
                const sym = (p.symbolName || p.tradeData?.symbolName || '').toUpperCase();
                return sym === mappedTicker || sym.includes(mappedTicker) || mappedTicker.includes(sym);
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
        'NZDUSD': 'NZDUSD',
        'USDCHF': 'USDCHF',
        'EURJPY': 'EURJPY',
        'GBPJPY': 'GBPJPY',
        'EURGBP': 'EURGBP',
        'XAUUSD': 'XAUUSD',
        'BTCUSD': 'BTCUSD',
        'US100': 'US TECH 100',   // Usuario reporta que su broker lo llama 'US TECH 100'
        'NAS100': 'US TECH 100',
        'US30': 'US30',
        'SPX500': 'US500',
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
