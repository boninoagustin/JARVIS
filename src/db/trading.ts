import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';
import { logTrade, recordResult } from '../services/journal.js';

// --- INTERFACES DEL RADAR JSON ---
interface RadarZone {
    tf?: string;
    dir: 'BUY' | 'SELL';
    top: number;
    btm: number;
    lvl?: string;
    medal?: string;
    score?: number;
    tp?: number;
    sl?: number;
    mid?: number;
    atr?: number;
    t?: string;      
    d?: 'BUY' | 'SELL';  
    p?: number;      
    b?: number;      
    lv?: string;     
    md?: string;     
    sc?: number;     
    mi?: number;     
    a?: number;      
    createdAt?: number;
}

function normalizeZone(raw: any): RadarZone {
    if (raw.t !== undefined && raw.tf === undefined) raw.tf = raw.t;
    if (raw.d !== undefined && raw.dir === undefined) raw.dir = raw.d;
    if (raw.p !== undefined && raw.top === undefined) raw.top = raw.p;
    if (raw.b !== undefined && raw.btm === undefined) raw.btm = raw.b;
    if (raw.lv !== undefined && raw.lvl === undefined) raw.lvl = raw.lv;
    if (raw.md !== undefined && raw.medal === undefined) raw.medal = raw.md;
    if (raw.sc !== undefined && raw.score === undefined) raw.score = raw.sc;
    if (raw.mi !== undefined && raw.mid === undefined) raw.mid = raw.mi;
    if (raw.a !== undefined && raw.atr === undefined) raw.atr = raw.a;
    return raw as RadarZone;
}

interface ScoreState {
    points: number;
    lastUpdate: number;
    events: string[];
}

interface ImpulseLeg {
    dir: 'BUY' | 'SELL';
    origin: number;
    extreme: number;
    createdAt: number;         // 🆕 Timestamp de creación (anti-pingpong)
    tp2?: number | null;       
    oteScored?: boolean;       
    isValidated?: boolean;     
    chochPoints?: number;
    chochEvents?: string[];
    chochReport?: string;
    bestZone?: RadarZone | null;
}

interface RadarState {
    lastSyncDate: string | null;
    zones: RadarZone[];
    activeLocks: string[];
    lastPrice: number | null;
    scoreBuy: ScoreState;
    scoreSell: ScoreState;
    marketBias: { [tf: string]: 'BUY' | 'SELL' | 'NEUTRAL' };
    lastApproachAlert?: number;
    lastSniperAlert?: number;
    nextZones?: RadarZone[];     
    lastHeartbeat?: number;       
    activeImpulseBuy?: ImpulseLeg | null;  
    activeImpulseSell?: ImpulseLeg | null; 
}

const emptyState = (): RadarState => ({
    lastSyncDate: null,
    zones: [],
    activeLocks: [],
    lastPrice: null,
    scoreBuy: { points: 0, lastUpdate: 0, events: [] },
    scoreSell: { points: 0, lastUpdate: 0, events: [] },
    marketBias: { "240": 'NEUTRAL', "60": 'NEUTRAL', "15": 'NEUTRAL', "3": 'NEUTRAL' },
    lastApproachAlert: 0,
    lastSniperAlert: 0,
    activeImpulseBuy: null,
    activeImpulseSell: null
});

const SETUP_MEMORY_WINDOW_MS = 21600000; // 6 Horas (cubre London → NY completo)

interface ActiveTrade {
    tradeId: string;
    journalId?: string;       
    ticker: string;
    direction: 'BUY' | 'SELL';
    entryPrice: number;
    tp1Price: number;         
    tp2Price: number;         
    slPrice: number;
    tp1Hit: boolean;          
    tp2Hit: boolean;          
    timestamp: number;
}

const activeTrades = new Map<string, ActiveTrade>();

// 🧠 NUEVA MEMORIA RAM (Evita lecturas/escrituras masivas en Firebase)
const localRadarStates = new Map<string, RadarState>();
const lastFirebaseSave = new Map<string, number>();

// 🏥 Export para healthcheck
let lastPingTime = 0;
export const getActiveTradeCount = () => activeTrades.size;
export const getLastPingTime = () => lastPingTime;

let consecutiveLosses = 0; 
let streakKillswitchUntil = 0;
let vixKillswitchUntil = 0;
let globalKillswitches: Record<string, boolean> = {};
let dynamicBotConfig = {
    sniperCooldownMs: 90000,      // 🔧 1.5 min (antes 2.5 min) — vela 3M cierra cada 3 min, 90s permite capturar setups sin esperar vela completa
    minPointsForBuy: 5,           // 🔧 Bajado de 6 a 5: filtro de dirección ahora es más estricto
    minPointsForSell: 5,          // 🔧 Bajado de 6 a 5: mismo criterio
    baseRiskPercentage: 1.0
};

// 🧠 INICIALIZACIÓN DE LA MEMORIA (Carga los trades de Firebase si el servidor se reinicia)
if (db) {
    try {
        db.collection('active_trades').get().then(snap => {
            snap.forEach(doc => {
                activeTrades.set(doc.id, doc.data() as ActiveTrade);
            });
            console.log(`[RADAR] 🧠 Memoria restaurada: ${activeTrades.size} trades activos cargados.`);
        });

        db.collection('app_settings').doc('global').onSnapshot((snap) => {
            if (snap.exists) globalKillswitches = snap.data()?.killswitches || {};
        });
        db.collection('app_settings').doc('bot_config').onSnapshot((snap) => {
            if (snap.exists) {
                const data = snap.data() || {};
                dynamicBotConfig = {
                    sniperCooldownMs: Number(data.sniperCooldownMs) || dynamicBotConfig.sniperCooldownMs,
                    minPointsForBuy: Number(data.minPointsForBuy) || dynamicBotConfig.minPointsForBuy,
                    minPointsForSell: Number(data.minPointsForSell) || dynamicBotConfig.minPointsForSell,
                    baseRiskPercentage: Number(data.baseRiskPercentage) || dynamicBotConfig.baseRiskPercentage
                };
            }
        });
    } catch (e) {
        console.error('[TRADING] Error iniciando listeners de configuración', e);
    }
}

const recentAlertCache = new Map<string, number>();
const DEDUP_WINDOW_MS = 60000; 
const lastSyncTime = new Map<string, number>();
const SYNC_THROTTLE_MS: Record<string, number> = { '3': 0, '15': 120000, '60': 300000, '240': 600000 };
const tickerLastSeen = new Map<string, number>();
const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; 

function isDuplicate(fingerprint: string, nowMs: number): boolean {
    for (const [key, ts] of recentAlertCache) {
        if (nowMs - ts > DEDUP_WINDOW_MS) recentAlertCache.delete(key);
    }
    if (recentAlertCache.has(fingerprint)) return true;
    recentAlertCache.set(fingerprint, nowMs);
    return false;
}

const parseTF = (tf: string) => {
    if (tf === '240') return '4H';
    if (tf === '60') return '1H';
    if (tf === '15') return '15M';
    if (tf === '3') return '3M';
    return `${tf}M`;
};

// 🆕 Helpers Dinámicos
const getDecimals = (ticker: string) => (ticker.includes('BTC') || ticker.includes('ETH') || ticker.includes('US30') || ticker.includes('NAS')) ? 2 : (ticker.includes('JPY') ? 3 : 5);
const getBuffer = (ticker: string, price: number) => (ticker.includes('BTC') || ticker.includes('ETH')) ? price * 0.001 : price * 0.0002;

async function sendTelegramAlert(message: string) {
    // 🛡️ Sanitizar: Telegram HTML solo necesita escapar < > &
    const safe = message.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&(?!lt;|gt;|amp;)/g, '&amp;');
    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try { await bot.api.sendMessage(userId, safe, { parse_mode: 'HTML' }); } 
        catch (err: any) { try { await bot.api.sendMessage(userId, safe); } catch (e) { } }
    }
}

function evaluateImpulse(leg: ImpulseLeg | null | undefined, currentPrice: number, highPrice: number, lowPrice: number, ticker: string, state: RadarState, nowMs: number) {
    if (!leg) return { updatedLeg: null };
    let impulseInvalidated = false;

    // 🔧 FIX 1: Stale leg cleaner — legs de más de 4 horas se invalidan automáticamente
    const MAX_LEG_AGE_MS = 4 * 60 * 60 * 1000;
    if (leg.createdAt && (nowMs - leg.createdAt) > MAX_LEG_AGE_MS) {
        console.log(`[FIBO] 🧹 Leg ${leg.dir} en ${ticker} EXPIRADO por antigüedad (${Math.round((nowMs - leg.createdAt) / 60000)} min > 240 min).`);
        return { updatedLeg: null };
    }

    // 🔧 FIX 2: Opposite pressure — si el score contrario supera 3x y tiene ≥9pts, el leg se anula
    const legScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
    const oppositeScore = leg.dir === 'BUY' ? state.scoreSell : state.scoreBuy;
    if (oppositeScore.points >= legScore.points * 3 && oppositeScore.points >= 9 && (nowMs - oppositeScore.lastUpdate) < 900000) {
        console.log(`[FIBO] ⚠️ Leg ${leg.dir} en ${ticker} ANULADO por presión contraria: score opuesto ${oppositeScore.points} pts vs propio ${legScore.points} pts (hace ${Math.round((nowMs - oppositeScore.lastUpdate) / 60000)}min).`);
        return { updatedLeg: null };
    }

    // 🔧 FIX 3: Si el precio superó el extreme por >1 ATR y pasaron >30 min, OTE inalcanzable
    const range = Math.abs(leg.extreme - leg.origin);
    const atrEstimate = range * 0.3;
    const priceBeyondExtreme = leg.dir === 'BUY' 
        ? (currentPrice > leg.extreme + atrEstimate) 
        : (currentPrice < leg.extreme - atrEstimate);
    if (priceBeyondExtreme && leg.createdAt && (nowMs - leg.createdAt) > 30 * 60 * 1000) {
        console.log(`[FIBO] 🚫 Leg ${leg.dir} en ${ticker} INALCANZABLE: precio ${currentPrice} ya superó el extreme ${leg.extreme} en más de 1 ATR.`);
        return { updatedLeg: null };
    }

    if (leg.dir === 'BUY' && highPrice > leg.extreme) leg.extreme = highPrice;
    else if (leg.dir === 'SELL' && lowPrice < leg.extreme) leg.extreme = lowPrice;

    if (leg.dir === 'BUY' && lowPrice < leg.origin) impulseInvalidated = true;
    else if (leg.dir === 'SELL' && highPrice > leg.origin) impulseInvalidated = true;

    if (!impulseInvalidated) {
        const range = Math.abs(leg.extreme - leg.origin);
        // 🔧 FIX: minRange adaptado por tipo de ticker (mismo criterio que minImpulseRange)
        let minRange: number;
        if (ticker.includes('BTC') || ticker.includes('ETH')) {
            minRange = currentPrice * 0.0003; // 0.03% para crypto
        } else if (ticker.includes('JPY')) {
            minRange = 0.015; // 1.5 pips para pares JPY
        } else if (ticker.includes('US30') || ticker.includes('NAS') || ticker.includes('SPX') || ticker.includes('DXY')) {
            minRange = currentPrice * 0.0002; // 0.02% para índices
        } else {
            minRange = 0.00010; // 1.0 pip para forex majors
        }

        const oteTop = leg.dir === 'BUY' ? leg.extreme - (range * 0.50) : leg.extreme + (range * 0.79);
        const oteBtm = leg.dir === 'BUY' ? leg.extreme - (range * 0.79) : leg.extreme + (range * 0.50);

        // 🔓 OTE entry: el leg fue creado por un CHoCH que ya pasó todos los filtros de puntaje.
        // No re-validamos con leg.isValidated porque el reset del score borra los eventos
        // de zona ANTES de llegar aquí, causando que el 90% de los legs queden isValidated=false.
        // Si el leg existe y no fue invalidado por precio ni expiración, el OTE es válido.
        // PERO: legs con < 8 chochPoints y sin validación se filtran (baja calidad).
        if (highPrice >= Math.min(oteTop, oteBtm) && lowPrice <= Math.max(oteTop, oteBtm) && !leg.oteScored) {
            // 🔧 Filtro de calidad: si el leg no fue validado Y tiene pocos puntos, no entrar
            const MIN_OTE_POINTS = 8;
            if (!leg.isValidated && (leg.chochPoints || 0) < MIN_OTE_POINTS) {
                console.log(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: leg no validado y solo ${leg.chochPoints || 0} pts (< ${MIN_OTE_POINTS})`);
                return { updatedLeg: leg };
            }
            // 🛡️ Filtro R:R teórico del OTE (50%-79% de retroceso del impulso)
            // El R:R se calcula sobre los niveles ESTRUCTURALES del OTE, no sobre el precio
            // actual de la vela (que puede estar desviado del OTE exacto).
            // A 50% retroceso: R:R = 1.0, a 79% retroceso: R:R = 3.76
            const riskDistanceOTE = Math.abs(leg.extreme - leg.origin) * 0.21; // peor caso: 79% fib
            const rewardDistanceOTE = Math.abs(leg.extreme - leg.origin) * 0.50; // 50% fib OTE
            const rrRatioOTE = riskDistanceOTE > 0 ? rewardDistanceOTE / riskDistanceOTE : 0;
            if (rrRatioOTE < 1.2) {
                console.log(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} descartado: R:R teórico ${rrRatioOTE.toFixed(2)} < 1.2 (rango impulso: ${(Math.abs(leg.extreme - leg.origin)).toFixed(4)})`);
                return { updatedLeg: leg };
            }

            const activeScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
            const eventName = `🎯_OTE_Retracement_3M`;
            
            if (!activeScore.events.includes(eventName)) {
                activeScore.events.push(eventName);
                activeScore.points += 4;
                activeScore.lastUpdate = nowMs;
                leg.oteScored = true;
                
                const decimals = getDecimals(ticker);
                const stopLoss = leg.origin.toFixed(decimals);
                const tp1 = leg.extreme.toFixed(decimals);
                const tp2 = leg.tp2 ? leg.tp2.toFixed(decimals) : 'Buscando DOL macro...';

                const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();

                console.log(`[FIBO] 🎯 RETROCESO 50% CONFIRMADO para ${ticker} ${leg.dir}. Despertando IA...`);

                const oteData = {
                    tradeId, 
                    direction: leg.dir,
                    dirText: leg.dir === 'BUY' ? 'COMPRA' : 'VENTA',
                    stopLoss, tp1, tp2,
                    entryPrice: currentPrice,
                    points: (leg.chochPoints || 0) + 4, 
                    events: [...(leg.chochEvents || []), eventName],
                    confluenceReport: leg.chochReport || '',
                    bestZone: leg.bestZone || null,
                    marketBias: { ...state.marketBias }
                };

                const newTrade: ActiveTrade = {
                    tradeId, ticker, direction: leg.dir,
                    entryPrice: currentPrice,
                    tp1Price: leg.extreme,
                    tp2Price: leg.tp2 || 0,
                    slPrice: leg.origin,
                    tp1Hit: false,
                    tp2Hit: false,
                    timestamp: nowMs
                };

                // 💾 Sincronización en RAM y Firebase
                activeTrades.set(tradeId, newTrade);
                if (db) db.collection('active_trades').doc(tradeId).set(newTrade).catch(() => {});

                return { updatedLeg: leg, triggerOte: true, oteData };
            }
        }
    }
    return { updatedLeg: impulseInvalidated ? null : leg };
}

export async function processTradingAlert(alertText: string) {
    if (!db) return;

    // 🕒 El Bypass Temporal (Bar Replay Histórico)
    const tsMatch = alertText.match(/TS:\s*([0-9]+)/i);
    const nowMs = tsMatch ? parseInt(tsMatch[1], 10) : Date.now();

    const textUpToPayload = alertText.includes('Payload:') ? alertText.split('Payload:')[0] : alertText;
    const parts = textUpToPayload.split(/[,|]/).map(p => p.trim());

    if (parts.length < 2) return;

    const prefix = parts[0].toUpperCase();
    const ticker = parts[1].replace(/"/g, '');
    const upperText = alertText.toUpperCase();

    if (globalKillswitches[ticker]) return;

    tickerLastSeen.set(ticker, nowMs);

    const tfMatch = alertText.match(/TF:\s*([a-zA-Z0-9]+)/i);
    const eventTf = tfMatch ? tfMatch[1] : 'UNKNOWN';
    const readableTf = parseTF(eventTf);

    let currentDirection: 'BUY' | 'SELL' | null = null;
    if (upperText.includes('BUY') || upperText.includes('BULLISH') || upperText.includes('COMPRA')) currentDirection = 'BUY';
    else if (upperText.includes('SELL') || upperText.includes('BEARISH') || upperText.includes('VENTA')) currentDirection = 'SELL';

    const docRef = db.collection('radar_states').doc(ticker);
    const todayStr = new Date(nowMs).toISOString().split('T')[0];

    let triggerOte = false;
    let oteData: any = null;

    try {
        // 🔥 Reemplazo completo de la Transacción por Memoria RAM Local 🔥
        triggerOte = false;
        oteData = null;

        // 1. LEER DE LA RAM (Ultra rápido y sin costo de base de datos)
        let state = localRadarStates.get(ticker);
        
        // Si el servidor se reinició y la RAM está vacía, hacemos 1 sola lectura a Firebase
        if (!state) {
            const docSnap = await docRef.get();
            state = docSnap.exists ? (docSnap.data() as RadarState) : emptyState();
            localRadarStates.set(ticker, state);
        }

        if (!state.scoreBuy) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
        if (!state.scoreSell) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };
        if (!state.marketBias) state.marketBias = emptyState().marketBias;

        if (nowMs - state.scoreBuy.lastUpdate > SETUP_MEMORY_WINDOW_MS) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
        if (nowMs - state.scoreSell.lastUpdate > SETUP_MEMORY_WINDOW_MS) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };

        if (prefix === 'SYNC_ZONES') {
            if (!alertText.includes('Payload:')) return;
            const sourceTf = eventTf;
            
            const syncKey = `${ticker}_${sourceTf}`;
            const lastSync = lastSyncTime.get(syncKey) || 0;
            const throttleMs = SYNC_THROTTLE_MS[sourceTf] || 60000;
            if (nowMs - lastSync < throttleMs) {
                console.log(`[SYNC] ⏭️ SYNC_ZONES throttled para ${ticker} ${sourceTf} (último: hace ${Math.round((nowMs - lastSync)/1000)}s, límite: ${throttleMs/1000}s)`);
                return;
            }
            lastSyncTime.set(syncKey, nowMs);
            
            const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();
            const trendMatch = alertText.match(/Trend:\s*(BUY|SELL)/i);
            if (trendMatch) state.marketBias[sourceTf] = trendMatch[1].toUpperCase() as 'BUY' | 'SELL';

            try {
                const rawZones = JSON.parse(payloadStr) as any[];
                const parsedZones: RadarZone[] = rawZones.map(normalizeZone).filter(z => z.top !== undefined && z.btm !== undefined && z.dir !== undefined);
                parsedZones.forEach(z => { z.tf = sourceTf; z.createdAt = nowMs; });
                // 🔍 Log de TP/SL si están disponibles para diagnóstico
                const zonesWithTPSL = parsedZones.filter(z => z.tp !== undefined || z.sl !== undefined);
                if (zonesWithTPSL.length > 0) {
                    console.log(`[SYNC_ZONES] ${ticker} ${sourceTf}: ${zonesWithTPSL.length}/${parsedZones.length} zonas con TP/SL explícito`);
                }

                if (state.lastSyncDate !== todayStr) {
                    state.zones = [];
                    state.activeLocks = [];
                    state.lastSyncDate = todayStr;
                }
                state.zones = state.zones.filter(z => z.tf !== sourceTf);
                state.zones.push(...parsedZones);
            } catch (e) { }
        }
        else if (prefix === 'PING_PRICE') {
            const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
            if (!priceMatch) return;

            const currentPrice = parseFloat(priceMatch[1]);
            const highMatch = alertText.match(/High:\s*([0-9.]+)/i);
            const lowMatch = alertText.match(/Low:\s*([0-9.]+)/i);
            const highPrice = highMatch ? parseFloat(highMatch[1]) : currentPrice;
            const lowPrice = lowMatch ? parseFloat(lowMatch[1]) : currentPrice;

            // 🔧 FIX: Guardar precio anterior ANTES de actualizar para detectar dirección de entrada
            const previousPrice = state.lastPrice; 
            const hasPreviousPrice = previousPrice !== null;
            // Actualizar después de guardar la referencia
            state.lastPrice = currentPrice;
            lastPingTime = nowMs; // 🏥 Healthcheck
            // Guardar también el precio previo para referencia en el siguiente tick
            (state as any).previousPrice = previousPrice;

            // 🛡️ CRÍTICO: Verificar killswitches ANTES de evaluateImpulse() para evitar trades huérfanos
            const isKillswitched = nowMs < streakKillswitchUntil || nowMs < vixKillswitchUntil;
            
            if (!isKillswitched) {
                const buyRes = evaluateImpulse(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, ticker, state, nowMs);
                state.activeImpulseBuy = buyRes.updatedLeg;
                if (buyRes.triggerOte) { triggerOte = true; oteData = buyRes.oteData; }

                const sellRes = evaluateImpulse(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs);
                state.activeImpulseSell = sellRes.updatedLeg;
                if (sellRes.triggerOte) { triggerOte = true; oteData = sellRes.oteData; }
            }

            // =========================================================
            // GESTIÓN DE TRADES ACTIVOS (TP Y SL)
            // =========================================================
            if (activeTrades.size > 0) {
                for (const [tradeId, trade] of activeTrades) {
                    if (trade.ticker !== ticker) continue;
                    const nowTrade = nowMs;
                    const openTimeStr = new Date(trade.timestamp).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' }); 
                    
                    // 🎯 EVALUACIÓN DE TP1
                    if (!trade.tp1Hit) {
                        const tp1Hit = trade.direction === 'BUY' 
                        ? highPrice >= trade.tp1Price 
                        : lowPrice <= trade.tp1Price;

                        if (tp1Hit) {
                        // 🛡️ FILTRO ANTI-DUPLICADOS (Vercel Race Condition)
                            if (isDuplicate(`TP1_${trade.tradeId}_${ticker}`, nowTrade)) continue;

                            trade.tp1Hit = true;
                            trade.slPrice = trade.entryPrice;
                            
                            const durationSec = Math.round((nowTrade - trade.timestamp) / 1000);
                            const durationStr = durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`;
                            
                            // 💾 Sincronizar actualización de TP1 y SL a Break Even
                            if (db) db.collection('active_trades').doc(trade.tradeId).update({ tp1Hit: true, slPrice: trade.entryPrice }).catch(() => {});
                            
                            if (trade.journalId) {
                                const { db: fireDb } = await import('./memory.js');
                                if (fireDb) {
                                    fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        tp1Hit: true,
                                        tp1Timestamp: nowTrade,
                                    }).catch(() => {});
                                }
                            }
                            
                            const tp1Msg = `🟡 <b>TP1 ALCANZADO | ${ticker} | ${trade.direction}</b>\n\n` +
                                `🕒 Apertura: ${openTimeStr}\n` + 
                                `📥 Entrada: ${trade.entryPrice}\n` +
                                `🎯 TP1: ${trade.tp1Price} ✅\n` +
                                `🚀 TP2: ${trade.tp2Price > 0 ? trade.tp2Price : '—'}\n` +
                                `🛑 Nuevo SL: ${trade.slPrice} (Break Even)\n` +
                                `⏱️ Duración: ${durationStr}\n\n` +
                                `💡 SL protegido automáticamente a Break Even.`;
                            sendTelegramAlert(tp1Msg).catch(() => {});
                            console.log(`[JOURNAL] 🟡 TP1 alcanzado: ${ticker} ${trade.direction} #${tradeId} — SL movido a BE`);
                        }
                    }
                    
                    // 🚀 EVALUACIÓN DE TP2
                    if (trade.tp2Price > 0) {
                        const tp2Hit = trade.direction === 'BUY' 
                        ? highPrice >= trade.tp2Price 
                        : lowPrice <= trade.tp2Price;

                        if (tp2Hit) {
                        // 🛡️ FILTRO ANTI-DUPLICADOS
                            if (isDuplicate(`CLOSE_${trade.tradeId}_${ticker}`, nowTrade)) continue;

                            // 💾 Eliminar de RAM inmediatamente de forma síncrona
                            activeTrades.delete(tradeId);
                            if (db) db.collection('active_trades').doc(tradeId).delete().catch(() => {});

                            trade.tp2Hit = true;
                            const pnlPct = Math.abs(currentPrice - trade.entryPrice) / trade.entryPrice * 100;
                            const durationMin = Math.round((nowTrade - trade.timestamp) / 60000);
                            
                            if (trade.journalId) {
                                const { db: fireDb } = await import('./memory.js');
                                if (fireDb) {
                                    fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        tp2Hit: true,
                                        tp2Timestamp: nowTrade,
                                        result: 'WIN',
                                        pnl: parseFloat(pnlPct.toFixed(2)),
                                        durationMin,
                                    }).catch(() => {});
                                }
                            }
                            recordResult(tradeId, 'WIN', parseFloat(pnlPct.toFixed(2))).catch(() => {});

                            if (trade.tp1Hit) consecutiveLosses = Math.max(0, consecutiveLosses - 1);
                            else consecutiveLosses = 0;
                            
                            const tp2Msg = `🟢 <b>TP2 ALCANZADO (WIN) | ${ticker} | ${trade.direction}</b>\n\n` +
                                `🕒 Apertura: ${openTimeStr}\n` + 
                                `📥 Entrada: ${trade.entryPrice}\n` +
                                `🎯 TP1: ${trade.tp1Price} ${trade.tp1Hit ? '✅' : '⏭️'}\n` +
                                `🚀 TP2: ${trade.tp2Price} ✅\n` +
                                `📊 PnL: +${pnlPct.toFixed(2)}%\n` +
                                `⏱️ Duración total: ${durationMin} min\n\n` +
                                `🏆 ¡Trade completo! ${consecutiveLosses > 0 ? `Racha protección: ${consecutiveLosses} pérdidas` : 'Racha limpia.'}`;
                            sendTelegramAlert(tp2Msg).catch(() => {});
                            console.log(`[JOURNAL] 🟢 TP2 alcanzado (WIN): ${ticker} ${trade.direction} #${tradeId}`);
                            continue;
                        }
                    }
                    
                    // 🛑 EVALUACIÓN DE STOP LOSS (O BREAK EVEN)
                    const slHit = trade.direction === 'BUY' 
                        ? lowPrice <= trade.slPrice 
                        : highPrice >= trade.slPrice;

                    if (slHit) {
                    // 🛡️ FILTRO ANTI-DUPLICADOS
                        if (isDuplicate(`CLOSE_${trade.tradeId}_${ticker}`, nowTrade)) continue;
                        
                        // 💾 Eliminar de RAM inmediatamente de forma síncrona para evitar race conditions
                        activeTrades.delete(tradeId);
                        if (db) db.collection('active_trades').doc(tradeId).delete().catch(() => {});

                        const isBreakEven = trade.tp1Hit;
                        const pnlPct = isBreakEven ? 0 : Math.abs(currentPrice - trade.entryPrice) / trade.entryPrice * 100;
                        const finalResult = isBreakEven ? 'BE' : 'LOSS';
                        const durationMin = Math.round((nowTrade - trade.timestamp) / 60000);
                        
                        if (trade.journalId) {
                            const { db: fireDb } = await import('./memory.js');
                            if (fireDb) {
                                fireDb.collection('trade_journal').doc(trade.journalId).update({
                                    slHit: true,
                                    slTimestamp: nowTrade,
                                    result: finalResult,
                                    pnl: isBreakEven ? 0 : -parseFloat(pnlPct.toFixed(2)),
                                    durationMin,
                                }).catch(() => {});
                            }
                        }
                        
                        if (!isBreakEven) recordResult(tradeId, 'LOSS', parseFloat(pnlPct.toFixed(2))).catch(() => {});

                        // Lógica de racha perdedora (ignorar si es Break Even)
                        if (!isBreakEven) {
                            consecutiveLosses++;
                            if (consecutiveLosses >= 5) streakKillswitchUntil = nowTrade + 30 * 60 * 1000;
                        }
                        
                        const protectionMsg = consecutiveLosses >= 5 
                            ? '🔴 ALERTA: 5 pérdidas consecutivas. KILLSWITCH ACTIVADO por 30 min.'
                            : consecutiveLosses === 4
                                ? '⚠️ 4 pérdidas consecutivas. Subiendo minPts +5.'
                                : consecutiveLosses === 3 
                                    ? '⚠️ 3 pérdidas consecutivas. Subiendo minPts +3.'
                                    : consecutiveLosses === 2 
                                        ? '⚠️ 2 pérdidas consecutivas. Subiendo minPts +2.'
                                        : '';
                        
                        const slMsg = isBreakEven 
                            ? `🛡️ <b>BREAK EVEN ALCANZADO | ${ticker} | ${trade.direction}</b>\n\n` +
                            `🕒 Apertura: ${openTimeStr}\n` + 
                            `📥 Entrada: ${trade.entryPrice}\n` +
                            `🎯 TP1 tocado: Sí (Parcial asegurado)\n` +
                            `🛑 SL: ${trade.slPrice} (Cerrado sin riesgo)\n` +
                            `📊 PnL: 0.00%\n` +
                            `⏱️ Duración: ${durationMin} min`
                            : `🔴 <b>SL ALCANZADO (LOSS) | ${ticker} | ${trade.direction}</b>\n\n` +
                            `🕒 Apertura: ${openTimeStr}\n` + 
                            `📥 Entrada: ${trade.entryPrice}\n` +
                            `🛑 SL: ${trade.slPrice} ❌\n` +
                            `🎯 TP1 tocado: No\n` +
                            `📊 PnL: -${pnlPct.toFixed(2)}%\n` +
                            `⏱️ Duración: ${durationMin} min\n\n` +
                            `${protectionMsg ? protectionMsg + '\n\n' : ''}` +
                            `📈 Racha actual: ${consecutiveLosses} pérdida(s) consecutiva(s)`;

                        sendTelegramAlert(slMsg).catch(() => {});
                        console.log(`[JOURNAL] ${isBreakEven ? '🛡️ BE alcanzado' : '🔴 SL alcanzado (LOSS)'}: ${ticker} #${tradeId}`);
                        continue;
                    }
                }
            }

            const touchedThisPing: { zone: RadarZone; eventName: string; pts: number }[] = [];
            const buffer = getBuffer(ticker, currentPrice); 
            
            for (const zone of state.zones) {
                if (currentPrice <= (zone.top + buffer) && currentPrice >= (zone.btm - buffer)) {
                    const hasPreviousPrice = previousPrice !== null;
                    const enteredFromAbove = hasPreviousPrice && previousPrice > zone.top;
                    const enteredFromBelow = hasPreviousPrice && previousPrice < zone.btm;
                    
                    const isValidDirection = (zone.dir === 'BUY' && enteredFromAbove) || 
                                             (zone.dir === 'SELL' && enteredFromBelow);
                    const isFirstPing = !hasPreviousPrice;
                    
                    if (!isValidDirection && !isFirstPing) {
                        console.log(`[PING] Toque ignorado por dirección incorrecta: ${zone.dir} zone, price ${currentPrice}, prev ${previousPrice}`);
                        continue;
                    }
                    
                    const activeScore = zone.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
                    const zTf = parseTF(zone.tf || '');
                    let basePts = zone.score !== undefined ? zone.score : 2;

                    let confluenceMultiplier = 1.0;
                    let confluenceTFs: string[] = [];
                    for (const otherZone of state.zones) {
                        if (otherZone === zone) continue;
                        if (otherZone.dir !== zone.dir) continue;
                        if (otherZone.tf === zone.tf) continue;
                        const overlaps = !(otherZone.top < zone.btm || otherZone.btm > zone.top);
                        if (overlaps && !confluenceTFs.includes(otherZone.tf || '')) {
                            confluenceTFs.push(otherZone.tf || '');
                        }
                    }
                    if (confluenceTFs.length >= 3) confluenceMultiplier = 2.5;       
                    else if (confluenceTFs.length >= 2) confluenceMultiplier = 2.0;   
                    else if (confluenceTFs.length >= 1) confluenceMultiplier = 1.5;   

                    let eventName = zone.medal?.includes('God') ? `💎_GOD_ZONE_${zTf}` :
                                    zone.medal?.includes('CHoCH') ? `🎯_Silver_Bullet_${zTf}` :
                                    zone.medal?.includes('Breaker') ? `♻️_Breaker_${zTf}` :
                                    `OB_${zone.medal}_${zTf}`;

                    let tfMultiplier = zTf === '4H' ? 2 : zTf === '1H' ? 1.5 : 1;
                    let pts = Math.floor(basePts * tfMultiplier * confluenceMultiplier);

                    if (!activeScore.events.includes(eventName)) {
                        activeScore.events.push(eventName);
                        activeScore.points += pts;
                        activeScore.lastUpdate = nowMs;
                        touchedThisPing.push({ zone, eventName, pts });
                                           
                        if (confluenceMultiplier > 1.0) {
                            const tfTags = confluenceTFs.map(t => parseTF(t)).join('+');
                            console.log(`[RADAR] 🧲 CONFLUENCIA ${confluenceMultiplier}x en ${ticker} ${zone.dir}: ${zTf} + (${tfTags}) = ${pts} pts`);
                        }
                    }
                }
            }                   
            for (const dir of ['BUY', 'SELL'] as const) {
                const dirZones = touchedThisPing.filter(t => t.zone.dir === dir);
                if (dirZones.length < 2) continue;

                const activeScore = dir === 'BUY' ? state.scoreBuy : state.scoreSell;
                const uniqueTFs = new Set(dirZones.map(t => t.zone.tf));
                const tfCount = uniqueTFs.size;
                
                if (tfCount >= 2) {
                    const zonesOverlap = dirZones.some((a, i) => 
                        dirZones.some((b, j) => i !== j && a.zone.tf !== b.zone.tf && !(a.zone.top < b.zone.btm || a.zone.btm > b.zone.top))
                    );
                    if (!zonesOverlap) continue;
                    
                    let confluenceBonus = tfCount === 4 ? 10 : tfCount === 3 ? 7 : 4;
                    const tfList = [...uniqueTFs].map(t => parseTF(t || '')).sort((a, b) => {
                        const order: Record<string, number> = { '3M': 0, '15M': 1, '1H': 2, '4H': 3 };
                        return (order[b] || 0) - (order[a] || 0);
                    }).join('+');
                    
                    const eventName = `🧲_CONFLUENCIA_${tfCount}TF_${tfList}`;
                    if (!activeScore.events.includes(eventName)) {
                        activeScore.events.push(eventName);
                        activeScore.points += confluenceBonus;
                        activeScore.lastUpdate = nowMs;
                    }
                }
            }
        }
        else if (currentDirection) {
            const activeScore = currentDirection === 'BUY' ? state.scoreBuy : state.scoreSell;
            const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
            let addedPoints = 0;

            if (prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') {
                state.marketBias[eventTf] = currentDirection;
                
                if (eventTf === '3') {
                    const originMatch = alertText.match(/ORIGIN:\s*([0-9.]+)/i);
                    const priceMatchChoch = alertText.match(/Precio:\s*([0-9.]+)/i);
                    const actualPrice = priceMatchChoch ? parseFloat(priceMatchChoch[1]) : state.lastPrice;

                    if (originMatch && actualPrice) {
                        const newOrigin = parseFloat(originMatch[1]);
                        const isBuy = currentDirection === 'BUY';
                        const activeLeg = isBuy ? state.activeImpulseBuy : state.activeImpulseSell;
                        
                        let shouldCreateNew = true;
                        if (activeLeg) {
                            const isInsideRange = actualPrice > Math.min(activeLeg.origin, activeLeg.extreme) && actualPrice < Math.max(activeLeg.origin, activeLeg.extreme);
                            if (isInsideRange) shouldCreateNew = false;
                            
                            // 🛡️ Anti-Pingpong: No crear leg nuevo si el anterior tiene < 3 min
                            // 🔧 Reducido de 5min a 3min para scalping 3M (vela cierra cada 3 min, 
                            // un leg puede completarse en 1-2 velas y ya estar listo para el siguiente)
                            const LEG_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutos
                            if (activeLeg.createdAt && (nowMs - activeLeg.createdAt) < LEG_COOLDOWN_MS) {
                                shouldCreateNew = false;
                                console.log(`[FIBO] ⚠️ ${prefix} ${currentDirection} ignorado en ${ticker}: leg anterior tiene ${Math.round((nowMs - activeLeg.createdAt) / 1000)}s (cooldown 5 min)`);
                            }
                        }

                        // 🛡️ Rango mínimo del impulso: |extreme - origin| debe superar el umbral
                        // Umbral adaptado por ticker (forex majors ~2 pips, crypto ~0.02%, índices ~0.05%)
                        const impulseRange = Math.abs(actualPrice - newOrigin);
                        let minImpulseRange: number;
                        if (ticker.includes('BTC') || ticker.includes('ETH')) {
                            minImpulseRange = actualPrice * 0.0005; // 0.05% para crypto
                        } else if (ticker.includes('JPY')) {
                            minImpulseRange = 0.02; // 2 pips para pares JPY
                        } else if (ticker.includes('US30') || ticker.includes('NAS') || ticker.includes('SPX') || ticker.includes('DXY')) {
                            minImpulseRange = actualPrice * 0.0003; // 0.03% para índices
                        } else {
                            // Forex majors (EURUSD, GBPUSD, etc.): ~1-2 pips
                            minImpulseRange = 0.00015; // 1.5 pips
                        }
                        if (impulseRange < minImpulseRange) {
                            shouldCreateNew = false;
                            console.log(`[FIBO] ⚠️ ${prefix} ${currentDirection} en ${ticker}: rango ${impulseRange.toFixed(5)} < mínimo ${minImpulseRange.toFixed(5)}`);
                        }
                        
                        if (shouldCreateNew) {
                            let macroTarget: number | null = null;
                            if (isBuy && state.activeImpulseSell) { macroTarget = state.activeImpulseSell.origin; state.activeImpulseSell = null; } 
                            else if (!isBuy && state.activeImpulseBuy) { macroTarget = state.activeImpulseBuy.origin; state.activeImpulseBuy = null; }

                            const newLeg: ImpulseLeg = {
                                dir: currentDirection as 'BUY' | 'SELL',
                                origin: newOrigin,
                                extreme: actualPrice,
                                createdAt: nowMs,
                                tp2: macroTarget,
                                oteScored: false
                            };
                            
                            if (isBuy) state.activeImpulseBuy = newLeg;
                            else state.activeImpulseSell = newLeg;
                        }
                    }
                }
                // CHoCH da 3 puntos (fuerte), BOS da 1 punto (continuación)
                addedPoints = prefix === 'EVENTO_CHOCH' ? 3 : 1; 
            }

            if (prefix === 'ZONE_BROKEN') {
                let pointsToDeduct = 0;
                const initialLength = activeScore.events.length;
                activeScore.events = activeScore.events.filter(e => {
                    if (e === `POC_Volume_${readableTf}`) { pointsToDeduct += 4; return false; }
                    if (e === `Breaker_${readableTf}`) { pointsToDeduct += 3; return false; }
                    if (e === `OB_${readableTf}`) { pointsToDeduct += 3; return false; }
                    return true;
                });
                if (activeScore.events.length < initialLength) activeScore.points = Math.max(0, activeScore.points - pointsToDeduct);
                // 🔧 FIX: Limpiar también las zonas rotas del mapa de zonas en RAM
                state.zones = state.zones.filter(z => {
                    if (z.tf !== eventTf) return true;
                    if (currentDirection === 'BUY' && z.dir === 'SELL') return true; // zona SELL rota por presión BUY
                    if (currentDirection === 'SELL' && z.dir === 'BUY') return true; // zona BUY rota por presión SELL
                    return false; // misma dirección = zona rota, eliminarla
                });
                return;
            }

            if (prefix === 'DIV_BROKEN') {
                const initialLength = activeScore.events.length;
                activeScore.events = activeScore.events.filter(e => e !== `DIV_${readableTf}`);
                if (activeScore.events.length < initialLength) activeScore.points = Math.max(0, activeScore.points - 2);
                return;
            }

            if (prefix === 'SWEEP_BROKEN') {
                let pointsToDeduct = 0;
                const initialLength = activeScore.events.length;
                activeScore.events = activeScore.events.filter(e => {
                    if (e === `Sweep_${readableTf}_Absorcion`) { pointsToDeduct += 5; return false; }
                    if (e === `Sweep_${readableTf}`) { pointsToDeduct += 3; return false; }
                    if (e === `📉_TL_Sweep_${readableTf}`) { pointsToDeduct += 2; return false; }
                    return true;
                });
                if (activeScore.events.length < initialLength) activeScore.points = Math.max(0, activeScore.points - pointsToDeduct);
                return;
            }

            if (prefix === 'TOUCH_ZONE') {
                const ptMatch = alertText.match(/Puntos:\s*(\d+)/i);
                const dynamicPts = ptMatch ? parseInt(ptMatch[1], 10) : 0;
                if (upperText.includes('BREAKER')) {
                    if (!activeScore.events.includes(`Breaker_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 3; activeScore.events.push(`Breaker_${readableTf}`); }
                } else if (upperText.includes('PLATINO') || upperText.includes('POC')) {
                    if (!activeScore.events.includes(`POC_Volume_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 4; activeScore.events.push(`POC_Volume_${readableTf}`); }
                } else if (upperText.includes('GOD_ZONE') || upperText.includes('ORO')) {
                    if (!activeScore.events.includes(`OB_Gold_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 3; activeScore.events.push(`OB_Gold_${readableTf}`); }
                } else {
                    if (!activeScore.events.includes(`OB_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 2; activeScore.events.push(`OB_${readableTf}`); }
                }
            }
            else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
                if (!activeScore.events.includes(`Sweep_${readableTf}`) && !activeScore.events.includes(`🩸_V-Shape_Absorb_${readableTf}`)) {
                    if (upperText.includes('ABSORCION')) { addedPoints = 6; activeScore.events.push(`🩸_V-Shape_Absorb_${readableTf}`); }
                    else { addedPoints = 3; activeScore.events.push(`Sweep_${readableTf}`); }
                }
            }
            else if (prefix === 'EVENTO_SMC_DIV') {
                if (!activeScore.events.includes(`DIV_${readableTf}`)) { addedPoints = 2; activeScore.events.push(`DIV_${readableTf}`); }
            }
            else if (prefix === 'EVENTO_BOS') {
                // BOS sin CHoCH — solo actualiza bias, puntos bajos (no crea impulse leg)
                state.marketBias[eventTf] = currentDirection;
                addedPoints = 1; 
            }
            else if (prefix === 'HEARTBEAT') {
                // Watchdog: solo actualiza lastHeartbeat, no suma puntos
                state.lastHeartbeat = nowMs;
                // Extraer conteo de zonas para diagnóstico
                const zonesMatch = alertText.match(/Zones:\s*(\d+)/i);
                const biasMatch = alertText.match(/Bias:\s*(BUY|SELL|NEUTRAL)/i);
                if (zonesMatch) console.log(`[HEARTBEAT] ${ticker} ${eventTf}: ${zonesMatch[1]} zonas activas, bias ${biasMatch?.[1] || '?'}`);
            }
            else if (prefix === 'ZONE_TOUCHED') {
                // Alerta específica de toque de zona — más precisa que PING_PRICE
                const zoneMedal = alertText.match(/Medal:\s*([\w🚀♻️💎]+)/i)?.[1] || 'OB';
                const zoneScore = parseInt(alertText.match(/Score:\s*([0-9]+)/i)?.[1] || '2');
                const eventName = `🎯_ZoneTouched_${zoneMedal}_${readableTf}`;
                if (!activeScore.events.includes(eventName)) {
                    addedPoints = zoneScore >= 9 ? 5 : zoneScore >= 7 ? 4 : zoneScore >= 5 ? 3 : 2;
                    activeScore.events.push(eventName);
                }
            }
            else if (prefix === 'EVENTO_SWEEP_TL') {
                if (!activeScore.events.includes(`📉_TL_Sweep_${readableTf}`)) { addedPoints = 2; activeScore.events.push(`📉_TL_Sweep_${readableTf}`); }
                if (oppositeScore.events.includes(`📉_TL_Sweep_${readableTf}`)) {
                    oppositeScore.events = oppositeScore.events.filter(e => e !== `📉_TL_Sweep_${readableTf}`);
                    oppositeScore.points = Math.max(0, oppositeScore.points - 2);
                }
            }
            else if (prefix === 'ZONE_TOUCHED') {
                const zoneMedal = alertText.match(/Medal:\s*([\w🚀♻️💎]+)/i)?.[1] || 'OB';
                const zoneScore = parseInt(alertText.match(/Score:\s*([0-9]+)/i)?.[1] || '2');
                if (!activeScore.events.includes(`🎯_ZoneTouched_${zoneMedal}_${readableTf}`)) {
                    addedPoints = zoneScore >= 9 ? 5 : zoneScore >= 7 ? 4 : zoneScore >= 5 ? 3 : 2;
                    activeScore.events.push(`🎯_ZoneTouched_${zoneMedal}_${readableTf}`);
                }
            }

            if (addedPoints > 0) {
                activeScore.points += addedPoints;
                activeScore.lastUpdate = nowMs;
                
                // 🔄 Re-validación tardía: si hay un leg pendiente sin confluencia de zona,
                // ahora que llegó un evento de zona, re-evaluar si ya se puede validar
                if (prefix !== 'EVENTO_CHOCH' && prefix !== 'EVENTO_BOS') {
                    const pendingLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
                    if (pendingLeg && !pendingLeg.isValidated && pendingLeg.chochPoints) {
                        const hasZoneNow = activeScore.events.some(e => 
                            e.includes('OB_') || e.includes('GOD_') || e.includes('Breaker_') || 
                            e.includes('Sweep_') || e.includes('DIV_') || e.includes('TL_Sweep_') ||
                            e.includes('ZoneTouched_') || e.includes('Silver_Bullet_')
                        );
                        if (hasZoneNow) {
                            pendingLeg.isValidated = true;
                            pendingLeg.chochEvents = [...activeScore.events, 'CHoCH_3M'];
                            console.log(`[RADAR] ✅ Leg ${currentDirection} en ${ticker} VALIDADO tardíamente con confluencia: ${addedPoints} pts de ${prefix}`);
                        }
                    }
                }
            }

            // --- CAPA 4: VALIDACIÓN DEL CHOCH / BOS ---
            if ((prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') && eventTf === '3') { 
                const triggerType = prefix === 'EVENTO_CHOCH' ? 'CHoCH🚀' : 'BOS🔨';
                
                // 🧹 1. FIX DE MEMORIA FANTASMA (Cooldown)
                if (nowMs - (state.lastSniperAlert ?? 0) < dynamicBotConfig.sniperCooldownMs) {
                    console.log(`[RADAR] ${triggerType} ignorado por Cooldown en ${ticker}. Vaciando residuos de memoria.`);
                    activeScore.points = 0; 
                    activeScore.events = [];
                    return;
                }

                // 🗺️ 2. ANÁLISIS ESPACIAL HOLÍSTICO (reemplaza hasHTFBacking secuencial)
                // Busca respaldo en el MAPA de zonas, no en la mochila de eventos pasados.
                const activeLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
                const chOrigin = activeLeg ? activeLeg.origin : null;
                const chExtreme = activeLeg ? activeLeg.extreme : null;
                const spatialBuffer = getBuffer(ticker, chOrigin ?? state.lastPrice ?? 0);
                const chLow = chOrigin && chExtreme ? Math.min(chOrigin, chExtreme) : null;
                const chHigh = chOrigin && chExtreme ? Math.max(chOrigin, chExtreme) : null;

                // 🏋️ Pesos espaciales: TF más alto → más respaldo macro
                const SPATIAL_WEIGHT: Record<string, number> = { '15': 1.0, '60': 1.5, '240': 2.0 };

                // CASO A: El ORIGEN del CHoCH nació DENTRO de una zona macro
                let caseA_OriginInZone = false;
                let caseA_MaxWeight = 0;
                let caseA_BestTF = '';
                if (chOrigin) {
                    for (const z of state.zones) {
                        if (z.dir !== currentDirection) continue;
                        if (chOrigin <= (z.top + spatialBuffer) && chOrigin >= (z.btm - spatialBuffer)) {
                            const w = SPATIAL_WEIGHT[z.tf || ''] || 1.0;
                            if (w > caseA_MaxWeight) { caseA_MaxWeight = w; caseA_BestTF = z.tf || ''; }
                            caseA_OriginInZone = true;
                        }
                    }
                }

                // CASO B: La VELA del CHoCH TOCÓ una zona macro en su recorrido
                let caseB_PathTouchedZone = false;
                let caseB_MaxWeight = 0;
                let caseB_BestTF = '';
                if (chLow !== null && chHigh !== null) {
                    for (const z of state.zones) {
                        if (z.dir !== currentDirection) continue;
                        if (chHigh >= (z.btm - spatialBuffer) && chLow <= (z.top + spatialBuffer)) {
                            const w = SPATIAL_WEIGHT[z.tf || ''] || 1.0;
                            if (w > caseB_MaxWeight) { caseB_MaxWeight = w; caseB_BestTF = z.tf || ''; }
                            caseB_PathTouchedZone = true;
                        }
                    }
                }

                const spatialMaxWeight = Math.max(caseA_MaxWeight, caseB_MaxWeight);
                const spatialBonus = Math.round(spatialMaxWeight * 5);

                // CASO C: Zona contraria DENTRO del rango del CHoCH (trampa / liquidity grab)
                const caseC_TrapZone = (chLow !== null && chHigh !== null) ? state.zones.filter(z =>
                    z.dir !== currentDirection &&
                    z.top >= chLow && z.btm <= chHigh
                ).length : 0;

                // El respaldo viene del mapa espacial Y/O de la mochila secuencial
                const hasSpatialBacking = caseA_OriginInZone || caseB_PathTouchedZone;
                const hasSequentialBacking = activeScore.events.some(e => 
                    e.includes('OB_') || e.includes('GOD_') || e.includes('Breaker_') || 
                    e.includes('ZoneTouched_') || e.includes('OTE_') ||
                    (e.includes('DIV_') && !e.includes('_3')) || 
                    (e.includes('Sweep_') && !e.includes('_3')) ||
                    (e.includes('TL_Sweep_') && !e.includes('_3'))
                );
                const hasHTFBacking = hasSpatialBacking || hasSequentialBacking;
                
                if (caseA_OriginInZone) console.log(`[RADAR] 🗺️ Caso A | Origen ${chOrigin} nació dentro de zona macro.`);
                if (caseB_PathTouchedZone && !caseA_OriginInZone) console.log(`[RADAR] 🗺️ Caso B | Vela CHoCH (${chLow}-${chHigh}) tocó zona macro en su camino.`);
                if (caseC_TrapZone > 0) console.log(`[RADAR] ⚠️ Caso C | ${caseC_TrapZone} zona(s) contraria(s) dentro del CHoCH → posible trampa.`);
                
                const is15MAgainst = state.marketBias['15'] !== currentDirection && state.marketBias['15'] !== 'NEUTRAL';
                const isMacroAligned = (state.marketBias['240'] === currentDirection) || (state.marketBias['60'] === currentDirection);
                const is4HAgainst = state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL';
                const is1HAgainst = state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL';
                
                let baseBiasPoints = isMacroAligned ? 5 : 0;
                
                let vwapBonus = 0;
                if (upperText.includes('VWAP: UNDER') && currentDirection === 'BUY') { vwapBonus = 2; activeScore.events.push('VWAP_Discount'); } 
                else if (upperText.includes('VWAP: OVER') && currentDirection === 'SELL') { vwapBonus = 2; activeScore.events.push('VWAP_Premium'); }

                // Sumamos todo el puntaje bruto inicial
                let totalPoints = activeScore.points + baseBiasPoints + 2 + vwapBonus; 
                let orphanPenalty = 0;

                // 🛡️ 3. BONO ESPACIAL + PENALIZACIONES
                // El bono espacial reemplaza la penalización cuando hay respaldo por mapa
                if (hasSpatialBacking && spatialBonus > 0) {
                    totalPoints += spatialBonus; // +5 a +10 pts según TF
                    orphanPenalty = 0; // sin penalización porque el mapa respalda
                } else {
                    // 🔧 FIX: Penalización de -3 si no hay zonas en memoria.
                    // PERO: si el puntaje bruto sin penalizar ya es ≥12, la penalización se ANULA.
                    // Esto permite entradas en reversiones contra tendencia (ej: EURUSD 4H/1H SELL
                    // pero 3M BUY acumuló 21 pts por CHoCH + Sweep + DIV — es un setup válido).
                    const rawPenalty = !hasHTFBacking ? 3 : 0;
                    const wouldBeAfterPenalty = totalPoints - rawPenalty;
                    if (rawPenalty > 0 && totalPoints >= 12 && wouldBeAfterPenalty >= 5) {
                        // ⚡ BYPASS: puntaje alto vence la penalización
                        orphanPenalty = 0;
                    } else {
                        orphanPenalty = rawPenalty;
                    }
                    if (orphanPenalty > 0) totalPoints -= orphanPenalty;
                }
                if (is4HAgainst && is1HAgainst) totalPoints -= 3;
                // Penalización por zona trampa (Caso C)
                const trapPenalty = caseC_TrapZone > 0 ? caseC_TrapZone * 2 : 0;
                if (trapPenalty > 0) totalPoints -= trapPenalty;

                // 📊 4. ARMADO DE REPORTE PARA TELEGRAM
                const getIcon = (tf: string) => state.marketBias[tf] === 'BUY' ? '🟢' : state.marketBias[tf] === 'SELL' ? '🔴' : '⚪';

                let confluenceReport = `🗺️ <b>Contexto Macro:</b>\n`;
                confluenceReport += `${getIcon("240")} 4H: ${state.marketBias["240"] || 'NEUTRAL'}\n`;
                confluenceReport += `${getIcon("60")} 1H: ${state.marketBias["60"] || 'NEUTRAL'}\n`;
                confluenceReport += `${getIcon("15")} 15M: ${state.marketBias["15"] || 'NEUTRAL'}\n`;
                confluenceReport += `${getIcon("3")} Gatillo 3M: ${currentDirection} (${triggerType})\n\n`; 
                confluenceReport += `⚖️ <b>Bono de Alineación Macro:</b> +${baseBiasPoints} Pts\n`;
                if (hasSpatialBacking) {
                    const tfLabel = spatialMaxWeight >= 2.0 ? '4H' : spatialMaxWeight >= 1.5 ? '1H' : '15M';
                    confluenceReport += `🗺️ <b>Respaldo Espacial:</b> +${spatialBonus} pts (zona ${tfLabel}, peso ×${spatialMaxWeight})\n`;
                    if (caseA_OriginInZone) confluenceReport += `   📍 Caso A: Origen dentro de zona macro\n`;
                    if (caseB_PathTouchedZone && !caseA_OriginInZone) confluenceReport += `   🛤️ Caso B: Vela CHoCH tocó zona en su camino\n`;
                }
                if (caseC_TrapZone > 0) confluenceReport += `⚠️ <b>Alerta Trampa:</b> ${caseC_TrapZone} zona(s) contraria(s) detectada(s) (-${trapPenalty} pts)\n`;
                if (orphanPenalty > 0 && totalPoints >= 12) {
                    // High-score bypass: la penalización se anuló por puntaje alto
                    confluenceReport += `⚡ <b>BYPASS PUNTAJE ALTO:</b> Penalización de -${orphanPenalty} pts ANULADA (${totalPoints + orphanPenalty} pts brutos ≥ 12). Entrada validada sin zonas macro.\n`;
                } else if (orphanPenalty > 0) {
                    confluenceReport += `⚠️ <b>Penalización CHoCH sin zonas macro:</b> -${orphanPenalty} Pts (las zonas HTF aún no sincronizaron o expiraron)\n`;
                }
                if (!hasSpatialBacking && !hasSequentialBacking && orphanPenalty === 0) confluenceReport += `ℹ️ <b>Sin respaldo de zonas:</b> se permite por bono macro suficiente\n`;

                // 🎯 5. VALIDACIÓN FINAL Y GATILLO
                let sessionThresholds: { buy: number; sell: number } | null = null;
                const isBacktest = tsMatch !== null;
                if (isBacktest) {
                    const { getCurrentSessionThresholds } = await import('../services/backtesting.js');
                    sessionThresholds = getCurrentSessionThresholds();
                }

                let minPtsRequired = currentDirection === 'BUY' 
                    ? (sessionThresholds?.buy || dynamicBotConfig.minPointsForBuy) 
                    : (sessionThresholds?.sell || dynamicBotConfig.minPointsForSell);
                
                if (consecutiveLosses >= 2) minPtsRequired += 2;

                const bestZone = state.zones.filter(z => z.dir === currentDirection).sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

                if (totalPoints >= Math.max(minPtsRequired - 3, 5)) {
                    const activeLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
                    if (activeLeg) {
                        // 🛡️ Requiere al menos 1 evento de zona real O respaldo espacial del mapa de zonas
                        const hasZoneConfluence = activeScore.events.some(e => 
                            e.includes('OB_') || e.includes('GOD_') || e.includes('Breaker_') || 
                            e.includes('Sweep_') || e.includes('DIV_') || e.includes('TL_Sweep_') ||
                            e.includes('ZoneTouched_') || e.includes('Silver_Bullet_')
                        );
                        
                        // El respaldo espacial (Caso A/B) también valida: si el CHoCH nació en zona macro
                        // o la tocó en su recorrido, no necesita eventos secuenciales adicionales.
                        // ⚡ HIGH_SCORE_BYPASS: si acumuló ≥12 pts por eventos puros (CHoCH + Sweeps + DIV),
                        // se valida aunque no haya zonas en memoria. Caso típico: reversión contra tendencia
                        // donde 4H/1H son SELL pero 3M hace CHoCH BUY con múltiples confluencias.
                        const HIGH_SCORE_BYPASS = 12;
                        const efectiveValidation = hasZoneConfluence || hasSpatialBacking || (totalPoints >= HIGH_SCORE_BYPASS);
                        
                        if (efectiveValidation) {
                            activeLeg.isValidated = true;
                            if (!hasZoneConfluence && !hasSpatialBacking && totalPoints >= HIGH_SCORE_BYPASS) {
                                console.log(`[RADAR] ⚡ Leg ${currentDirection} en ${ticker} VALIDADO por PUNTAJE ALTO (${totalPoints} pts ≥ ${HIGH_SCORE_BYPASS}) sin zonas en memoria.`);
                            } else if (hasSpatialBacking && !hasZoneConfluence) {
                                console.log(`[RADAR] ✅ Leg ${currentDirection} en ${ticker} VALIDADO por respaldo ESPACIAL (sin eventos secuenciales). Punta: ${totalPoints} pts.`);
                            }
                        } else {
                            console.log(`[RADAR] ⚠️ Leg ${currentDirection} en ${ticker} con ${totalPoints} pts pero SIN confluencia de zona ni respaldo espacial. OTE en espera.`);
                            activeLeg.isValidated = false;
                        }
                        
                        activeLeg.chochPoints = totalPoints;
                        activeLeg.chochEvents = [...activeScore.events, `${triggerType}_3M`];
                        activeLeg.chochReport = confluenceReport;
                        activeLeg.bestZone = bestZone;
                    }
                    
                    if (totalPoints >= minPtsRequired) {
                        oppositeScore.points = 0; oppositeScore.events = [];
                    }
                    
                    state.lastSniperAlert = nowMs;
                    activeScore.points = 0; activeScore.events = [];
                }
            }
            else if (prefix === 'HEARTBEAT') state.lastHeartbeat = nowMs;
        }

        const MAX_ZONE_AGE_MS: Record<string, number> = { '3': 1800000, '15': 7200000, '60': 28800000, '240': 86400000 };
        state.zones = state.zones.filter(z => {
            if (!z.createdAt) return true; 
            return (nowMs - z.createdAt) < (MAX_ZONE_AGE_MS[z.tf || '60'] || 14400000);
        });

        // 💾 2. GUARDAR LOS CAMBIOS EN LA RAM LOCAL SIEMPRE
        localRadarStates.set(ticker, state);

        // 💾 3. GUARDAR EN FIREBASE (BACKUP INTELIGENTE CADA 5 MINUTOS O EN EVENTOS)
        const timeSinceLastSave = nowMs - (lastFirebaseSave.get(ticker) || 0);
        const FIREBASE_INTERVAL_MS = 5 * 60 * 1000; // 5 Minutos

        if (prefix !== 'PING_PRICE' || timeSinceLastSave > FIREBASE_INTERVAL_MS) {
            docRef.set(state).catch(() => {}); // Guardado silencioso sin await
            lastFirebaseSave.set(ticker, nowMs);
        }

        // =========================================================================
        // EJECUCIÓN OTE FUERA DE LA TRANSACCIÓN
        // =========================================================================
        if (triggerOte && oteData) {
            if (nowMs < streakKillswitchUntil) {
                const remainingMin = Math.round((streakKillswitchUntil - nowMs) / 60000);
                console.log(`[KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por racha perdedora (${consecutiveLosses} pérdidas). Restan ${remainingMin} min de bloqueo.`);
                return;
            }
            if (nowMs < vixKillswitchUntil) {
                const remainingMin = Math.round((vixKillswitchUntil - nowMs) / 60000);
                console.log(`[KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por VIX>30. Restan ${remainingMin} min de bloqueo.`);
                return;
            }

            const fingerprint = `OTE_${ticker}_${oteData.direction}_${oteData.tp1}`;
            if (!isDuplicate(fingerprint, nowMs)) {
                
                const isBacktest = tsMatch !== null;
                let kronosAnnotation = '';
                let kronosVerdict: string = 'SKIP';
                let swarmAnnotation = '';
                let swarmConsensus: string = 'SKIP';
                let sessionId: string | undefined;

                if (isBacktest) {
                    const { getCurrentSessionId } = await import('../services/backtesting.js');
                    sessionId = getCurrentSessionId() || undefined;
                } else {
                    // Kronos AI local (LSTM, sin quota externa)
                    try {
                        const { evaluateWithKronos } = await import('../services/kronos.js');
                        const kRes = await evaluateWithKronos(ticker, oteData.direction as 'BUY' | 'SELL');
                        kronosVerdict = (kRes as any).isConfirmed ? 'CONFIRMED' : 'DIVERGENCE';
                        kronosAnnotation = (kRes as any).trend === null 
                            ? `\n\n🤖 <b>Kronos AI:</b> ${(kRes as any).details}`
                            : `\n\n🤖 <b>Kronos AI:</b> ${(kRes as any).isConfirmed ? '🟢 CONFIRMADO' : '🟠 DIVERGENCIA'}\n${(kRes as any).details}`;
                    } catch { kronosVerdict = 'ERROR'; }

                    // 🐝 Enjambre de IA (solo si Kronos CONFIRMA y puntaje ≥ 8)
                    if (kronosVerdict === 'CONFIRMED' && oteData.points >= 8) {
                        try {
                            const fetch = (await import('node-fetch')).default;
                            const swarmRes = await fetch('http://127.0.0.1:8001/api/analyze-trade', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    ticker,
                                    direction: oteData.direction,
                                    entryPrice: oteData.entryPrice,
                                    stopLoss: parseFloat(oteData.stopLoss),
                                    tp1Price: parseFloat(oteData.tp1),
                                    tp2Price: oteData.tp2 !== 'Buscando DOL macro...' ? parseFloat(oteData.tp2) : undefined,
                                    points: oteData.points,
                                    events: oteData.events || [],
                                    confluenceReport: oteData.confluenceReport || '',
                                    marketBias: oteData.marketBias || {},
                                    consecutiveLosses,
                                    winRate: 0
                                }),
                                signal: AbortSignal.timeout(15000)
                            });
                            if (swarmRes.ok) {
                                const swarm = await swarmRes.json() as any;
                                swarmConsensus = swarm.decision === 'EJECUTAR' ? 'APPROVED' : 'REJECTED';
                                const voteCount = swarm.votes?.filter((v: any) => v.decision === 'APROBADO').length || 0;
                                const totalVotes = swarm.votes?.length || 0;
                                swarmAnnotation = `\n\n🗳️ <b>Votación Multi-IA (DeepSeek):</b> ${swarmConsensus === 'APPROVED' ? '🟢 APROBADO' : '🔴 RECHAZADO'} (${voteCount}/${totalVotes})\n`;
                                if (swarm.votes) {
                                    for (const v of swarm.votes) {
                                        const icon = v.decision === 'APROBADO' ? '✅' : '❌';
                                        swarmAnnotation += `${icon} <b>${v.agent}:</b> ${v.decision === 'APROBADO' ? 'APPROVE' : 'REJECT'} — ${v.reason.split('\n')[0].substring(0, 120)}\n`;
                                    }
                                }
                                swarmAnnotation += `⚖️ <b>Juez:</b> ${swarm.summary || 'Sin resumen'}`;
                            }
                        } catch (swarmErr: any) {
                            swarmConsensus = 'ERROR';
                            console.log(`[SWARM] AI Bridge no disponible: ${swarmErr.message}`);
                        }
                    }
                }

                let msg = `${isBacktest ? "🧪 <b>BACKTESTING</b> | " : "🔥 "}<b>ALERTA FRANCOTIRADOR OTE | ${ticker} | ${oteData.dirText}</b>\n\n`;
                msg += oteData.confluenceReport;
                msg += `🎯 <b>Puntaje Total:</b> ${oteData.points} Puntos\n`;
                msg += `🧱 <b>Confluencias:</b> ${oteData.events?.join(', ')}\n\n`;

                let avisoRiesgo = oteData.points >= 8
                    ? `Operar con riesgo estándar (${dynamicBotConfig.baseRiskPercentage}%).`
                    : `Setup de puntaje medio. Riesgo reducido (${dynamicBotConfig.baseRiskPercentage / 2}%).`;

                msg += `🧠 <b>Jarvis:</b> Llegada a zona OTE confirmada. ${avisoRiesgo}\n\n`;
                msg += `📐 <b>Niveles de Ejecución (GATILLO):</b>\n`;
                msg += `🎯 Precio de Entrada: OTE Actual\n`;
                msg += `🛑 Stop Loss Sugerido: ${oteData.stopLoss}\n`;
                msg += `💰 Take Profit 1 (Interno): ${oteData.tp1}\n`;
                msg += `🚀 Take Profit 2 (Externo): ${oteData.tp2}\n`;

                // 📍 Mostrar la mejor zona estructural detectada (TP/SL desde el mapa)
                if (oteData.bestZone) {
                    const z = oteData.bestZone;
                    const zTf = z.tf ? parseTF(z.tf) : '';
                    const zMedal = z.medal || 'OB';
                    const zScore = z.score !== undefined ? ` (Score: ${z.score}/10)` : '';
                    const zTP = z.tp != null ? ` | 🎯 TP: ${z.tp}` : '';
                    const zSL = z.sl != null ? ` | 🛑 SL: ${z.sl}` : '';
                    msg += `\n📍 <b>Zona Estructural:</b> ${zMedal} ${zTf}${zScore}${zTP}${zSL}`;
                    if (z.top && z.btm) msg += `\n   Rango: ${z.btm} → ${z.top}`;
                }

                msg += kronosAnnotation;
                msg += swarmAnnotation;

                if (!isBacktest) {
                    await sendTelegramAlert(msg);
                }

                const journalId = await logTrade({
                    ticker, direction: oteData.direction as 'BUY' | 'SELL',
                    grade: oteData.points >= 8 ? 'A+' : 'B', points: oteData.points, events: oteData.events,
                    macroContext: oteData.marketBias,
                    kronosVerdict: isBacktest ? 'SKIP_BT' : kronosVerdict,
                    mixtureConsensus: swarmConsensus,
                    timestamp: nowMs,
                    mode: isBacktest ? 'backtesting' : 'live',
                    sessionId,
                    entryPrice: oteData.entryPrice, 
                    tp1Price: parseFloat(oteData.tp1),
                    tp2Price: oteData.tp2 !== 'Buscando DOL macro...' ? parseFloat(oteData.tp2) : undefined,
                    slPrice: parseFloat(oteData.stopLoss),
                }).catch(() => 'ERR');
                
                if (journalId && journalId !== 'ERR' && journalId !== 'N/A') {
                    const activeTrade = activeTrades.get(oteData.tradeId);
                    if (activeTrade) {
                        activeTrade.journalId = journalId;
                        // 💾 Actualizar el journalId en Firebase
                        if (db) db.collection('active_trades').doc(oteData.tradeId).update({ journalId }).catch(() => {});
                    }
                }
            }
        }

    } catch (e: any) {
        console.error(`[RADAR] Error crítico en memoria/Firebase:`, e.message);
    }
}

const WATCHDOG_INTERVAL_MS = 2 * 60 * 1000;
let watchdogStarted = false;

export function startWatchdog() {
    if (watchdogStarted) return;
    watchdogStarted = true;
    
    const checkVix = async () => {
        try {
            const fetch = (await import('node-fetch')).default;
            const FINNHUB_API_KEY = 'd7pt291r01qosaaprsr0d7pt291r01qosaaprsrg';
            const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=VIX&token=${FINNHUB_API_KEY}`);
            const data: any = await res.json();
            if (data.c && data.c > 30) {
                console.log(`[NEWS FILTER] VIX = ${data.c} (>30). KILLSWITCH VIX ACTIVADO.`);
                vixKillswitchUntil = Date.now() + 20 * 60 * 1000;
            } else {
                vixKillswitchUntil = 0;
            }
        } catch (e) {
            console.error('[NEWS FILTER] Error verificando VIX:', e);
        }
    };
    setInterval(checkVix, 15 * 60 * 1000);
    checkVix(); 

    setInterval(() => {
        const now = Date.now();
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        const TRADE_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 horas sin PINGs = cierre automático
        
        for (const [id, trade] of activeTrades) {
            const age = now - trade.timestamp;
            const lastSeen = tickerLastSeen.get(trade.ticker) || 0;
            const inactivity = now - lastSeen;
            
            // Cierre por timeout: 6 horas sin actividad
            if (inactivity > TRADE_TIMEOUT_MS) {
                activeTrades.delete(id);
                if (db) db.collection('active_trades').doc(id).delete().catch(() => {});
                
                const durationMin = Math.round(age / 60000);
                const timeoutMsg = `⏰ <b>TRADE CERRADO POR TIMEOUT | ${trade.ticker} | ${trade.direction}</b>\n\n` +
                    `🕒 Apertura: ${new Date(trade.timestamp).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' })}\n` +
                    `📥 Entrada: ${trade.entryPrice}\n` +
                    `🎯 TP1: ${trade.tp1Price} ${trade.tp1Hit ? '✅' : '⏭️'}\n` +
                    `🛑 SL: ${trade.slPrice}\n` +
                    `📊 Resultado: Indeterminado (sin datos de precio)\n` +
                    `⏱️ Duración total: ${durationMin} min\n\n` +
                    `⚠️ TradingView dejó de enviar alertas para ${trade.ticker}. Trade cerrado automáticamente.`;
                sendTelegramAlert(timeoutMsg).catch(() => {});
                console.log(`[JOURNAL] ⏰ Trade ${id} (${trade.ticker}) cerrado por timeout tras ${Math.round(inactivity / 60000)} min sin PINGs.`);
                
                // Registrar en journal como TIMEOUT
                if (trade.journalId) {
                    recordResult(trade.journalId, 'TIMEOUT').catch(() => {});
                }
                continue;
            }
            
            // Limpieza de trades huérfanos (7 días)
            if (age > SEVEN_DAYS) {
                activeTrades.delete(id);
                if (db) db.collection('active_trades').doc(id).delete().catch(() => {});
                console.log(`[JOURNAL] 🧹 Trade ${id} expirado de RAM (7 días)`);
            }
        }

        for (const [ticker, lastSeen] of tickerLastSeen) {
            const inactiveMin = Math.round((now - lastSeen) / 60000);
            if (now - lastSeen > HEARTBEAT_TIMEOUT_MS) {
                // 🔔 Alerta proactiva de desconexión
                const state = localRadarStates.get(ticker);
                const lastHb = state?.lastHeartbeat || 0;
                const hbInactiveMin = Math.round((now - lastHb) / 60000);
                const disconnectionMsg = `🔌 <b>ALERTA DE DESCONEXIÓN | ${ticker}</b>\n\n` +
                    `⏱️ Sin alertas: ${inactiveMin} minutos\n` +
                    `💓 Último HEARTBEAT: hace ${hbInactiveMin > 0 ? hbInactiveMin + ' min' : 'N/A'}\n` +
                    `📡 Posible falla en TradingView → Vercel → Firebase\n\n` +
                    `🧠 JARVIS sigue escuchando pero no recibe datos de ${ticker}.`;
                sendTelegramAlert(disconnectionMsg).catch(() => {});
                console.warn(`[WATCHDOG] 🔌 ${ticker}: DESCONECTADO hace ${inactiveMin} min. Alerta enviada.`);
                tickerLastSeen.delete(ticker);
            }
        }
    }, WATCHDOG_INTERVAL_MS);
}