import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';
import { evaluateWithKronos } from '../services/kronos.js';
import { evaluateWithMixture } from '../llm/mixture.js';
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

let consecutiveLosses = 0; 
let streakKillswitchUntil = 0;
let vixKillswitchUntil = 0;
let globalKillswitches: Record<string, boolean> = {};
let dynamicBotConfig = {
    sniperCooldownMs: 120000,     
    minPointsForBuy: 5,           
    minPointsForSell: 5,          
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
    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try { await bot.api.sendMessage(userId, message, { parse_mode: 'Markdown' }); } 
        catch (err: any) { try { await bot.api.sendMessage(userId, message); } catch (e) { } }
    }
}

function evaluateImpulse(leg: ImpulseLeg | null | undefined, currentPrice: number, highPrice: number, lowPrice: number, ticker: string, state: RadarState, nowMs: number) {
    if (!leg) return { updatedLeg: null };
    let impulseInvalidated = false;

    if (leg.dir === 'BUY' && highPrice > leg.extreme) leg.extreme = highPrice;
    else if (leg.dir === 'SELL' && lowPrice < leg.extreme) leg.extreme = lowPrice;

    if (leg.dir === 'BUY' && lowPrice < leg.origin) impulseInvalidated = true;
    else if (leg.dir === 'SELL' && highPrice > leg.origin) impulseInvalidated = true;

    if (!impulseInvalidated) {
        const range = Math.abs(leg.extreme - leg.origin);
        const minRange = currentPrice * 0.0005; 
        if (range < minRange) return { updatedLeg: leg };

        const oteTop = leg.dir === 'BUY' ? leg.extreme - (range * 0.50) : leg.extreme + (range * 0.79);
        const oteBtm = leg.dir === 'BUY' ? leg.extreme - (range * 0.79) : leg.extreme + (range * 0.50);

        if (highPrice >= Math.min(oteTop, oteBtm) && lowPrice <= Math.max(oteTop, oteBtm) && !leg.oteScored && leg.isValidated) {
            // 🛡️ Filtro R:R mínimo 1.5:1 — no entrar en trades con ratio desfavorable
            const riskDistance = Math.abs(currentPrice - leg.origin);
            const rewardDistance = Math.abs(leg.extreme - currentPrice);
            const rrRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;
            if (rrRatio < 1.5) {
                console.log(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} descartado: R:R ${rrRatio.toFixed(2)} < 1.5 mínimo`);
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
            if (nowMs - lastSync < throttleMs) return;
            lastSyncTime.set(syncKey, nowMs);
            
            const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();
            const trendMatch = alertText.match(/Trend:\s*(BUY|SELL)/i);
            if (trendMatch) state.marketBias[sourceTf] = trendMatch[1].toUpperCase() as 'BUY' | 'SELL';

            try {
                const rawZones = JSON.parse(payloadStr) as any[];
                const parsedZones: RadarZone[] = rawZones.map(normalizeZone).filter(z => z.top !== undefined && z.btm !== undefined && z.dir !== undefined);
                parsedZones.forEach(z => { z.tf = sourceTf; z.createdAt = nowMs; });

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

            const previousPrice = state.lastPrice; 
            state.lastPrice = currentPrice;
            const hasPreviousPrice = previousPrice !== null;

            const buyRes = evaluateImpulse(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, ticker, state, nowMs);
            state.activeImpulseBuy = buyRes.updatedLeg;
            if (buyRes.triggerOte) { triggerOte = true; oteData = buyRes.oteData; }

            const sellRes = evaluateImpulse(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs);
            state.activeImpulseSell = sellRes.updatedLeg;
            if (sellRes.triggerOte) { triggerOte = true; oteData = sellRes.oteData; }

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
                            
                            const tp1Msg = `🟡 *TP1 ALCANZADO | ${ticker} | ${trade.direction}*\n\n` +
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
                            
                            const tp2Msg = `🟢 *TP2 ALCANZADO (WIN) | ${ticker} | ${trade.direction}*\n\n` +
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
                            ? `🛡️ *BREAK EVEN ALCANZADO | ${ticker} | ${trade.direction}*\n\n` +
                            `🕒 Apertura: ${openTimeStr}\n` + 
                            `📥 Entrada: ${trade.entryPrice}\n` +
                            `🎯 TP1 tocado: Sí (Parcial asegurado)\n` +
                            `🛑 SL: ${trade.slPrice} (Cerrado sin riesgo)\n` +
                            `📊 PnL: 0.00%\n` +
                            `⏱️ Duración: ${durationMin} min`
                            : `🔴 *SL ALCANZADO (LOSS) | ${ticker} | ${trade.direction}*\n\n` +
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

            if (prefix === 'EVENTO_CHOCH') {
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
                            
                            // 🛡️ Anti-Pingpong: No crear leg nuevo si el anterior tiene < 5 min
                            const LEG_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos
                            if (activeLeg.createdAt && (nowMs - activeLeg.createdAt) < LEG_COOLDOWN_MS) {
                                shouldCreateNew = false;
                                console.log(`[FIBO] ⚠️ CHoCH ${currentDirection} ignorado en ${ticker}: leg anterior tiene ${Math.round((nowMs - activeLeg.createdAt) / 1000)}s (cooldown 5 min)`);
                            }
                        }

                        // 🛡️ Rango mínimo del impulso: |extreme - origin| debe superar 2x minRange
                        const impulseRange = Math.abs(actualPrice - newOrigin);
                        const minImpulseRange = actualPrice * 0.001; // 0.1% del precio
                        if (impulseRange < minImpulseRange) {
                            shouldCreateNew = false;
                            console.log(`[FIBO] ⚠️ CHoCH ${currentDirection} en ${ticker}: rango ${impulseRange.toFixed(5)} < mínimo ${minImpulseRange.toFixed(5)}`);
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
                addedPoints = 3; 
            }
            else if (prefix === 'EVENTO_BOS') {
                state.marketBias[eventTf] = currentDirection;
                addedPoints = 1; 
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
                if (prefix !== 'EVENTO_CHOCH') {
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

            // --- CAPA 4: VALIDACIÓN DEL CHOCH ---
            if (prefix === 'EVENTO_CHOCH' && eventTf === '3') { 
                
                // 🧹 1. FIX DE MEMORIA FANTASMA (Cooldown)
                if (nowMs - (state.lastSniperAlert ?? 0) < dynamicBotConfig.sniperCooldownMs) {
                    console.log(`[RADAR] CHoCH ignorado por Cooldown en ${ticker}. Vaciando residuos de memoria.`);
                    activeScore.points = 0; 
                    activeScore.events = [];
                    return;
                }

                // 🗺️ 2. DEFINICIÓN DE CONTEXTO Y MEMORIA ESPACIAL
                const activeLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
                const chOrigin = activeLeg ? activeLeg.origin : null;
                const spatialBuffer = getBuffer(ticker, chOrigin || state.lastPrice || 0);

                // 🛡️ MEMORIA ESPACIAL: ¿El origen del CHoCH nació dentro de una zona Macro?
                const isSpatiallyBacked = chOrigin ? state.zones.some(z => 
                    z.dir === currentDirection && 
                    chOrigin <= (z.top + spatialBuffer) && 
                    chOrigin >= (z.btm - spatialBuffer)
                ) : false;

                const hasHTFBacking = isSpatiallyBacked || activeScore.events.some(e => 
                    e.includes('OB_') || e.includes('GOD_') || e.includes('Breaker_') || 
                    e.includes('ZoneTouched_') || e.includes('OTE_') ||
                    (e.includes('DIV_') && !e.includes('_3')) || 
                    (e.includes('Sweep_') && !e.includes('_3')) ||
                    (e.includes('TL_Sweep_') && !e.includes('_3'))
                );
                
                if (isSpatiallyBacked) console.log(`[RADAR] 🗺️ Confluencia Espacial: El origen del CHoCH (${chOrigin}) nació dentro de una zona Macro validada.`);
                
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

                // 🛡️ 3. PENALIZACIÓN POR FALTA DE RESPALDO HTF (sin veto absoluto)
                orphanPenalty = !hasHTFBacking ? 5 : 0;
                if (orphanPenalty > 0) totalPoints -= orphanPenalty;
                if (is4HAgainst && is1HAgainst) totalPoints -= 3;

                // 📊 4. ARMADO DE REPORTE PARA TELEGRAM
                const getIcon = (tf: string) => state.marketBias[tf] === 'BUY' ? '🟢' : state.marketBias[tf] === 'SELL' ? '🔴' : '⚪';

                let confluenceReport = `🗺️ *Contexto Macro:*\n`;
                confluenceReport += `${getIcon("240")} 4H: ${state.marketBias["240"] || 'NEUTRAL'}\n`;
                confluenceReport += `${getIcon("60")} 1H: ${state.marketBias["60"] || 'NEUTRAL'}\n`;
                confluenceReport += `${getIcon("15")} 15M: ${state.marketBias["15"] || 'NEUTRAL'}\n`;
                confluenceReport += `${getIcon("3")} Gatillo 3M: ${currentDirection}\n\n`; 
                confluenceReport += `⚖️ *Bono de Alineación Macro:* +${baseBiasPoints} Pts\n`;
                if (orphanPenalty > 0) confluenceReport += `⚠️ *Penalización CHoCH Huérfano:* -${orphanPenalty} Pts\n`;

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
                        // 🛡️ Requiere al menos 1 evento de zona real (no solo CHoCH + macro)
                        const hasZoneConfluence = activeScore.events.some(e => 
                            e.includes('OB_') || e.includes('GOD_') || e.includes('Breaker_') || 
                            e.includes('Sweep_') || e.includes('DIV_') || e.includes('TL_Sweep_') ||
                            e.includes('ZoneTouched_') || e.includes('Silver_Bullet_')
                        );
                        
                        if (hasZoneConfluence) {
                            activeLeg.isValidated = true;
                        } else {
                            console.log(`[RADAR] ⚠️ Leg ${currentDirection} en ${ticker} con ${totalPoints} pts pero SIN confluencia de zona. OTE en espera.`);
                            activeLeg.isValidated = false;
                        }
                        
                        activeLeg.chochPoints = totalPoints;
                        activeLeg.chochEvents = [...activeScore.events, 'CHoCH_3M'];
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
                console.log(`[KILLSWITCH] Setup ignorado por racha perdedora.`);
                return;
            }
            if (nowMs < vixKillswitchUntil) {
                console.log(`[KILLSWITCH] Setup ignorado por alta volatilidad (VIX > 30).`);
                return;
            }

            const fingerprint = `OTE_${ticker}_${oteData.direction}_${oteData.tp1}`;
            if (!isDuplicate(fingerprint, nowMs)) {
                
                const isBacktest = tsMatch !== null;
                let kronosResult = { isConfirmed: true, details: "Backtesting: IA omitida." };
                let mixtureResult: any = null;
                let sessionId: string | undefined;

                if (isBacktest) {
                    const { getCurrentSessionId } = await import('../services/backtesting.js');
                    sessionId = getCurrentSessionId() || undefined;
                }

                if (!isBacktest) {
                    const [kRes, mRes] = await Promise.all([
                        evaluateWithKronos(ticker, oteData.direction as 'BUY' | 'SELL').catch((e: any) => ({
                            trend: null as null, isConfirmed: false, details: `🔴 Kronos Error: ${e.message}`
                        })),
                        evaluateWithMixture(
                            `Activo: ${ticker}\nPuntos: ${oteData.points}\nConfluencias: ${oteData.events?.join(', ')}\n${oteData.confluenceReport}`,
                            oteData.direction as 'BUY' | 'SELL'
                        ).catch(() => null)
                    ]);
                    kronosResult = kRes as any;
                    mixtureResult = mRes;
                }

                let kronosAnnotation = isBacktest ? "" : (kronosResult as any).trend === null ? `\n\n🤖 *Kronos AI:* ${(kronosResult as any).details}` : `\n\n🤖 *Kronos AI:* ${(kronosResult as any).isConfirmed ? '🟢 CONFIRMADO' : '🟠 DIVERGENCIA'}\n${(kronosResult as any).details}`;

                let msg = `${isBacktest ? "🧪 *BACKTESTING* | " : "🔥 "}*ALERTA FRANCOTIRADOR OTE | ${ticker} | ${oteData.dirText}*\n\n`;
                msg += oteData.confluenceReport;
                msg += `🎯 *Puntaje Total:* ${oteData.points} Puntos\n`;
                msg += `🧱 *Confluencias:* ${oteData.events?.join(', ')}\n\n`;

                let avisoRiesgo = oteData.points >= 8
                    ? `Operar con riesgo estándar (${dynamicBotConfig.baseRiskPercentage}%).`
                    : `Setup de puntaje medio. Riesgo reducido (${dynamicBotConfig.baseRiskPercentage / 2}%).`;

                msg += `🧠 *Jarvis:* Llegada a zona OTE confirmada. ${avisoRiesgo}\n\n`;
                msg += `📐 *Niveles de Ejecución (GATILLO):*\n`;
                msg += `🎯 Precio de Entrada: OTE Actual\n`;
                msg += `🛑 Stop Loss Sugerido: ${oteData.stopLoss}\n`;
                msg += `💰 Take Profit 1 (Interno): ${oteData.tp1}\n`;
                msg += `🚀 Take Profit 2 (Externo): ${oteData.tp2}\n`;

                if (oteData.bestZone) {
                    msg += `\n📍 Zona Estructural: ${oteData.bestZone.medal || 'OB'} ${oteData.bestZone.tf ? parseTF(oteData.bestZone.tf) : ''}`;
                }

                msg += kronosAnnotation;
                if (mixtureResult) msg += `\n\n${mixtureResult.summary}`;

                if (!isBacktest) {
                    await sendTelegramAlert(msg);
                }

                const journalId = await logTrade({
                    ticker, direction: oteData.direction as 'BUY' | 'SELL',
                    grade: oteData.points >= 8 ? 'A+' : 'B', points: oteData.points, events: oteData.events,
                    macroContext: oteData.marketBias,
                    kronosVerdict: isBacktest ? 'SKIP_BT' : (kronosResult.isConfirmed ? 'CONFIRMED' : 'DIVERGENCE'),
                    mixtureConsensus: mixtureResult?.consensus,
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
                const timeoutMsg = `⏰ *TRADE CERRADO POR TIMEOUT | ${trade.ticker} | ${trade.direction}*\n\n` +
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
            if (now - lastSeen > HEARTBEAT_TIMEOUT_MS) console.warn(`[WATCHDOG] ⚠️ ${ticker}: SIN ALERTAS hace ${Math.round((now - lastSeen) / 60000)} minutos.`);
        }
    }, WATCHDOG_INTERVAL_MS);
}