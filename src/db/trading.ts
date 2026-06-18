import { db } from './memory.js';
import { z } from 'zod';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';
import { logTrade, recordResult, getPerformance, sendDailyReview } from '../services/journal.js';

// --- INTERFACES DEL RADAR JSON ---
interface RadarZone {
    tf?: string;
    dir: 'BUY' | 'SELL';
    top: number;
    btm: number;
    lvl?: string;
    medal?: string;
    score?: number;
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
    activeMacroImpulseBuy?: ImpulseLeg | null;  
    activeMacroImpulseSell?: ImpulseLeg | null; 
    lastGatillo?: { dir: 'BUY' | 'SELL'; price: number; time: number; type: string; status: string; };
    version?: number;
    lastModified?: number;
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
    activeImpulseSell: null,
    activeMacroImpulseBuy: null,
    activeMacroImpulseSell: null,
    lastGatillo: undefined,
    version: 0,
    lastModified: 0
});

const SETUP_MEMORY_WINDOW_MS = 172800000; // 48 Horas (Swing Core)

const TF_WEIGHT: Record<string, number> = {
    '3': 0.5,    // 3M: medio punto (mucho ruido)
    '5': 0.75,   // 5M: tres cuartos
    '15': 1.0,   // 15M: base (gatillo principal)
    '60': 1.5,   // 1H: 50% más
    '240': 2.0,  // 4H: doble
    'D': 3.0,    // Daily: triple
};

interface ActiveTrade {
    tradeId: string;
    journalId?: string;       
    ticker: string;
    direction: 'BUY' | 'SELL';
    entryPrice: number;
    tp1Price: number;         
    tp2Price: number;         
    slPrice: number;
    originalSlPrice?: number; // 🆕 Precio del Stop Loss original antes de ser movido a Breakeven
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

// 🆕 v7.0: Consolidación de Cuenta & Portfolio Global
interface GlobalPortfolioConfig {
    maxDailyLossR: number;       // MDL: R máxima pérdida diaria (ej. 3R)
    dailyProfitTargetR: number;  // DPT: R máximo profit diario (ej. 5R)
    maxTradesPerDay: number;     // MTD: Máximo de operaciones diarias
    maxConsecutiveLosses: number;// MCL: Máximo de pérdidas consecutivas diarias
    trailingDrawdownR: number;   // TDD: Drawdown dinámico máximo diario en R
    enabled: boolean;
}

let globalPortfolioConfig: GlobalPortfolioConfig = {
    maxDailyLossR: 0,
    dailyProfitTargetR: 0,
    maxTradesPerDay: 0,
    maxConsecutiveLosses: 0,
    trailingDrawdownR: 0,
    enabled: false
};

let globalPortfolioKillswitchUntil = 0;

let dynamicBotConfig = {
    sniperCooldownMs: 180000,      // 🔧 v5.4: 3 min (antes 5 min) — se alinea con cierre de vela 3M. Un CHoCH válido
                                   // puede completarse en 1-2 velas de 3M y ya estar listo para el siguiente.
    minPointsForBuy: 5,           // 🔧 Bajado de 6 a 5: filtro de dirección ahora es más estricto
    minPointsForSell: 5,          // 🔧 Bajado de 6 a 5: mismo criterio
    baseRiskPercentage: 1.0,
    slBufferPercent: 0.1,          // 🔧 v5.5: % extra más allá del origin para el SL (absorbe sweeps de liquidez)
    fixedRR: 2.0,                  // 🔧 v5.6: R:R fijo para TP2 (2.0 = 2x el riesgo)
    oteEntryPercent: 50,           // 🔧 Nivel de Fibonacci para entrada en OTE (50, 62, 79, etc)
    entryTrigger: 'OTE' as 'CHOCH' | 'OTE' | 'BOTH' | 'SMART'
};

// 🆕 v6.0: Configuraciones por Activo + Sesión de Mercado
const SessionSchema = z.object({
    choch: z.object({ enabled: z.boolean(), minScore: z.number() }).optional(),
    bos: z.object({ enabled: z.boolean(), minScore: z.number() }).optional(),
    oteChoch: z.object({ enabled: z.boolean(), minScore: z.number(), entryPercent: z.number().optional() }).optional(),
    oteBos: z.object({ enabled: z.boolean(), minScore: z.number(), entryPercent: z.number().optional() }).optional(),
    maxSellLosses: z.number().optional(),
    maxBuyLosses: z.number().optional(),
    slBufferPercent: z.number().optional(),
    fixedRR: z.number().optional()
});

const AssetSessionConfigSchema = z.object({
    minPointsForBuy: z.coerce.number().optional(),
    minPointsForSell: z.coerce.number().optional(),
    slBufferPercent: z.coerce.number().optional(),
    fixedRR: z.coerce.number().optional(),
    oteEntryPercent: z.coerce.number().optional(),
    entryTrigger: z.enum(['CHOCH', 'OTE', 'BOTH', 'SMART']).optional(),
    enabled: z.boolean().optional(),
    maxSellsPerDay: z.coerce.number().optional(),
    sellScorePenalty: z.coerce.number().optional(),
    maxBuysPerDay: z.coerce.number().optional(),
    buyScorePenalty: z.coerce.number().optional(),
    sessions: z.record(z.string(), SessionSchema).optional()
}).passthrough();

type AssetSessionConfig = z.infer<typeof AssetSessionConfigSchema>;

// Map: "BTCUSD_LONDON" -> config
const assetSessionConfigs = new Map<string, AssetSessionConfig>();

// Detecta la sesión actual basándose en hora de Argentina (UTC-3)
function getCurrentSession(): 'LONDON' | 'NY' | 'ASIA' | 'OFF' {
    const now = new Date();
    
    // 📅 Verificar si es fin de semana en Argentina (Sábado o Domingo)
    const dayName = now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short' });
    if (dayName === 'Sat' || dayName === 'Sun') {
        return 'OFF';
    }

    const arStr = now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', minute: 'numeric', hour12: false });
    const [hourStr, minStr] = arStr.split(':');
    const h = parseInt(hourStr);
    const m = parseInt(minStr || '0');
    const t = h + m / 60;
    if (t >= 21 || t < 4) return 'ASIA';
    if (t >= 4 && t < 10.5) return 'LONDON';
    if (t >= 10.5 && t < 17) return 'NY';
    return 'OFF';
}

// Resuelve la config para un ticker: ticker+session > ticker+ALL > global
function getConfigForTicker(ticker: string): typeof dynamicBotConfig & { 
    sessionEnabled: boolean;
    maxSellsPerDay: number;
    sellScorePenalty: number;
    maxBuysPerDay: number;
    buyScorePenalty: number;
    sessions?: Record<string, {
      choch: { enabled: boolean; minScore: number };
      bos: { enabled: boolean; minScore: number };
      oteChoch?: { enabled: boolean; minScore: number; entryPercent?: number };
      oteBos?: { enabled: boolean; minScore: number; entryPercent?: number };
      maxSellLosses?: number;
      maxBuyLosses?: number;
      slBufferPercent?: number;
      fixedRR?: number;
    }>;
} {
    const session = getCurrentSession();
    
    // 💤 Si la sesión es OFF (17 a 21 hs o Fines de Semana), bloquear trading de forma absoluta
    if (session === 'OFF') {
        return { ...dynamicBotConfig, sessionEnabled: false, maxSellsPerDay: 0, sellScorePenalty: 0, maxBuysPerDay: 0, buyScorePenalty: 0 };
    }
    
    // El nuevo AdminPanel guarda la configuración directamente bajo el ID del ticker (ej. NAS100)
    // y maneja las sesiones dentro del campo `sessions`.
    const config = assetSessionConfigs.get(ticker) || assetSessionConfigs.get(`${ticker}_${session}`) || assetSessionConfigs.get(`${ticker}_ALL`);
    
    if (config) {
        console.log(`[CONFIG] 📋 Usando config de: ${ticker}`);
        const sessionConfig = config.sessions ? config.sessions[session] : undefined;
        return {
            ...dynamicBotConfig,
            minPointsForBuy: config.minPointsForBuy ?? dynamicBotConfig.minPointsForBuy,
            minPointsForSell: config.minPointsForSell ?? dynamicBotConfig.minPointsForSell,
            slBufferPercent: sessionConfig?.slBufferPercent ?? config.slBufferPercent ?? dynamicBotConfig.slBufferPercent,
            fixedRR: sessionConfig?.fixedRR ?? config.fixedRR ?? dynamicBotConfig.fixedRR,
            oteEntryPercent: config.oteEntryPercent ?? dynamicBotConfig.oteEntryPercent,
            entryTrigger: config.entryTrigger ?? dynamicBotConfig.entryTrigger,
            sessionEnabled: config.enabled ?? true,
            maxSellsPerDay: config.maxSellsPerDay ?? 0,
            sellScorePenalty: config.sellScorePenalty ?? 0,
            maxBuysPerDay: config.maxBuysPerDay ?? 0,
            buyScorePenalty: config.buyScorePenalty ?? 0,
            sessions: config.sessions as any
        };
    }
    
    // Fallback
    return { ...dynamicBotConfig, sessionEnabled: true, maxSellsPerDay: 0, sellScorePenalty: 0, maxBuysPerDay: 0, buyScorePenalty: 0 };
}

// 🧠 INICIALIZACIÓN DE LA MEMORIA (Carga los trades de Firebase si el servidor se reinicia)
const unsubscribers: (() => void)[] = [];

if (db) {
    try {
        db.collection('active_trades').get().then(snap => {
            snap.forEach(doc => {
                activeTrades.set(doc.id, doc.data() as ActiveTrade);
            });
            console.log(`[RADAR] 🧠 Memoria restaurada: ${activeTrades.size} trades activos cargados.`);
        });

        unsubscribers.push(db.collection('app_settings').doc('global').onSnapshot((snap) => {
            if (snap.exists) globalKillswitches = snap.data()?.killswitches || {};
        }));
        unsubscribers.push(db.collection('app_settings').doc('bot_config').onSnapshot((snap) => {
            if (snap.exists) {
                const data = snap.data() || {};
                dynamicBotConfig = {
                    sniperCooldownMs: Number(data.sniperCooldownMs) || dynamicBotConfig.sniperCooldownMs,
                    minPointsForBuy: Number(data.minPointsForBuy) || dynamicBotConfig.minPointsForBuy,
                    minPointsForSell: Number(data.minPointsForSell) || dynamicBotConfig.minPointsForSell,
                    baseRiskPercentage: Number(data.baseRiskPercentage) || dynamicBotConfig.baseRiskPercentage,
                    slBufferPercent: data.slBufferPercent !== undefined ? Number(data.slBufferPercent) : dynamicBotConfig.slBufferPercent,
                    fixedRR: data.fixedRR !== undefined ? Number(data.fixedRR) : dynamicBotConfig.fixedRR,
                    oteEntryPercent: data.oteEntryPercent !== undefined ? Number(data.oteEntryPercent) : dynamicBotConfig.oteEntryPercent,
                    entryTrigger: data.entryTrigger || dynamicBotConfig.entryTrigger
                };
            }
        }));

        // 🆕 v6.0: Listener para configs por activo+sesión
        unsubscribers.push(db.collection('asset_configs').onSnapshot((snap) => {
            snap.forEach(doc => {
                if (doc.id === 'GLOBAL') {
                    const data = doc.data() || {};
                    globalPortfolioConfig = {
                        maxDailyLossR: Number(data.maxDailyLossR) || 0,
                        dailyProfitTargetR: Number(data.dailyProfitTargetR) || 0,
                        maxTradesPerDay: Number(data.maxTradesPerDay) || 0,
                        maxConsecutiveLosses: Number(data.maxConsecutiveLosses) || 0,
                        trailingDrawdownR: Number(data.trailingDrawdownR) || 0,
                        enabled: data.enabled === true
                    };
                    console.log('[CONFIG] 🧠 Configuración del Portfolio Global cargada:', globalPortfolioConfig);
                    return;
                }
                const parsed = AssetSessionConfigSchema.safeParse(doc.data());
                if (!parsed.success) {
                    console.warn(`[CONFIG] Invalid data in asset_configs for ${doc.id}:`, parsed.error.format());
                    return;
                }
                const data = parsed.data;
                assetSessionConfigs.set(doc.id, {
                    minPointsForBuy: data.minPointsForBuy || dynamicBotConfig.minPointsForBuy,
                    minPointsForSell: data.minPointsForSell || dynamicBotConfig.minPointsForSell,
                    slBufferPercent: data.slBufferPercent !== undefined ? data.slBufferPercent : dynamicBotConfig.slBufferPercent,
                    fixedRR: data.fixedRR !== undefined ? data.fixedRR : dynamicBotConfig.fixedRR,
                    oteEntryPercent: data.oteEntryPercent !== undefined ? data.oteEntryPercent : dynamicBotConfig.oteEntryPercent,
                    entryTrigger: data.entryTrigger || dynamicBotConfig.entryTrigger,
                    enabled: data.enabled !== false, // default enabled
                    maxSellsPerDay: data.maxSellsPerDay || 0,
                    sellScorePenalty: data.sellScorePenalty || 0,
                    maxBuysPerDay: data.maxBuysPerDay || 0,
                    buyScorePenalty: data.buyScorePenalty || 0,
                    sessions: data.sessions as any
                });
            });
            const actualAssets = [...assetSessionConfigs.keys()].filter(k => k !== 'GLOBAL');
            console.log(`[CONFIG] 🧠 ${actualAssets.length} configs por activo+sesión cargadas:`, actualAssets.join(', '));
        }));
        
        const cleanupAndExit = () => {
            console.log('[SHUTDOWN] Limpiando listeners de Firestore en trading.ts...');
            unsubscribers.forEach(unsub => unsub());
        };
        process.on('SIGTERM', cleanupAndExit);
        process.on('SIGINT', cleanupAndExit);
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

// 🛡️ v5.4: Lock por ticker para evitar race conditions (alertas duplicadas en mismo ms)
const tickerLocks = new Map<string, Promise<void>>();

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
const getDecimals = (ticker: string) => (ticker.includes('BTC') || ticker.includes('ETH') || ticker.includes('US30') || ticker.includes('NAS') || ticker.includes('XAU') || ticker.includes('GOLD')) ? 2 : (ticker.includes('JPY') ? 3 : 5);
const getBuffer = (ticker: string, price: number) => (ticker.includes('BTC') || ticker.includes('ETH')) ? price * 0.001 : price * 0.0002;

export const parseTVPrice = (str: string): number => {
    const lastComma = str.lastIndexOf(',');
    const lastDot = str.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
        if (lastComma > lastDot) return parseFloat(str.replace(/\./g, '').replace(',', '.'));
        else return parseFloat(str.replace(/,/g, ''));
    } else if (lastComma > -1) {
        return parseFloat(str.replace(/,/g, '.'));
    }
    return parseFloat(str);
};

async function sendTelegramAlert(message: string) {
    console.log(`[TELEGRAM] Enviando alerta (${message.length} chars) a ${config.TELEGRAM_ALLOWED_USER_IDS.length} usuario(s): [${config.TELEGRAM_ALLOWED_USER_IDS.join(', ')}]`);
    if (message.length > 4096) {
        console.warn(`[TELEGRAM] ⚠️ Mensaje excede 4096 chars (${message.length}). Telegram lo rechazará.`);
        message = message.substring(0, 4090) + '\n...';
    }
    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try { 
            await bot.api.sendMessage(userId, message, { parse_mode: 'HTML' });
            console.log(`[TELEGRAM] ✅ Mensaje enviado exitosamente a userId=${userId}`);
        } catch (err: any) { 
            console.error(`[TELEGRAM] HTML Parse Error (${userId}):`, err.message);
            // Fallback a texto plano eliminando etiquetas si el HTML falla
            const safeText = message.replace(/<[^>]*>?/gm, '');
            try { 
                await bot.api.sendMessage(userId, safeText);
                console.log(`[TELEGRAM] ✅ Fallback (texto plano) enviado a userId=${userId}`);
            } 
            catch (e: any) { console.error(`[TELEGRAM] Fallback Error (${userId}):`, e.message); } 
        }
    }
}

// --- Dynamic SL Buffer Calculator ---
export function calculateDynamicSlBuffer(ticker: string, originPrice: number, bufferConfig: number): number {
    const t = ticker.toUpperCase();
    
    // 1. Forex JPY Pairs (1 pip = 0.01)
    if (t.includes('JPY')) {
        return bufferConfig * 0.1; // e.g. 0.1 -> 0.01 (1 pip)
    }
    
    // 2. Forex Majors/Minors (1 pip = 0.0001)
    const forexPairs = ['EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];
    if (forexPairs.some(fiat => t.includes(fiat)) && !t.includes('BTC') && !t.includes('ETH')) {
        return bufferConfig * 0.001; // e.g. 0.1 -> 0.0001 (1 pip)
    }
    
    // 3. Indices
    const indices = ['US30', 'NAS', 'NDX', 'SPX', 'US500', 'DJI'];
    if (indices.some(idx => t.includes(idx))) {
        return bufferConfig * 100; // e.g. 0.1 -> 10 points
    }
    
    // 4. Metals (Gold)
    if (t.includes('XAU') || t.includes('GOLD')) {
        return bufferConfig * 10; // e.g. 0.1 -> $1
    }
    
    // 5. Default / Crypto (Treat as Percentage)
    return originPrice * (bufferConfig / 100);
}

function evaluateMacroStretching(leg: ImpulseLeg | null | undefined, highPrice: number, lowPrice: number, nowMs: number): ImpulseLeg | null {
    if (!leg) return null;

    // 🧹 Expiración: legs macro duran hasta 24 horas en RAM
    const MAX_MACRO_LEG_AGE_MS = 24 * 60 * 60 * 1000;
    if (leg.createdAt && (nowMs - leg.createdAt) > MAX_MACRO_LEG_AGE_MS) {
        console.log(`[FIBO-MACRO] 🧹 Leg MACRO ${leg.dir} expirado por antigüedad.`);
        return null;
    }

    let macroInvalidated = false;
    
    // Invalida si el precio rompe el origen
    if (leg.dir === 'BUY' && lowPrice < leg.origin) macroInvalidated = true;
    else if (leg.dir === 'SELL' && highPrice > leg.origin) macroInvalidated = true;

    if (macroInvalidated) {
        console.log(`[FIBO-MACRO] 🚫 Leg MACRO ${leg.dir} invalidado por ruptura de origen.`);
        return null;
    }

    // Estirar extremo flexible
    if (leg.dir === 'BUY' && highPrice > leg.extreme) {
        leg.extreme = highPrice;
    } else if (leg.dir === 'SELL' && lowPrice < leg.extreme) {
        leg.extreme = lowPrice;
    }

    return leg;
}

function isInsideMacroOteZone(leg: ImpulseLeg | null | undefined, price: number): boolean {
    if (!leg) return false;
    const range = Math.abs(leg.extreme - leg.origin);
    if (range === 0) return false;
    
    if (leg.dir === 'BUY') {
        const oteBtm = leg.extreme - (range * 0.79);
        const oteTop = leg.extreme - (range * 0.50); // Límite de descuento superior (50%)
        return price >= oteBtm && price <= oteTop;
    } else {
        const oteBtm = leg.extreme + (range * 0.50);
        const oteTop = leg.extreme + (range * 0.79);
        return price >= oteBtm && price <= oteTop;
    }
}

function evaluateImpulse(leg: ImpulseLeg | null | undefined, currentPrice: number, highPrice: number, lowPrice: number, ticker: string, state: RadarState, nowMs: number) {
    if (!leg) return { updatedLeg: null };
    let impulseInvalidated = false;

    // 🔧 FIX 1: Stale leg cleaner — legs de más de 24 horas se invalidan automáticamente (Swing)
    const MAX_LEG_AGE_MS = 24 * 60 * 60 * 1000;
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

        const config = getConfigForTicker(ticker);
        const currentSession = getCurrentSession();
        const sessionConfig = config.sessions?.[currentSession];
        const isChoch = leg.chochEvents?.some(e => e.includes('CHOCH') || e.includes('CHoCH')) || false;
        const isBos = leg.chochEvents?.some(e => e.includes('BOS')) || false;

        let activeOteEntryPercent = config.oteEntryPercent || 50;
        if (sessionConfig) {
            if (isChoch) {
                activeOteEntryPercent = sessionConfig.oteChoch?.entryPercent ?? config.oteEntryPercent ?? 50;
            } else if (isBos) {
                activeOteEntryPercent = sessionConfig.oteBos?.entryPercent ?? config.oteEntryPercent ?? 50;
            } else {
                activeOteEntryPercent = config.oteEntryPercent ?? 50;
            }
        }

        const fibRatio = activeOteEntryPercent / 100;
        const entryLevel = leg.dir === 'BUY' ? leg.extreme - (range * fibRatio) : leg.extreme + (range * fibRatio);

        // 🔓 OTE entry: el leg fue creado por un CHoCH que ya pasó todos los filtros de puntaje.
        // No re-validamos con leg.isValidated porque el reset del score borra los eventos
        // de zona ANTES de llegar aquí, causando que el 90% de los legs queden isValidated=false.
        // Si el leg existe y no fue invalidado por precio ni expiración, el OTE es válido.
        // PERO: legs con < 8 chochPoints y sin validación se filtran (baja calidad).
        
        const isEntryHit = leg.dir === 'BUY' ? lowPrice <= entryLevel : highPrice >= entryLevel;
        
        if (isEntryHit && !leg.oteScored) {

            let oteEnabled = false;
            let oteMinScore = 8;

            if (sessionConfig) {
                if (isChoch) {
                    oteEnabled = sessionConfig.oteChoch?.enabled ?? false;
                    oteMinScore = sessionConfig.oteChoch?.minScore ?? 8;
                } else if (isBos) {
                    oteEnabled = sessionConfig.oteBos?.enabled ?? false;
                    oteMinScore = sessionConfig.oteBos?.minScore ?? 8;
                } else {
                    oteEnabled = false;
                    oteMinScore = 8;
                }
            } else {
                oteEnabled = (config.entryTrigger === 'OTE' || config.entryTrigger === 'BOTH');
                oteMinScore = 8;
            }

            const totalPoints = (leg.chochPoints || 0) + 4;

            if (sessionConfig) {
                if (!oteEnabled || totalPoints < oteMinScore) {
                    console.log(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: OTE deshabilitado o puntaje ${totalPoints} < requerido ${oteMinScore} para esta sesión`);
                    return { updatedLeg: leg };
                }
            } else {
                const MIN_OTE_POINTS = 8;
                if (!leg.isValidated && (leg.chochPoints || 0) < MIN_OTE_POINTS) {
                    console.log(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: leg no validado y solo ${leg.chochPoints || 0} pts (< ${MIN_OTE_POINTS})`);
                    return { updatedLeg: leg };
                }
                if (!oteEnabled || totalPoints < oteMinScore) {
                    console.log(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: OTE deshabilitado o puntaje ${totalPoints} < requerido ${oteMinScore} de base`);
                    return { updatedLeg: leg };
                }
            }

            // 🛡️ Filtro R:R teórico del OTE (50%-79% de retroceso del impulso)
            // El R:R se calcula sobre los niveles ESTRUCTURALES del OTE, no sobre el precio
            // actual de la vela (que puede estar desviado del OTE exacto).
            // A 50% retroceso: R:R = 1.0, a 79% retroceso: R:R = 3.76
            const riskDistanceOTE = Math.abs(leg.extreme - leg.origin) * 0.21; // peor caso: 79% fib
            const rewardDistanceOTE = Math.abs(leg.extreme - leg.origin) * 0.50; // 50% fib OTE
            const rrRatioOTE = riskDistanceOTE > 0 ? rewardDistanceOTE / riskDistanceOTE : 1.0;
            if (riskDistanceOTE === 0 || rrRatioOTE < 1.2) {
                console.error(`[FIBO] ❌ R:R invalid: risk=${riskDistanceOTE}, reward=${rewardDistanceOTE}, ratio=${rrRatioOTE}`);
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
                // 🔧 FIX: Calculamos la distancia del stop loss usando el buffer dinámico por activo
                const slBuffer = calculateDynamicSlBuffer(ticker, leg.origin, config.slBufferPercent);
                const adjustedSL = leg.dir === 'BUY' ? leg.origin - slBuffer : leg.origin + slBuffer;
                const stopLoss = adjustedSL.toFixed(decimals);
                const tp1 = leg.extreme.toFixed(decimals);
                const riskDist = Math.abs(currentPrice - adjustedSL);
                // Aseguramos que TP2 sea siempre más ambicioso que TP1 para setups OTE
                const oteTP2Limit = leg.dir === 'BUY'
                    ? leg.extreme + (range * 0.27)
                    : leg.extreme - (range * 0.27);
                const fixedTP2 = leg.dir === 'BUY'
                    ? Math.max(oteTP2Limit, currentPrice + (riskDist * config.fixedRR))
                    : Math.min(oteTP2Limit, currentPrice - (riskDist * config.fixedRR));
                const tp2 = fixedTP2.toFixed(decimals);

                const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();

                console.log(`[FIBO] 🎯 RETROCESO 50% CONFIRMADO para ${ticker} ${leg.dir}. Despertando IA...`);

                const bias240 = state.marketBias["240"] || 'NEUTRAL';
                const bias60 = state.marketBias["60"] || 'NEUTRAL';
                const bias15 = state.marketBias["15"] || 'NEUTRAL';
                const getIconStr = (bias: string) => bias === 'BUY' ? '🟢' : bias === 'SELL' ? '🔴' : '⚪';
                const fallbackReport = `🗺️ <b>Contexto Macro:</b>\n` +
                    `${getIconStr(bias240)} 4H: ${bias240}\n` +
                    `${getIconStr(bias60)} 1H: ${bias60}\n` +
                    `${getIconStr(bias15)} 15M: ${bias15}\n\n` +
                    `🎯 <b>Confluencia de Entrada:</b> Retroceso OTE 3M en nivel del 50% Fibo (Puntaje base: ${leg.chochPoints || 0} pts + OTE: +4 pts).`;

                const oteData = {
                    tradeId, 
                    direction: leg.dir,
                    dirText: leg.dir === 'BUY' ? 'COMPRA' : 'VENTA',
                    stopLoss, tp1, tp2,
                    entryPrice: currentPrice,
                    points: (leg.chochPoints || 0) + 4, 
                    events: [...(leg.chochEvents || []), eventName],
                    confluenceReport: leg.chochReport || fallbackReport,
                    bestZone: leg.bestZone || null,
                    marketBias: { ...state.marketBias },
                    isChochEntry: false
                };

                const newTrade: ActiveTrade = {
                    tradeId, ticker, direction: leg.dir,
                    entryPrice: currentPrice,
                    tp1Price: leg.extreme,
                    tp2Price: fixedTP2,
                    slPrice: adjustedSL,
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

/**
 * Evalúa los límites del Killswitch Global de la Cuenta (Consolidación de Cuenta)
 * consultando los resultados cerrados del día de hoy en 'trade_journal'.
 * Retorna true si hay un bloqueo activo (cuenta deshabilitada temporalmente para operar hoy).
 */
async function evaluateGlobalKillswitch(nowMs: number): Promise<boolean> {
    if (!globalPortfolioConfig.enabled) {
        return false;
    }

    if (nowMs < globalPortfolioKillswitchUntil) {
        return true;
    }

    if (!db) return false;

    try {
        // Calcular la medianoche de hoy en Argentina (UTC-3)
        // La medianoche en ART es a las 03:00:00 UTC
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now); // YYYY-MM-DD
        const dateParts = argDateStr.split('-');
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1;
        const day = parseInt(dateParts[2]);

        const artMidnight = new Date(Date.UTC(year, month, day, 3, 0, 0));
        const artMidnightMs = artMidnight.getTime();

        // Consultar los trades de hoy
        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .get();

        if (snapshot.empty) {
            return false;
        }

        // Mapear y ordenar ascendentemente por timestamp para evaluar rachas correctamente
        const trades = snapshot.docs
            .map(d => d.data())
            .filter(t => t.mode !== 'backtesting' && t.result)
            .sort((a, b) => a.timestamp - b.timestamp);

        let totalTrades = trades.length;
        let dailyPnLR = 0;
        let peakPnLR = 0;
        let consecutiveLosses = 0;
        let maxConsecutiveLosses = 0;

        for (const t of trades) {
            let rMultiple = Number(t.rMultiple);
            if (isNaN(rMultiple) || rMultiple === undefined) {
                // Fallback si no está el rMultiple explícito
                if (t.result === 'WIN') {
                    rMultiple = 1.5;
                } else if (t.result === 'LOSS') {
                    rMultiple = -1.0;
                } else {
                    rMultiple = 0;
                }
            }

            dailyPnLR += rMultiple;
            if (dailyPnLR > peakPnLR) {
                peakPnLR = dailyPnLR;
            }

            // Consideramos una pérdida si rMultiple es negativo (ej. <= -0.5R)
            if (rMultiple < 0) {
                consecutiveLosses++;
                if (consecutiveLosses > maxConsecutiveLosses) {
                    maxConsecutiveLosses = consecutiveLosses;
                }
            } else if (rMultiple > 0) {
                // Se reinicia o reduce en racha (ej. TP1 exitosa o TP2 exitoso corta la racha)
                consecutiveLosses = 0;
            }
        }

        const trailingDrawdown = peakPnLR - dailyPnLR;

        // Comprobación de límites
        let isKilled = false;
        let killReason = '';

        if (globalPortfolioConfig.maxDailyLossR > 0 && dailyPnLR <= -globalPortfolioConfig.maxDailyLossR) {
            isKilled = true;
            killReason = `Max Daily Loss superado (-${globalPortfolioConfig.maxDailyLossR}R | PnL: ${dailyPnLR.toFixed(2)}R)`;
        } else if (globalPortfolioConfig.dailyProfitTargetR > 0 && dailyPnLR >= globalPortfolioConfig.dailyProfitTargetR) {
            isKilled = true;
            killReason = `Daily Profit Target alcanzado (+${globalPortfolioConfig.dailyProfitTargetR}R | PnL: ${dailyPnLR.toFixed(2)}R)`;
        } else if (globalPortfolioConfig.maxTradesPerDay > 0 && totalTrades >= globalPortfolioConfig.maxTradesPerDay) {
            isKilled = true;
            killReason = `Max Trades per Day superado (${globalPortfolioConfig.maxTradesPerDay} trades | Realizados: ${totalTrades})`;
        } else if (globalPortfolioConfig.maxConsecutiveLosses > 0 && maxConsecutiveLosses >= globalPortfolioConfig.maxConsecutiveLosses) {
            isKilled = true;
            killReason = `Max Consecutive Losses superado (${globalPortfolioConfig.maxConsecutiveLosses} consecutivas | Racha: ${maxConsecutiveLosses})`;
        } else if (globalPortfolioConfig.trailingDrawdownR > 0 && trailingDrawdown >= globalPortfolioConfig.trailingDrawdownR) {
            isKilled = true;
            killReason = `Trailing Drawdown superado (${globalPortfolioConfig.trailingDrawdownR}R | Drawdown: ${trailingDrawdown.toFixed(2)}R)`;
        }

        if (isKilled) {
            // El bloqueo dura hasta el final de la sesión de hoy (23:59:59 ART de hoy)
            const endOfDayMs = artMidnightMs + 24 * 60 * 60 * 1000 - 1000;
            globalPortfolioKillswitchUntil = endOfDayMs;

            const timeStr = new Date(endOfDayMs).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
            const warningMsg = `🚨 <b>[KILLSWITCH PORTAFOLIO GLOBAL]</b> 🚨\n\n` +
                `⚠️ <b>Cuenta Bloqueada Temporalmente</b>\n` +
                `📋 <b>Causa:</b> ${killReason}\n` +
                `⏳ <b>Duración:</b> Hasta el final del día de hoy (reseteo a medianoche ART - aprox ${timeStr})\n\n` +
                `💡 <i>Las alertas en vivo Sniper OTE se filtrarán automáticamente y no se enviarán a ejecución para proteger el balance de la cuenta consolidada.</i>`;

            sendTelegramAlert(warningMsg).catch(() => {});
            console.log(`[KILLSWITCH GLOBAL] ⛔ Cuenta bloqueada. Causa: ${killReason}`);
            return true;
        }

        return false;
    } catch (e: any) {
        console.error('[KILLSWITCH GLOBAL] Error evaluando el riesgo unificado:', e.message);
        return false;
    }
}

/**
 * 🆕 v7.1: Cuenta los trades SELL ejecutados hoy para un ticker específico.
 * Se usa para implementar el límite diario de operaciones en corto por activo.
 * Activos con sesgo alcista (NAS100, US500, etc.) pueden tener un cap de SELLs diarios
 * para evitar rachas perdedoras que activen el killswitch.
 */
async function countDailySellsForTicker(ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now);
        const dateParts = argDateStr.split('-');
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1;
        const day = parseInt(dateParts[2]);
        const artMidnightMs = new Date(Date.UTC(year, month, day, 3, 0, 0)).getTime();

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) {
            tickerVariants.push('NAS100', 'US100');
        }

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', 'SELL')
            .get();

        return snapshot.docs.filter(d => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
    } catch (e: any) {
        return 0;
    }
}

/**
 * 🆕 v7.2: Cuenta los trades BUY ejecutados hoy para un ticker específico.
 */
async function countDailyBuysForTicker(ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now);
        const dateParts = argDateStr.split('-');
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1;
        const day = parseInt(dateParts[2]);
        const artMidnightMs = new Date(Date.UTC(year, month, day, 3, 0, 0)).getTime();

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) {
            tickerVariants.push('NAS100', 'US100');
        }

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', 'BUY')
            .get();

        return snapshot.docs.filter(d => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
    } catch (e: any) {
        return 0;
    }
}

/**
 * Cuenta las pérdidas consecutivas de un activo en la sesión y dirección actual para el día de hoy.
 */
async function countConsecutiveLosses(ticker: string, session: string, direction: 'BUY' | 'SELL', nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now);
        const dateParts = argDateStr.split('-');
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1;
        const day = parseInt(dateParts[2]);
        const artMidnightMs = new Date(Date.UTC(year, month, day, 3, 0, 0)).getTime();

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) {
            tickerVariants.push('NAS100', 'US100');
        }

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', direction)
            .get();

        if (snapshot.empty) return 0;

        const trades = snapshot.docs
            .map(d => d.data())
            .filter(t => {
                const isMatchingTicker = tickerVariants.includes(t.ticker);
                const isMatchingSession = t.session === session;
                const modeMatch = isBacktest ? t.mode === 'backtesting' : t.mode !== 'backtesting';
                const sessionMatch = isBacktest ? (backtestSessionId ? t.sessionId === backtestSessionId : true) : true;
                return modeMatch && sessionMatch && isMatchingTicker && isMatchingSession && t.result;
            })
            .sort((a, b) => a.timestamp - b.timestamp);

        let streak = 0;
        for (const t of trades) {
            let rMultiple = Number(t.rMultiple);
            if (isNaN(rMultiple) || rMultiple === undefined) {
                if (t.result === 'WIN') {
                    rMultiple = 1.5;
                } else if (t.result === 'LOSS') {
                    rMultiple = -1.0;
                } else {
                    rMultiple = 0;
                }
            }

            if (rMultiple < 0) {
                streak++;
            } else if (rMultiple > 0) {
                streak = 0;
            }
        }
        return streak;
    } catch (e: any) {
        console.error('[STREAK LIMIT] Error contando pérdidas consecutivas:', e.message);
        return 0;
    }
}

export async function processTradingAlert(alertText: string) {
    if (!db) return;

    // 🕒 El Bypass Temporal (Bar Replay Histórico)
    const tsMatch = alertText.match(/TS:\s*([0-9]+)/i);
    const nowMs = tsMatch ? parseInt(tsMatch[1], 10) : Date.now();
    const isBacktest = tsMatch !== null && Math.abs(Date.now() - nowMs) > 300000;

    // 🧠 FASE 1 - MACHINE LEARNING: Guardar la señal cruda para la Fase 2 (Auto-Tune)
    if (!isBacktest) { // Solo guardamos las señales reales en vivo
        db.collection('raw_signals').add({
            timestamp: nowMs,
            alertText,
            createdAt: new Date(nowMs).toISOString()
        }).catch(() => {});
    }

    const textUpToPayload = alertText.includes('Payload:') ? alertText.split('Payload:')[0] : alertText;
    const parts = textUpToPayload.split(/[,|]/).map(p => p.trim());

    if (parts.length < 2) return;

    const prefix = parts[0].toUpperCase();
    const ticker = parts[1].replace(/"/g, '');
    const upperText = alertText.toUpperCase();

    // 🤖 v6.0: Verificación de Apagado Maestro (Master Killswitch)
    if (globalKillswitches['GLOBAL_SYSTEM']) {
        if (ticker === 'BTCUSD' && !globalKillswitches['BTCUSD']) {
            console.log(`[RADAR] 🤖 Master Killswitch activo, pero permitiendo BTCUSD de forma excepcional.`);
        } else {
            console.log(`[RADAR] 🚫 Alerta para ${ticker} ignorada debido a que el BOT GLOBAL está APAGADO.`);
            return;
        }
    } else if (globalKillswitches[ticker]) {
        console.log(`[RADAR] 🚫 Alerta para ${ticker} ignorada por killswitch individual activo.`);
        return;
    }

    // 🛡️ v5.4: Lock por ticker — evita race conditions que causan alertas duplicadas
    // Dos PINGs del mismo ticker se procesan secuencialmente, no en paralelo
    const previousLock = tickerLocks.get(ticker) || Promise.resolve();
    let releaseLock: () => void;
    const newLock = new Promise<void>(resolve => { releaseLock = resolve; });
    tickerLocks.set(ticker, newLock);
    
    try {
        await previousLock; // Esperar que termine el procesamiento anterior de este ticker
    } catch (e: any) {
        // Error en el lock secuencial (raro, pero manejado)
        console.error(`[RADAR] Error en lock para ${ticker}:`, e.message);
    }

    // 🔧 v5.5: SOLO tickers reales (no prefijos de eventos como HEARTBEAT, EVENTO_CHOCH...)
    // Los prefijos de eventos llegan porque TradingView usa el prefijo como "ticker" en algunas alertas.
    const FAKE_TICKERS = new Set(['HEARTBEAT', 'EVENTO_CHOCH', 'EVENTO_BOS', 'SWEEP_BROKEN', 
                                   'DIV_BROKEN', 'EVENTO_SMC_DIV', 'EVENTO_SWEEP', 'EVENTO_SWEEP_TL',
                                   'EVENTO_SWEEP_SCALP', 'SYNC_ZONES', 'PING_PRICE']);
    if (!FAKE_TICKERS.has(prefix)) {
        tickerLastSeen.set(ticker, nowMs);
    }

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
            const priceMatch = alertText.match(/Precio:\s*([0-9.,]+)/i);
            if (!priceMatch) return;

            const currentPrice = parseTVPrice(priceMatch[1]);
            const highMatch = alertText.match(/High:\s*([0-9.,]+)/i);
            const lowMatch = alertText.match(/Low:\s*([0-9.,]+)/i);
            const highPrice = highMatch ? parseTVPrice(highMatch[1]) : currentPrice;
            const lowPrice = lowMatch ? parseTVPrice(lowMatch[1]) : currentPrice;

            // 🔧 FIX: Guardar precio anterior ANTES de actualizar para detectar dirección de entrada
            const previousPrice = state.lastPrice; 
            const hasPreviousPrice = previousPrice !== null;
            // Actualizar después de guardar la referencia
            state.lastPrice = currentPrice;
            lastPingTime = nowMs; // 🏥 Healthcheck
            // Guardar también el precio previo para referencia en el siguiente tick
            (state as any).previousPrice = previousPrice;

            // 🛡️ CRÍTICO: Verificar killswitches ANTES de evaluateImpulse() para evitar trades huérfanos
            const config = getConfigForTicker(ticker);
            const isKillswitched = nowMs < streakKillswitchUntil || nowMs < vixKillswitchUntil || !config.sessionEnabled;
            
            if (!isKillswitched) {
                // 🗺️ Estirar patas Macro si están activas
                if (state.activeMacroImpulseBuy) {
                    state.activeMacroImpulseBuy = evaluateMacroStretching(state.activeMacroImpulseBuy, highPrice, lowPrice, nowMs);
                }
                if (state.activeMacroImpulseSell) {
                    state.activeMacroImpulseSell = evaluateMacroStretching(state.activeMacroImpulseSell, highPrice, lowPrice, nowMs);
                }

                const buyRes = evaluateImpulse(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, ticker, state, nowMs);
                state.activeImpulseBuy = buyRes.updatedLeg;
                if (buyRes.triggerOte) { triggerOte = true; oteData = buyRes.oteData; console.log(`[SNIPER] 🔫 evaluateImpulse BUY → triggerOte=true para ${ticker}`); }

                const sellRes = evaluateImpulse(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs);
                state.activeImpulseSell = sellRes.updatedLeg;
                if (sellRes.triggerOte) { triggerOte = true; oteData = sellRes.oteData; console.log(`[SNIPER] 🔫 evaluateImpulse SELL → triggerOte=true para ${ticker}`); }
            }

            // =========================================================
            // GESTIÓN DE TRADES ACTIVOS (TP Y SL)
            // =========================================================
            if (activeTrades.size > 0) {
                for (const [tradeId, trade] of activeTrades) {
                    if (trade.ticker !== ticker) continue;
                    const nowTrade = nowMs;
                    
                    // 🛡️ v5.4: Anti-instantáneo — no evaluar TP/SL si el trade se creó hace < 5s
                    // Evita que un trade se cierre en el mismo ciclo que se abrió (falsos TP1)
                    const tradeAgeMs = nowTrade - trade.timestamp;
                    if (tradeAgeMs < 5000) {
                        console.log(`[TRADE] ⏭️ ${ticker} #${tradeId}: omitiendo eval TP/SL (antigüedad ${tradeAgeMs}ms < 5s)`);
                        continue;
                    }
                    
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
                            trade.originalSlPrice = trade.slPrice;
                            trade.slPrice = trade.entryPrice; // Move SL to entry price (BE)
                            
                            const durationSec = Math.round((nowTrade - trade.timestamp) / 1000);
                            const durationStr = durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`;
                            
                            // 💾 Sincronizar actualización de TP1 (SL cambia a Breakeven)
                            if (db) db.collection('active_trades').doc(trade.tradeId).update({ 
                                tp1Hit: true,
                                slPrice: trade.entryPrice,
                                originalSlPrice: trade.originalSlPrice
                            }).catch(() => {});
                            
                            if (trade.journalId) {
                                const { db: fireDb } = await import('./memory.js');
                                if (fireDb) {
                                    fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        tp1Hit: true,
                                        tp1Timestamp: nowTrade,
                                        slPrice: trade.entryPrice,
                                        originalSlPrice: trade.originalSlPrice
                                    }).catch(() => {});
                                }
                            }
                            
                            const tp1Msg = `🟡 <b>TP1 ALCANZADO | ${ticker} | ${trade.direction}</b>\n\n` +
                                `🕒 Apertura: ${openTimeStr}\n` + 
                                `📥 Entrada: ${trade.entryPrice}\n` +
                                `🎯 TP1: ${trade.tp1Price} ✅\n` +
                                `🚀 TP2: ${trade.tp2Price > 0 ? trade.tp2Price : '—'}\n` +
                                `🛑 SL (Ajustado a Breakeven): ${trade.entryPrice}\n` +
                                `⏱️ Duración: ${durationStr}\n\n` +
                                `💡 Toma parcial ejecutada (50%). El Stop Loss se ha movido automáticamente al precio de entrada (Breakeven) para proteger la operación.`;
                            if (!isBacktest) sendTelegramAlert(tp1Msg).catch(() => {});
                            console.log(`[JOURNAL] 🟡 TP1 alcanzado: ${ticker} ${trade.direction} #${tradeId} — Toma parcial ejecutada, SL ajustado a Breakeven`);
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
                            const pnlTp1Pct = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
                            const pnlTp2Pct = Math.abs(trade.tp2Price - trade.entryPrice) / trade.entryPrice * 100;
                            const finalPnlPct = trade.tp1Hit ? (pnlTp1Pct * 0.5 + pnlTp2Pct * 0.5) : pnlTp2Pct;
                            
                            const originalSl = trade.originalSlPrice ?? trade.slPrice;
                            const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
                            const rMultiple = initialSlLossPct > 0 ? parseFloat((finalPnlPct / initialSlLossPct).toFixed(4)) : 1.5;
                            const durationMin = Math.round((nowTrade - trade.timestamp) / 60000);
                            
                            if (trade.journalId) {
                                const { db: fireDb } = await import('./memory.js');
                                if (fireDb) {
                                    fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        tp2Hit: true,
                                        tp2Timestamp: nowTrade,
                                        result: 'WIN',
                                        pnl: parseFloat(finalPnlPct.toFixed(2)),
                                        rMultiple,
                                        durationMin,
                                    }).catch(() => {});
                                }
                            }
                            if (trade.journalId) {
                                recordResult(trade.journalId, 'WIN', parseFloat(finalPnlPct.toFixed(2))).catch(() => {});
                            } else {
                                recordResult(tradeId, 'WIN', parseFloat(finalPnlPct.toFixed(2))).catch(() => {});
                            }

                            if (trade.tp1Hit) consecutiveLosses = Math.max(0, consecutiveLosses - 1);
                            else consecutiveLosses = 0;
                            
                            const tp2Msg = `🟢 <b>TP2 ALCANZADO (WIN) | ${ticker} | ${trade.direction}</b>\n\n` +
                                `🕒 Apertura: ${openTimeStr}\n` + 
                                `📥 Entrada: ${trade.entryPrice}\n` +
                                `🎯 TP1: ${trade.tp1Price} ${trade.tp1Hit ? '✅' : '⏭️'}\n` +
                                `🚀 TP2: ${trade.tp2Price} ✅\n` +
                                `📊 PnL: +${finalPnlPct.toFixed(2)}%\n` +
                                `⏱️ Duración total: ${durationMin} min\n\n` +
                                `🏆 ¡Trade completo! ${consecutiveLosses > 0 ? `Racha protección: ${consecutiveLosses} pérdidas` : 'Racha limpia.'}`;
                            if (!isBacktest) sendTelegramAlert(tp2Msg).catch(() => {});
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

                        const isPartialClose = trade.tp1Hit;
                        const originalSl = trade.originalSlPrice ?? trade.slPrice;
                        const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
                        const currentSlLossPct = Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100;
                        const pnlTp1Pct = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
                        const finalPnlPct = isPartialClose ? (pnlTp1Pct * 0.5 - currentSlLossPct * 0.5) : -currentSlLossPct;
                        const rMultiple = initialSlLossPct > 0 ? parseFloat((finalPnlPct / initialSlLossPct).toFixed(4)) : 0;
                        const finalResult = isPartialClose ? (finalPnlPct >= 0 ? 'BREAKEVEN' : 'LOSS') : 'LOSS';
                        const durationMin = Math.round((nowTrade - trade.timestamp) / 60000);
                        
                        if (trade.journalId) {
                            const { db: fireDb } = await import('./memory.js');
                            if (fireDb) {
                                fireDb.collection('trade_journal').doc(trade.journalId).update({
                                    slHit: true,
                                    slTimestamp: nowTrade,
                                    result: finalResult,
                                    pnl: parseFloat(finalPnlPct.toFixed(2)),
                                    rMultiple,
                                    durationMin,
                                }).catch(() => {});
                            }
                        }
                        
                        // Si tomamos parciales, igual registramos la operación para no castigar
                        if (!isPartialClose) {
                            if (trade.journalId) {
                                recordResult(trade.journalId, 'LOSS', parseFloat(finalPnlPct.toFixed(2))).catch(() => {});
                            } else {
                                recordResult(tradeId, 'LOSS', parseFloat(finalPnlPct.toFixed(2))).catch(() => {});
                            }
                        } else {
                            if (trade.journalId) {
                                recordResult(trade.journalId, 'BREAKEVEN', parseFloat(finalPnlPct.toFixed(2))).catch(() => {});
                            } else {
                                recordResult(tradeId, 'BREAKEVEN', parseFloat(finalPnlPct.toFixed(2))).catch(() => {});
                            }
                        }

                        // Lógica de racha perdedora (solo contar PÉRDIDAS reales, no breakevens ni parciales)
                        const isBreakevenResult = trade.tp1Hit && !trade.tp2Hit;
                        if (!isPartialClose && !isBreakevenResult) {
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
                        const slMsg = isPartialClose 
                            ? `⚠️ <b>STOP LOSS POST-PARCIAL (BREAKEVEN) | ${ticker} | ${trade.direction}</b>\n\n` +
                              `📥 Entrada: ${trade.entryPrice}\n` +
                              `🎯 TP1 Parcial: Tomado al ${trade.tp1Price}\n` +
                              `🛑 SL Alcanzado: ${trade.slPrice}\n` +
                              `📊 PnL Final: ${finalPnlPct > 0 ? '+' : ''}${finalPnlPct.toFixed(2)}%\n` +
                              `⏱️ Duración total: ${durationMin} min`
                            : `🔴 <b>STOP LOSS (LOSS) | ${ticker} | ${trade.direction}</b>\n\n` +
                              `🕒 Apertura: ${openTimeStr}\n` +
                              `📥 Entrada: ${trade.entryPrice}\n` +
                              `🛑 SL Alcanzado: ${trade.slPrice} ❌\n` +
                              `📊 PnL: ${finalPnlPct.toFixed(2)}%\n` +
                              `⏱️ Duración: ${durationMin} min\n\n` +
                              `${protectionMsg ? protectionMsg + '\n\n' : ''}` +
                              `📈 Racha actual: ${consecutiveLosses} pérdida(s) consecutiva(s)`;

                        if (!isBacktest) sendTelegramAlert(slMsg).catch(() => {});
                        console.log(`[JOURNAL] ${isPartialClose ? '⚠️ SL Post-Parcial (BREAKEVEN)' : '🔴 SL alcanzado (LOSS)'}: ${ticker} #${tradeId}`);
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
                    const originMatch = alertText.match(/ORIGIN:\s*([0-9.,]+)/i);
                    const priceMatchChoch = alertText.match(/Precio:\s*([0-9.,]+)/i);
                    const actualPrice = priceMatchChoch ? parseTVPrice(priceMatchChoch[1]) : state.lastPrice;

                    if (originMatch && actualPrice) {
                        const newOrigin = parseTVPrice(originMatch[1]);
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
                                console.log(`[FIBO] ⚠️ ${prefix} ${currentDirection} ignorado en ${ticker}: leg anterior tiene ${Math.round((nowMs - activeLeg.createdAt) / 1000)}s (cooldown 3 min)`);
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
                } else if (eventTf === '15' || eventTf === '60' || eventTf === '240') {
                    const originMatch = alertText.match(/ORIGIN:\s*([0-9.,]+)/i);
                    const priceMatchChoch = alertText.match(/Precio:\s*([0-9.,]+)/i);
                    const actualPrice = priceMatchChoch ? parseTVPrice(priceMatchChoch[1]) : state.lastPrice;

                    if (originMatch && actualPrice) {
                        const newOrigin = parseTVPrice(originMatch[1]);
                        const isBuy = currentDirection === 'BUY';
                        
                        const newLeg: ImpulseLeg = {
                            dir: currentDirection as 'BUY' | 'SELL',
                            origin: newOrigin,
                            extreme: actualPrice,
                            createdAt: nowMs,
                            oteScored: false
                        };
                        
                        if (isBuy) state.activeMacroImpulseBuy = newLeg;
                        else state.activeMacroImpulseSell = newLeg;
                        console.log(`[FIBO-MACRO] 🗺️ Creado nuevo ImpulseLeg MACRO (${eventTf}M) ${currentDirection} en ${ticker}: origin=${newOrigin}, extreme=${actualPrice}`);
                    }
                }
                // 🆕 HÍBRIDO: Ponderar score por TF
                const basePoints = prefix === 'EVENTO_CHOCH' ? 3 : 1;
                addedPoints = basePoints * (TF_WEIGHT[eventTf] || 1); 
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
                // 🔧 FIX: Limpiar las zonas CONTRARIAS rotas del mapa de zonas en RAM
                // ZONE_BROKEN dir=BUY → presión alcista rompió zonas SELL (soportes/supply)
                // ZONE_BROKEN dir=SELL → presión bajista rompió zonas BUY (demanda/demand)
                state.zones = state.zones.filter(z => {
                    if (z.tf !== eventTf) return true;
                    if (currentDirection === 'BUY' && z.dir === 'BUY') return true;   // Mantener zonas BUY (no afectadas)
                    if (currentDirection === 'SELL' && z.dir === 'SELL') return true;  // Mantener zonas SELL (no afectadas)
                    return false; // zona contraria = la que fue rota por la presión, eliminarla
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
                    const basePoints = upperText.includes('ABSORCION') ? 6 : 3;
                    addedPoints = basePoints * (TF_WEIGHT[eventTf] || 1);
                    activeScore.events.push(upperText.includes('ABSORCION') ? `🩸_V-Shape_Absorb_${readableTf}` : `Sweep_${readableTf}`);
                }
            }
            else if (prefix === 'EVENTO_SMC_DIV') {
                if (!activeScore.events.includes(`DIV_${readableTf}`)) { addedPoints = 2; activeScore.events.push(`DIV_${readableTf}`); }
            }
            // NOTA: EVENTO_BOS ya se procesa en el bloque principal (líneas 1271-1360)
            // El bias y los puntos se asignan allí. Este bloque era redundante.
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
                    const basePoints = zoneScore >= 9 ? 5 : zoneScore >= 7 ? 4 : zoneScore >= 5 ? 3 : 2;
                    addedPoints = basePoints * (TF_WEIGHT[eventTf] || 1);
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
            // FIX: Handler ZONE_TOUCHED duplicado eliminado (ya se procesa en línea 1437)

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
                            pendingLeg.chochEvents = [...activeScore.events, `CHoCH_${readableTf}`];
                            console.log(`[RADAR] ✅ Leg ${currentDirection} en ${ticker} VALIDADO tardíamente con confluencia: ${addedPoints} pts de ${prefix}`);
                        }
                    }
                }
            }

            // --- CAPA 4: VALIDACIÓN DEL CHOCH / BOS ---
            // 🆕 v5.5 HÍBRIDO: Permitir que 15M (o 5M) actúe como gatillo principal en lugar de solo 3M
            if ((prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') && (eventTf === '3' || eventTf === '5' || eventTf === '15')) { 
                const triggerType = prefix === 'EVENTO_CHOCH' ? 'CHoCH🚀' : 'BOS🔨';
                
                // 🧹 1. FIX DE MEMORIA FANTASMA (Cooldown)
                // Durante el cooldown, NO reseteamos el score — se acumula para el siguiente CHoCH.
                const config = getConfigForTicker(ticker);
                if (nowMs - (state.lastSniperAlert ?? 0) < config.sniperCooldownMs) {
                    console.log(`[RADAR] ${triggerType} ignorado por Cooldown en ${ticker} (score preservado: ${activeScore.points} pts).`);
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
                let macroOteBonus = 0;
                const activeMacroLeg = currentDirection === 'BUY' ? state.activeMacroImpulseBuy : state.activeMacroImpulseSell;
                if (activeMacroLeg && isInsideMacroOteZone(activeMacroLeg, chExtreme ?? state.lastPrice ?? 0)) {
                    macroOteBonus = 6; // +6 Puntos de confluencia por OTE macro activa
                }

                let totalPoints = activeScore.points + baseBiasPoints + 2 + vwapBonus + macroOteBonus;
                if (macroOteBonus > 0) {
                    activeScore.events.push('Macro_OTE_Confluence');
                }
                let orphanPenalty = 0;
                let rawPenalty = 0;

                // 🛡️ 3. BONO ESPACIAL + PENALIZACIONES
                // El bono espacial reemplaza la penalización cuando hay respaldo por mapa
                if (hasSpatialBacking && spatialBonus > 0) {
                    totalPoints += spatialBonus; // +5 a +10 pts según TF
                    orphanPenalty = 0; // sin penalización porque el mapa respalda
                } else {
                    // 🔧 FIX: Penalización por CHoCH huérfano (sin zonas en memoria).
                    // Crypto (BTC/ETH): -1 pt (mercado 24/7, CHoCHs más frecuentes, zonas más volátiles)
                    // Forex/Índices: -3 pts (sesiones definidas, zonas más estables)
                    // PERO: si el puntaje bruto sin penalizar ya es ≥12, la penalización se ANULA.
                    const isCrypto = ticker.includes('BTC') || ticker.includes('ETH');
                    rawPenalty = !hasHTFBacking ? (isCrypto ? 1 : 3) : 0;
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
                confluenceReport += `${getIcon(eventTf)} Gatillo ${readableTf}: ${currentDirection} (${triggerType})\n\n`; 
                confluenceReport += `⚖️ <b>Bono de Alineación Macro:</b> +${baseBiasPoints} Pts\n`;
                if (macroOteBonus > 0 && activeMacroLeg) {
                    confluenceReport += `🎯 <b>Confluencia OTE Fractal:</b> +${macroOteBonus} Pts (Precio en OTE Macro [Origin: ${activeMacroLeg.origin.toFixed(5)} | Extreme: ${activeMacroLeg.extreme.toFixed(5)}])\n`;
                }
                if (hasSpatialBacking) {
                    const tfLabel = spatialMaxWeight >= 2.0 ? '4H' : spatialMaxWeight >= 1.5 ? '1H' : '15M';
                    confluenceReport += `🗺️ <b>Respaldo Espacial:</b> +${spatialBonus} pts (zona ${tfLabel}, peso ×${spatialMaxWeight})\n`;
                    if (caseA_OriginInZone) confluenceReport += `   📍 Caso A: Origen dentro de zona macro\n`;
                    if (caseB_PathTouchedZone && !caseA_OriginInZone) confluenceReport += `   🛤️ Caso B: Vela CHoCH tocó zona en su camino\n`;
                }
                if (caseC_TrapZone > 0) confluenceReport += `⚠️ <b>Alerta Trampa:</b> ${caseC_TrapZone} zona(s) contraria(s) detectada(s) (-${trapPenalty} pts)\n`;
                // 🔧 FIX: Usar rawPenalty para detectar bypass (orphanPenalty ya es 0 si fue anulado)
                if (rawPenalty > 0 && orphanPenalty === 0) {
                    // High-score bypass: la penalización se anuló por puntaje alto
                    confluenceReport += `⚡ <b>BYPASS PUNTAJE ALTO:</b> Penalización de -${rawPenalty} pts ANULADA (${totalPoints} pts brutos ≥ 12). Entrada validada sin zonas macro.\n`;
                } else if (orphanPenalty > 0) {
                    confluenceReport += `⚠️ <b>Penalización CHoCH sin zonas macro:</b> -${orphanPenalty} Pts (las zonas HTF aún no sincronizaron o expiraron)\n`;
                }
                if (!hasSpatialBacking && !hasSequentialBacking && orphanPenalty === 0) confluenceReport += `ℹ️ <b>Sin respaldo de zonas:</b> se permite por bono macro suficiente\n`;
                // 🎯 5. VALIDACIÓN FINAL Y GATILLO
                let sessionThresholds: { buy: number; sell: number } | null = null;
                if (isBacktest) {
                    const { getCurrentSessionThresholds } = await import('../services/backtesting.js');
                    sessionThresholds = getCurrentSessionThresholds();
                }

                if (!config.sessionEnabled) {
                    console.log(`[RADAR] 🚫 Trading desactivado para ${ticker} en esta sesión`);
                    return;
                }

                const currentSession = getCurrentSession();
                const sessionConfig = config.sessions?.[currentSession];

                let triggerEnabled = false;
                let minPtsRequired = currentDirection === 'BUY' 
                    ? (sessionThresholds?.buy || config.minPointsForBuy) 
                    : (sessionThresholds?.sell || config.minPointsForSell);

                if (sessionConfig) {
                    if (triggerType === 'CHoCH🚀') {
                        triggerEnabled = sessionConfig.choch?.enabled ?? false;
                        minPtsRequired = sessionConfig.choch?.minScore ?? 8;
                    } else if (triggerType === 'BOS🔨') {
                        triggerEnabled = sessionConfig.bos?.enabled ?? false;
                        minPtsRequired = sessionConfig.bos?.minScore ?? 8;
                    }
                } else {
                    triggerEnabled = (config.entryTrigger === 'CHOCH' || config.entryTrigger === 'BOTH');
                }
                
                const isCrypto = ticker.includes('BTC') || ticker.includes('ETH');
                if (isCrypto) minPtsRequired = Math.max(minPtsRequired - 1, 3); // Crypto: 1 punto menos
                
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
                        activeLeg.chochEvents = [...activeScore.events, `${triggerType}_${readableTf}`];
                        activeLeg.chochReport = confluenceReport;
                        activeLeg.bestZone = bestZone;

                        if (efectiveValidation && triggerEnabled && totalPoints >= minPtsRequired) {
                            const decimals = getDecimals(ticker);
                            const slBufferAmt = calculateDynamicSlBuffer(ticker, activeLeg.origin, 0); // SL Buffer ONLY for OTE
                            const adjustedSL = currentDirection === 'BUY' ? activeLeg.origin - slBufferAmt : activeLeg.origin + slBufferAmt;
                            const stopLoss = adjustedSL.toFixed(decimals);
                            const currentPrice = state.lastPrice ?? activeLeg.extreme;
                            const riskDist = Math.abs(currentPrice - adjustedSL);
                            const fixedTP1 = currentDirection === 'BUY'
                                ? currentPrice + riskDist
                                : currentPrice - riskDist;
                            const tp1 = fixedTP1.toFixed(decimals);
                            const fixedTP2 = currentDirection === 'BUY'
                                ? currentPrice + (riskDist * config.fixedRR)
                                : currentPrice - (riskDist * config.fixedRR);
                            const tp2 = fixedTP2.toFixed(decimals);
                            const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();
                            
                            oteData = {
                                tradeId, direction: currentDirection,
                                dirText: currentDirection === 'BUY' ? 'COMPRA' : 'VENTA',
                                stopLoss, tp1, tp2, entryPrice: currentPrice,
                                points: totalPoints, events: [...activeScore.events, `${triggerType}_${readableTf}`],
                                confluenceReport: confluenceReport || '',
                                bestZone, marketBias: { ...state.marketBias },
                                isChochEntry: true
                            };
                            let takeChoch = false;
                            let disableOte = false;
                            let smartReport = '';

                            const oteSessionEnabled = sessionConfig 
                              ? (triggerType === 'CHoCH🚀' ? (sessionConfig.oteChoch?.enabled ?? false) : (sessionConfig.oteBos?.enabled ?? false))
                              : (config.entryTrigger === 'OTE' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');

                            if (config.entryTrigger === 'SMART') {
                                const oppositeZones = state.zones.filter(z => z.dir !== currentDirection);
                                let closestZonePrice = currentDirection === 'BUY' ? Infinity : 0;
                                for (const z of oppositeZones) {
                                    if (currentDirection === 'BUY' && z.btm > currentPrice && z.btm < closestZonePrice) closestZonePrice = z.btm;
                                    else if (currentDirection === 'SELL' && z.top < currentPrice && z.top > closestZonePrice) closestZonePrice = z.top;
                                }
                                
                                let rrChoch = 3.0; // Default optimista
                                if (closestZonePrice !== Infinity && closestZonePrice !== 0) {
                                    const rewardDist = Math.abs(closestZonePrice - currentPrice);
                                    rrChoch = riskDist > 0 ? rewardDist / riskDist : 3.0;
                                }
                            
                                if (rrChoch >= 1.5) {
                                    smartReport = `\n🧠 <b>Modo SMART:</b> RR Estimado ${rrChoch.toFixed(1)}x. Se toma el CHoCH directo (OTE desactivado).`;
                                    takeChoch = true;
                                    disableOte = true;
                                } else {
                                    smartReport = `\n🧠 <b>Modo SMART:</b> RR Estimado ${rrChoch.toFixed(1)}x. Riesgo alto para CHoCH, esperando pullback a OTE.`;
                                    takeChoch = false;
                                    disableOte = false;
                                }
                            } else if (config.entryTrigger === 'OTE') {
                                takeChoch = false;
                                disableOte = false;
                            } else if (config.entryTrigger === 'BOTH') {
                                takeChoch = true;
                                disableOte = !oteSessionEnabled;
                            } else {
                                // CHOCH Only
                                takeChoch = true;
                                disableOte = true;
                            }

                            if (!takeChoch) {
                                triggerOte = false; // Bloqueamos la ejecución inmediata de este trade
                                console.log(`[RADAR] 🧠 Modo SMART/OTE: Gatillo inicial omitido para ${ticker}. Esperando retroceso OTE.`);
                            } else {
                                if (smartReport) oteData.confluenceReport += smartReport;
                                triggerOte = true;
                            }

                            if (disableOte) {
                                activeLeg.oteScored = true; // Al marcarlo puntuado, JARVIS ignorará futuros retrocesos
                            }
                        }
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

        // 🔧 FIX v5.4: 15M zones now live 6h (antes 2h) para cubrir el gap entre killzones
        // London 4-6 ART → NY 10:30-12:30 ART = 4.5h sin sync. Con 6h las zonas sobreviven.
        const MAX_ZONE_AGE_MS: Record<string, number> = { '3': 1800000, '15': 21600000, '60': 28800000, '240': 86400000 };
        state.zones = state.zones.filter(z => {
            if (!z.createdAt) return true; 
            return (nowMs - z.createdAt) < (MAX_ZONE_AGE_MS[z.tf || '60'] || 14400000);
        });

        // 💾 2. GUARDAR LOS CAMBIOS EN LA RAM LOCAL SIEMPRE
        localRadarStates.set(ticker, state);

        // 💾 3. GUARDAR EN FIREBASE (BACKUP INTELIGENTE CADA 5 MINUTOS O EN EVENTOS)
        const timeSinceLastSave = nowMs - (lastFirebaseSave.get(ticker) || 0);
        const FIREBASE_INTERVAL_MS = 5 * 60 * 1000; // 5 Minutos

        state.version = (state.version || 0) + 1;
        state.lastModified = nowMs;

        if (prefix !== 'PING_PRICE' || timeSinceLastSave > FIREBASE_INTERVAL_MS) {
            docRef.set(state, { merge: true }).catch((err: any) => console.error(`[FIREBASE] Error guardando estado ${ticker}: ${err.message}`));
            lastFirebaseSave.set(ticker, nowMs);
        }

        // =========================================================================
        // EJECUCIÓN OTE FUERA DE LA TRANSACCIÓN
        // =========================================================================
        if (triggerOte && oteData) {
            console.log(`[SNIPER] 🎯 triggerOte=true para ${ticker} ${oteData.direction}. Puntos: ${oteData.points}. Evaluando killswitches...`);
            
            state.lastGatillo = {
                dir: oteData.direction as 'BUY' | 'SELL',
                price: oteData.entryPrice,
                time: nowMs,
                type: 'OTE',
                status: 'EVALUANDO...'
            };
            
            state.version = (state.version || 0) + 1;
            state.lastModified = nowMs;
            docRef.set(state, { merge: true }).catch((err: any) => console.error(`[FIREBASE] Error guardando gatillo ${ticker}: ${err.message}`)); // Update status in UI immediately

            const config = getConfigForTicker(ticker);
            if (!config.sessionEnabled) {
                console.log(`[RADAR] 🚫 Trading desactivado para ${ticker} en esta sesión (OTE bloqueado)`);
                state.lastGatillo.status = 'BLOCKED_SESSION';
                docRef.set(state).catch(() => {});
                // Limpiar si se pre-creó en evaluateImpulse (para OTE)
                activeTrades.delete(oteData.tradeId);
                if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
                return;
            }

            const isGlobalKilled = await evaluateGlobalKillswitch(nowMs);
            if (isGlobalKilled) {
                console.log(`[GLOBAL KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por riesgo global consolidado de la cuenta.`);
                state.lastGatillo.status = 'BLOCKED_GLOBAL';
                docRef.set(state).catch(() => {});
                // Limpiar si se pre-creó en evaluateImpulse (para OTE)
                activeTrades.delete(oteData.tradeId);
                if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
                return;
            }

            if (nowMs < streakKillswitchUntil) {
                const remainingMin = Math.round((streakKillswitchUntil - nowMs) / 60000);
                console.log(`[KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por racha perdedora (${consecutiveLosses} pérdidas). Restan ${remainingMin} min de bloqueo.`);
                state.lastGatillo.status = 'BLOCKED_RACHA';
                docRef.set(state).catch(() => {});
                // Limpiar si se pre-creó en evaluateImpulse (para OTE)
                activeTrades.delete(oteData.tradeId);
                if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
                return;
            }
            if (nowMs < vixKillswitchUntil) {
                const remainingMin = Math.round((vixKillswitchUntil - nowMs) / 60000);
                console.log(`[KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por VIX>30. Restan ${remainingMin} min de bloqueo.`);
                state.lastGatillo.status = 'BLOCKED_VIX';
                docRef.set(state).catch(() => {});
                // Limpiar si se pre-creó en evaluateImpulse (para OTE)
                activeTrades.delete(oteData.tradeId);
                if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
                return;
            }

            let activeSessionId: string | undefined;
            if (isBacktest) {
                const { getCurrentSessionId } = await import('../services/backtesting.js');
                activeSessionId = getCurrentSessionId() || undefined;
            }

            // 🆕 v7.1: FILTRO DE OPERACIONES SELL POR ACTIVO (Anti-Short Bias)
            // Para activos con sesgo alcista (ej. NAS100), limita la cantidad de SELLs diarios
            // y/o exige un puntaje mínimo más alto para señales bajistas.
            if (oteData.direction === 'SELL') {
                const sellConfig = getConfigForTicker(ticker);

                // 🛑 Verificar pérdidas consecutivas (MCL) direccionales por sesión y activo
                const currentSession = getCurrentSession();
                const sessionConfig = sellConfig.sessions?.[currentSession];
                if (sessionConfig && sessionConfig.maxSellLosses !== undefined && sessionConfig.maxSellLosses > 0) {
                    const consecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'SELL', nowMs, isBacktest, activeSessionId);
                    if (consecutiveLosses >= sessionConfig.maxSellLosses) {
                        console.log(`[MCL LIMIT] ⛔ Setup ${ticker} SELL BLOQUEADO: ${consecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas en sesión ${currentSession}.`);
                        state.lastGatillo!.status = 'BLOCKED_MCL_LIMIT';
                        docRef.set(state).catch(() => {});
                        activeTrades.delete(oteData.tradeId);
                        if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});

                        sendTelegramAlert(
                            `🚨 <b>[MCL LIMIT]</b> ${ticker} SELL ignorado.\n\n` +
                            `📊 Se alcanzaron <b>${consecutiveLosses}/${sessionConfig.maxSellLosses}</b> pérdidas consecutivas de tipo SELL hoy en la sesión <b>${currentSession}</b>.\n` +
                            `💡 <i>Límite de pérdidas consecutivas (maxSellLosses) superado.</i>`
                        ).catch(() => {});
                        return;
                    }
                    console.log(`[MCL LIMIT] ✅ ${ticker} SELL permitido: ${consecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas de tipo SELL.`);
                }

                // 📊 Verificar límite diario de SELLs
                if (sellConfig.maxSellsPerDay > 0) {
                    const dailySells = await countDailySellsForTicker(ticker, nowMs, isBacktest, activeSessionId);
                    if (dailySells >= sellConfig.maxSellsPerDay) {
                        console.log(`[SELL LIMIT] ⛔ Setup ${ticker} SELL BLOQUEADO: ${dailySells}/${sellConfig.maxSellsPerDay} SELLs diarios alcanzados.`);
                        state.lastGatillo!.status = 'BLOCKED_SELL_LIMIT';
                        docRef.set(state).catch(() => {});
                        activeTrades.delete(oteData.tradeId);
                        if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});

                        sendTelegramAlert(
                            `⚠️ <b>[SELL LIMIT]</b> ${ticker} SELL ignorado.\n\n` +
                            `📊 Ya se ejecutaron <b>${dailySells}/${sellConfig.maxSellsPerDay}</b> operaciones SELL hoy en este activo.\n` +
                            `💡 <i>Configurá maxSellsPerDay en asset_configs para ajustar el límite.</i>`
                        ).catch(() => {});
                        return;
                    }
                    console.log(`[SELL LIMIT] ✅ ${ticker} SELL permitido: ${dailySells}/${sellConfig.maxSellsPerDay} SELLs usados hoy.`);
                }

            }

            // 🆕 v7.2: FILTRO DE OPERACIONES BUY (Anti-Long Bias)
            if (oteData.direction === 'BUY') {
                const buyConfig = getConfigForTicker(ticker);

                // 🛑 Verificar pérdidas consecutivas (MCL) direccionales por sesión y activo
                const currentSession = getCurrentSession();
                const sessionConfig = buyConfig.sessions?.[currentSession];
                if (sessionConfig && sessionConfig.maxBuyLosses !== undefined && sessionConfig.maxBuyLosses > 0) {
                    const consecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'BUY', nowMs, isBacktest, activeSessionId);
                    if (consecutiveLosses >= sessionConfig.maxBuyLosses) {
                        console.log(`[MCL LIMIT] ⛔ Setup ${ticker} BUY BLOQUEADO: ${consecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas en sesión ${currentSession}.`);
                        state.lastGatillo!.status = 'BLOCKED_MCL_LIMIT';
                        docRef.set(state).catch(() => {});
                        activeTrades.delete(oteData.tradeId);
                        if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});

                        sendTelegramAlert(
                            `🚨 <b>[MCL LIMIT]</b> ${ticker} BUY ignorado.\n\n` +
                            `📊 Se alcanzaron <b>${consecutiveLosses}/${sessionConfig.maxBuyLosses}</b> pérdidas consecutivas de tipo BUY hoy en la sesión <b>${currentSession}</b>.\n` +
                            `💡 <i>Límite de pérdidas consecutivas (maxBuyLosses) superado.</i>`
                        ).catch(() => {});
                        return;
                    }
                    console.log(`[MCL LIMIT] ✅ ${ticker} BUY permitido: ${consecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas de tipo BUY.`);
                }

                // 📊 Verificar límite diario de BUYs
                if (buyConfig.maxBuysPerDay > 0) {
                    const dailyBuys = await countDailyBuysForTicker(ticker, nowMs, isBacktest, activeSessionId);
                    if (dailyBuys >= buyConfig.maxBuysPerDay) {
                        console.log(`[BUY LIMIT] ⛔ Setup ${ticker} BUY BLOQUEADO: ${dailyBuys}/${buyConfig.maxBuysPerDay} BUYs diarios alcanzados.`);
                        state.lastGatillo!.status = 'BLOCKED_BUY_LIMIT';
                        docRef.set(state).catch(() => {});
                        activeTrades.delete(oteData.tradeId);
                        if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});

                        sendTelegramAlert(
                            `⚠️ <b>[BUY LIMIT]</b> ${ticker} BUY ignorado.\n\n` +
                            `📊 Ya se ejecutaron <b>${dailyBuys}/${buyConfig.maxBuysPerDay}</b> operaciones BUY hoy en este activo.\n` +
                            `💡 <i>Configurá maxBuysPerDay en asset_configs para ajustar el límite.</i>`
                        ).catch(() => {});
                        return;
                    }
                    console.log(`[BUY LIMIT] ✅ ${ticker} BUY permitido: ${dailyBuys}/${buyConfig.maxBuysPerDay} BUYs usados hoy.`);
                }

            }

            const fingerprint = `OTE_${ticker}_${oteData.direction}_${oteData.tp1}`;
            console.log(`[SNIPER] 🔍 Verificando duplicado: ${fingerprint}`);
            if (!isDuplicate(fingerprint, nowMs)) {
                
                state.lastGatillo.status = 'PROCESANDO...';
                docRef.set(state).catch(() => {});

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
                                signal: AbortSignal.timeout(8000) // ⚡ Reducido de 15s a 8s para scalping
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

                const isChoch = oteData.events?.some((e: string) => e.includes('CHoCH🚀'));
                const isBos = oteData.events?.some((e: string) => e.includes('BOS🔨'));
                const breakType = isChoch ? 'CHoCH' : isBos ? 'BOS' : 'SMC';
                const entryTypeLabel = oteData.isChochEntry 
                    ? (isBos ? 'BOS Directo' : 'CHoCH Directo') 
                    : `OTE (basado en ${breakType})`;

                let headerLabel = 'OTE';
                if (oteData.isChochEntry) {
                    headerLabel = isBos ? 'BOS DIRECTO' : 'CHOCH DIRECTO';
                } else {
                    headerLabel = `OTE (${breakType})`;
                }

                let msg = `${isBacktest ? "🧪 <b>BACKTESTING</b> | " : "🔥 "}<b>ALERTA FRANCOTIRADOR ${headerLabel} | ${ticker} | ${oteData.dirText}</b>\n\n`;
                msg += (oteData.confluenceReport || '').trim() + '\n\n';
                msg += `🎯 <b>Tipo de Entrada:</b> ${entryTypeLabel}\n`;
                msg += `🎯 <b>Puntaje Total:</b> ${oteData.points} Puntos\n`;
                msg += `🧱 <b>Confluencias:</b> ${oteData.events?.join(', ')}\n\n`;

                const config = getConfigForTicker(ticker);
                let avisoRiesgo = oteData.points >= 8
                    ? `Operar con riesgo estándar (${config.baseRiskPercentage}%).`
                    : `Setup de puntaje medio. Riesgo reducido (${config.baseRiskPercentage / 2}%).`;

                const jarvisNote = oteData.isChochEntry
                    ? `Gatillo de entrada directa por ${isBos ? 'BOS' : 'CHoCH'} confirmado. ${avisoRiesgo}`
                    : `Llegada a zona OTE confirmada. ${avisoRiesgo}`;
                msg += `🧠 <b>Jarvis:</b> ${jarvisNote}\n\n`;
                msg += `📐 <b>Niveles de Ejecución (GATILLO):</b>\n`;
                msg += `🎯 Precio de Entrada: ${oteData.entryPrice}\n`;
                msg += `🛑 Stop Loss Sugerido: ${oteData.stopLoss}\n`;
                msg += `💰 Take Profit 1 (Interno): ${oteData.tp1}\n`;
                msg += `🚀 Take Profit 2 (Externo): ${oteData.tp2}\n`;

                msg += kronosAnnotation;
                msg += swarmAnnotation;

                console.log(`[SNIPER] 📨 Mensaje FRANCOTIRADOR construido para ${ticker} (${msg.length} chars). isBacktest=${isBacktest}`);

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
                    isChochEntry: oteData.isChochEntry,
                    // 🧠 MACHINE LEARNING FEATURES (Fase 1)
                    hourOfDay: new Date(nowMs).getHours(),
                    dayOfWeek: new Date(nowMs).getDay(),
                    session: getCurrentSession(),
                    bias4H: state.marketBias['240'] === oteData.direction ? 'ALIGNED' : state.marketBias['240'] === 'NEUTRAL' ? 'NEUTRAL' : 'AGAINST',
                    bias1H: state.marketBias['60'] === oteData.direction ? 'ALIGNED' : state.marketBias['60'] === 'NEUTRAL' ? 'NEUTRAL' : 'AGAINST',
                    vwapDistance: (oteData.events.includes('VWAP_Premium') || oteData.events.includes('VWAP_Discount')) ? 1 : 0,
                }).catch(() => 'ERR');
                
                // 🧠 REGISTRO EN ACTIVE TRADES SI ES ENTRADA DIRECTA (isChochEntry: true)
                let activeTrade = activeTrades.get(oteData.tradeId);
                if (!activeTrade) {
                    activeTrade = {
                        tradeId: oteData.tradeId,
                        ticker,
                        direction: oteData.direction as 'BUY' | 'SELL',
                        entryPrice: oteData.entryPrice,
                        tp1Price: parseFloat(oteData.tp1),
                        tp2Price: oteData.tp2 && oteData.tp2 !== 'Buscando DOL macro...' ? parseFloat(oteData.tp2) : oteData.entryPrice * 1.5,
                        slPrice: parseFloat(oteData.stopLoss),
                        tp1Hit: false,
                        tp2Hit: false,
                        timestamp: nowMs
                    };
                    activeTrades.set(oteData.tradeId, activeTrade);
                    if (db) db.collection('active_trades').doc(oteData.tradeId).set(activeTrade).catch(() => {});
                    console.log(`[SNIPER] 💾 Registrado trade activo DIRECTO para ${ticker} #${oteData.tradeId}`);
                }

                if (journalId && journalId !== 'ERR' && journalId !== 'N/A') {
                    activeTrade.journalId = journalId;
                    // 💾 Actualizar el journalId en Firebase
                    if (db) db.collection('active_trades').doc(oteData.tradeId).update({ journalId }).catch(() => {});
                }

                // 🤖 cTrader: Send trade with confirmation buttons (semi-automatic mode)
                if (!isBacktest) {
                    try {
                        const { config: globalConfig } = await import('../config.js');
                        const { sendTradeConfirmation } = await import('../services/ctrader_confirmation.js');
                        const ctraderConfigured = !!(globalConfig.CTRADER_CLIENT_ID && globalConfig.CTRADER_ACCESS_TOKEN);
                        
                        if (ctraderConfigured) {
                            // Send alert WITH cTrader execution buttons
                            await sendTradeConfirmation({
                                tradeId: oteData.tradeId,
                                ticker,
                                direction: oteData.direction as 'BUY' | 'SELL',
                                dirText: oteData.dirText,
                                entryPrice: oteData.entryPrice,
                                slPrice: parseFloat(oteData.stopLoss),
                                tp1Price: parseFloat(oteData.tp1),
                                tp2Price: oteData.tp2 !== 'Buscando DOL macro...' ? parseFloat(oteData.tp2) : undefined,
                                points: oteData.points,
                                grade: oteData.points >= 8 ? 'A+' : 'B',
                                events: oteData.events || [],
                                confluenceReport: oteData.confluenceReport || '',
                                kronosVerdict: kronosVerdict,
                                swarmConsensus: swarmConsensus,
                                alertMessage: msg,
                                journalId: typeof journalId === 'string' ? journalId : undefined,
                                isChochEntry: oteData.isChochEntry,
                            });
                            console.log(`[SNIPER] ✅ Alerta FRANCOTIRADOR + botones cTrader enviada para ${ticker}`);
                        } else {
                            // cTrader not configured — send normal alert (original behavior)
                            await sendTelegramAlert(msg);
                            console.log(`[SNIPER] ✅ Alerta FRANCOTIRADOR enviada (sin cTrader) para ${ticker}`);
                        }
                    } catch (teleErr: any) {
                        // Fallback to normal alert if confirmation system fails
                        console.error(`[SNIPER] ⚠️ Error en sistema de confirmación, enviando alerta normal:`, teleErr.message);
                        try { await sendTelegramAlert(msg); } catch {}
                    }
                } else {
                    console.log(`[SNIPER] ⏭️ Modo backtest — alerta FRANCOTIRADOR NO enviada a Telegram`);
                }
                
                state.lastGatillo.status = 'ENVIADO';
                docRef.set(state).catch(() => {});
            } else {
                console.log(`[SNIPER] ⚠️ DUPLICADO bloqueado: ${fingerprint}`);
                state.lastGatillo.status = 'DUPLICADO';
                docRef.set(state).catch(() => {});
                
                // Limpiar si se pre-creó en evaluateImpulse (para OTE)
                activeTrades.delete(oteData.tradeId);
                if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
            }
        }

    } catch (e: any) {
        console.error(`[RADAR] Error crítico en memoria/Firebase:`, e.message);
    } finally {
        releaseLock!(); // 🛡️ v5.4: Liberar lock del ticker
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
            const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';
            if (!FINNHUB_API_KEY) { console.warn('[NEWS FILTER] FINNHUB_API_KEY no configurada. VIX check desactivado.'); return; }
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

    // 📊 v5.6: Resumen diario UNIFICADO — delega a journal.ts (sendDailyReview)
    // Mantiene solo la lógica de scheduling (18:00 ART, once-per-day guard)
    const scheduleDailySummary = () => {
        const now = new Date();
        const artNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
        const artHour = artNow.getHours();
        const artMin = artNow.getMinutes();
        
        // Disparar entre 18:00 y 18:05 ART
        if (artHour === 18 && artMin >= 0 && artMin < 5) {
            const today = artNow.toISOString().split('T')[0];
            const lastSummaryDate = (globalThis as any).__lastSummaryDate;
            if (lastSummaryDate === today) return;
            (globalThis as any).__lastSummaryDate = today;
            
            sendDailyReview()
                .then(() => console.log(`[DAILY] 📊 Resumen diario enviado via journal.ts`))
                .catch(e => console.error('[DAILY] Error generando resumen:', e));
        }
    };
    setInterval(scheduleDailySummary, 5 * 60 * 1000);
    scheduleDailySummary();

    setInterval(() => {
        const now = Date.now();
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        const TRADE_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 horas sin PINGs = cierre automático
        
        for (const [id, trade] of activeTrades) {
            const age = now - trade.timestamp;
            // 🛡️ Si no hay registros de pings para este ticker, usamos la hora de creación del trade
            // para evitar que se interprete como inactivo desde 1970 (inactividad = now)
            const lastSeen = tickerLastSeen.get(trade.ticker) || trade.timestamp;
            const inactivity = now - lastSeen;
            
            // Si tickerLastSeen está completamente vacío (post-reinicio), no cerrar el trade
            if (tickerLastSeen.size === 0) {
                continue; // No cerrar trades hasta que llegue el primer PING real
            }
            
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
                // 🛡️ v5.5: Ignorar timestamps "viejos" que vienen de Firebase post-reinicio
                // Si lastHeartbeat es 0 o menor que el timestamp de hace 2 horas, son datos inválidos
                const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
                const hbAge = (lastHb > 0 && lastHb > (now - 86400000)) ? (now - lastHb) : 0;
                const hbInactiveMin = Math.round(hbAge / 60000);
                
                // 🛡️ v5.5: Solo enviar alerta de desconexión si realmente está desconectado
                // (>2 horas sin heartbeat Y sin otros eventos en el mismo período)
                if (hbAge < TWO_HOURS_MS) continue; // Tiene heartbeat reciente, no está desconectado
                
                // 🛡️ v5.5.1: Solo alertar 1 vez por desconexión — no spamear
                tickerLastSeen.delete(ticker); // Lo borramos para que no vuelva a alertar
                console.warn(`[WATCHDOG] 🔌 ${ticker}: DESCONECTADO hace ${inactiveMin} min. Alerta Silenciosa.`);
            }
        }
    }, WATCHDOG_INTERVAL_MS);
}