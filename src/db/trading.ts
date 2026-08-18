import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config, config as envConfig } from '../config.js';
import { logTrade, recordResult, sendDailyReview } from '../services/journal.js';
import * as fs from 'fs';

import { z } from 'zod';
import { RadarZone, ImpulseLeg, RadarState, ActiveTrade, AssetSessionConfigSchema, GlobalPortfolioConfig, SessionSchema, extractMgmtOverrides } from '../engine/Types.js';

type SessionConfig = z.infer<typeof SessionSchema>;
import { StateStore, createStateStore } from '../engine/StateStore.js';

export const globalState = createStateStore();



import {
    emptyState, normalizeZone, TF_WEIGHT, evaluateImpulseCore, getDecimals, getMinPipDistance, calculateDynamicSlBuffer, evaluateMacroStretching, isInsideMacroOteZone,
    gcScore, addScoreEvent, computePoints, structuralInvalidate, refreshScoreCache, TF_RANK
} from '../engine/AlphaModel.js';

import { evaluateNetTrade } from '../engine/FrictionModel.js';
import { fetchLiveTimesfmDecision, resolveTimesfmConfig, appendTimesfmAudit, resolveTp2FromForecast, type TimesfmDecision } from '../engine/TimesfmFilter.js';

import { tickFlow } from '../engine/TickFlow.js';

import {
    evaluateGlobalRisk, evaluateAssetRisk, getFxDayStartMs, countDailySellsForTicker as pmCountDailySells, countDailyBuysForTicker as pmCountDailyBuys, countConsecutiveLossesForAsset
} from '../engine/PortfolioModel.js';

// 🏥 Export para healthcheck


// 🔄 v7.0: Firestore Write Buffers (Debouncing & Batching)
const dirtyStates = new Map<string, RadarState>();
let stateFlushTimeout: NodeJS.Timeout | null = null;

// 🆕 Radar v2: último veredicto TimesFM por ticker (para el dashboard, sin Firestore)
const lastTfmByTicker = new Map<string, { action: string; riskMult: number; degraded: boolean; dryRun: boolean; ts: number }>();

/** 🆕 Radar v2: estado operativo del bot por activo (killswitches, sesión, cooldown, posición, TimesFM) */
function buildBotStatus(ticker: string, s: any): any {
    const now = Date.now();
    const cfg: any = globalState.assetSessionConfigs.get(ticker);
    const ks: string[] = [];
    if (now < globalState.streakKillswitchUntil) ks.push('racha');
    if (now < globalState.vixKillswitchUntil) ks.push('VIX');
    if (now < globalState.globalPortfolioKillswitchUntil) ks.push('portfolio');
    const session = getCurrentSession(now);
    const sessionTriggers: any = (cfg?.sessions as any)?.[session] ?? (cfg?.sessions as any)?.['ALL'];
    const anyTriggerOn = Object.values(sessionTriggers ?? {}).some((t: any) => t?.enabled !== false);
    const sessionOff = session === 'OFF' || (sessionTriggers !== undefined && !anyTriggerOn);
    const sniperMs = (cfg as any)?.sniperCooldownMs ?? (globalState.dynamicBotConfig as any)?.sniperCooldownMs ?? 180000;
    const cooldown = now - (s.lastSniperAlert ?? 0) < sniperMs;
    let position: any = null;
    for (const t of globalState.activeTrades.values()) {
        if (t.ticker === ticker && !t.isBacktest) {
            const risk = Math.abs(t.entryPrice - t.slPrice) || 1;
            const pnlR = s.lastPrice != null
                ? (t.direction === 'BUY' ? (s.lastPrice - t.entryPrice) / risk : (t.entryPrice - s.lastPrice) / risk)
                : null;
            position = { direction: t.direction, pnlR: pnlR == null ? null : +pnlR.toFixed(2), managementMode: t.managementMode };
            break;
        }
    }
    const tfm = lastTfmByTicker.get(ticker);
    return {
        ks: ks.length ? ks : null,
        session,
        sessionOff,
        cooldown,
        enabled: cfg?.enabled !== false,
        position,
        tfm: tfm && now - tfm.ts < 15 * 60 * 1000 ? tfm : null,
    };
}

function scheduleStateSave(ticker: string, state: RadarState) {
    // 🔧 Reemplazo de Firebase: guardar radar states en archivo JSON local
    // Elimina ~777K escrituras/día de Firestore. La cuota se libera para journal + trades.
    dirtyStates.set(ticker, { ...state });
    if (!stateFlushTimeout) {
        stateFlushTimeout = setTimeout(() => {
            stateFlushTimeout = null;
            if (dirtyStates.size === 0) return;
            const toSave = new Map(dirtyStates);
            dirtyStates.clear();
            // Guardar a archivo JSON local + broadcast WebSocket al dashboard
            try {
                for (const [t, s] of toSave.entries()) {
                    // 🆕 Radar v2: adjuntar estado operativo del bot (killswitches, sesión, cooldown, posición, TimesFM)
                    const enriched = { ...s, botStatus: buildBotStatus(t, s) };
                    fs.writeFileSync(`radar_states_${t}.json`, JSON.stringify(enriched), 'utf8');
                }
                // Broadcast via WebSocket (ya existe en puerto 8081)
                import('../services/ws_server.js').then(({ broadcastRadarState }) => {
                    for (const [t, s] of toSave.entries()) {
                        broadcastRadarState(t, { ...s, botStatus: buildBotStatus(t, s) });
                    }
                }).catch(() => {});
            } catch (e: any) {
                // Silencioso — si falla el disco, no crashea el bot
            }
        }, 5000); // cada 5 segundos (antes era 1s a Firebase)
    }
}

let rawSignalsBuffer: any[] = [];
let signalFlushTimeout: NodeJS.Timeout | null = null;

function scheduleRawSignalSave(data: any) {
    return; // Disabled to save Firestore quota
    rawSignalsBuffer.push(data);
    if (!signalFlushTimeout) {
        signalFlushTimeout = setTimeout(() => {
            signalFlushTimeout = null;
            if (rawSignalsBuffer.length === 0) return;
            if (!db) return;

            // Limit to 490 per batch to avoid Firestore limits
            const chunks = [];
            while (rawSignalsBuffer.length > 0) {
                chunks.push(rawSignalsBuffer.splice(0, 490));
            }

            for (const chunk of chunks) {
                const batch = db.batch();
                for (const sig of chunk) {
                    const ref = db.collection('raw_signals').doc();
                    batch.set(ref, sig);
                }
                batch.commit().catch((e: any) => console.error('[FIREBASE] Error in signals batch commit:', e.message));
            }
        }, 2000);
    }
}

export const getActiveTradeCount = () => globalState.activeTrades.size;
export const getLastPingTime = () => globalState.lastPingTime;


// 🆕 v7.0: Consolidación de Cuenta & Portfolio Global







// Detecta la sesión actual basándose en hora de Argentina (UTC-3)

/**
 * 🆕 ROI Time-Decay: devuelve el profit mínimo requerido (%) según la antigüedad del trade.
 * 
 * @param tradeAgeMinutes minutos desde apertura
 * @param roiTable ej: {"0": 0.015, "30": 0.005, "60": 0}  // decimal: 0.015 = 1.5%
 * @returns [roiPercent, label] — si tradeAge ≥ threshold, devuelve el ROI correspondiente.
 *          Si no hay tabla o está vacía, devuelve [0, null] (sin efecto).
 */
function getEffectiveROI(tradeAgeMinutes: number, roiTable?: Record<string, number>): [number, string | null] {
    if (!roiTable || Object.keys(roiTable).length === 0) return [0, null];
    // Ordenar thresholds de mayor a menor (ej: ["60","30","0"])
    const thresholds = Object.keys(roiTable)
        .map(k => parseInt(k, 10))
        .sort((a, b) => b - a);
    for (const thresholdMin of thresholds) {
        if (tradeAgeMinutes >= thresholdMin) {
            const roi = roiTable[String(thresholdMin)];
            const label = roi === 0 ? 'breakeven' : `${thresholdMin}m_${(roi * 100).toFixed(1)}%`;
            return [roi, label];
        }
    }
    return [0, null];
}

function computeConfluenceTFs(zones: RadarZone[]): Map<RadarZone, string[]> {
    const byDir = new Map<string, RadarZone[]>();
    for (const z of zones) {
        const list = byDir.get(z.dir) ?? [];
        list.push(z);
        byDir.set(z.dir, list);
    }
    const result = new Map<RadarZone, string[]>();
    for (const group of byDir.values()) {
        for (const zone of group) {
            const tfs: string[] = [];
            for (const other of group) {
                if (other === zone || other.tf === zone.tf) continue;
                if (!(other.top < zone.btm || other.btm > zone.top) && !tfs.includes(other.tf || '')) {
                    tfs.push(other.tf || '');
                }
            }
            result.set(zone, tfs);
        }
    }
    return result;
}
function minutesSinceSessionOpen(ts: number): number {
    const d = new Date(ts - 3 * 3600 * 1000);
    const t = d.getUTCHours() * 60 + d.getUTCMinutes();
    const session = getCurrentSession(ts);
    const openMin = session === 'LONDON' ? 240 : session === 'NY' ? 630 : session === 'ASIA' ? 1260 : -1;
    if (openMin < 0) return Infinity;
    let m = t - openMin; if (m < 0) m += 1440;
    return m;
}

function getCurrentSession(nowMs?: number): 'LONDON' | 'NY' | 'ASIA' | 'OFF' {
    const now = nowMs ? new Date(nowMs) : new Date();

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
function getConfigForTicker(ticker: string, nowMs?: number): typeof globalState.dynamicBotConfig & {
    sessionEnabled: boolean;
    maxSellsPerDay: number;
    sellScorePenalty: number;
    maxBuysPerDay: number;
    buyScorePenalty: number;
    partialClosePct?: number;
    slAfterTp1?: 'midpoint' | 'breakeven' | 'none';
    tp15BeEnabled?: boolean;
    atrTrailEnabled?: boolean;
    structuralTrailEnabled?: boolean;
    tp1StructuralMinRR?: number;
    /** 🆕 ROI time-decay: {"0":0.015,"30":0.005,"60":0} */
    minimal_roi?: Record<string, number>;
    /** 🆕 Límites de riesgo por activo (asset_configs/{ticker}) */
    maxDailyLossR?: number;
    dailyProfitTargetR?: number;
    maxConsecutiveLosses?: number;
    maxTradesPerDay?: number;
    trailingDrawdownR?: number;
    /** 🏇 RIDER mode config */
    riderEnabled?: boolean;
    riderTf?: string;
    /** 🆕 TimesFM F1/F2: bloque de config del filtro (asset_configs/{ticker}.timesfm) */
    timesfm?: any;
    sessions?: Record<string, {
        choch5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
        choch15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
        bos5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
        bos15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
        oteChoch5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
        oteChoch15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
        oteBos5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
        oteBos15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
        // Legacy fallback keys
        choch?: { enabled: boolean; minScore: number };
        bos?: { enabled: boolean; minScore: number };
        oteChoch?: { enabled: boolean; minScore: number; entryPercent?: number };
        oteBos?: { enabled: boolean; minScore: number; entryPercent?: number };
        maxSellLosses?: number;
        maxBuyLosses?: number;
        slBufferPercent?: number;
        fixedRR?: number;
    }>;
} {
    const session = getCurrentSession(nowMs);

    // 💤 Si la sesión es OFF, ahora se ignora el bloqueo y se asume la configuración por defecto/ALL.

    // El nuevo AdminPanel guarda la configuración directamente bajo el ID del ticker (ej. NAS100)
    // y maneja las sesiones dentro del campo `sessions`.
    const config = globalState.assetSessionConfigs.get(ticker) || globalState.assetSessionConfigs.get(`${ticker}_${session}`) || globalState.assetSessionConfigs.get(`${ticker}_ALL`);

    if (config) {
        console.log(`[CONFIG] 📋 Usando config de: ${ticker}`);
        // 🆕 FIX: el panel exporta la sesión OFF como 'ALL' — fallback para horas fuera de sesión
        const sessionConfig = config.sessions ? ((config.sessions as any)[session] ?? (config.sessions as any)['ALL']) : undefined;
        return {
            ...globalState.dynamicBotConfig,
            minPointsForBuy: config.minPointsForBuy ?? globalState.dynamicBotConfig.minPointsForBuy,
            minPointsForSell: config.minPointsForSell ?? globalState.dynamicBotConfig.minPointsForSell,
            slBufferPercent: sessionConfig?.slBufferPercent ?? config.slBufferPercent ?? globalState.dynamicBotConfig.slBufferPercent,
            fixedRR: sessionConfig?.fixedRR ?? config.fixedRR ?? globalState.dynamicBotConfig.fixedRR,
            oteEntryPercent: config.oteEntryPercent ?? globalState.dynamicBotConfig.oteEntryPercent,
            entryTrigger: config.entryTrigger ?? globalState.dynamicBotConfig.entryTrigger,
            sessionEnabled: config.enabled ?? true,
            maxSellsPerDay: config.maxSellsPerDay ?? 0,
            sellScorePenalty: config.sellScorePenalty ?? 0,
            maxBuysPerDay: config.maxBuysPerDay ?? 0,
            buyScorePenalty: config.buyScorePenalty ?? 0,
            partialClosePct: config.partialClosePct,
            slAfterTp1: config.slAfterTp1,
            tp15BeEnabled: config.tp15BeEnabled,
            atrTrailEnabled: config.atrTrailEnabled,
            structuralTrailEnabled: config.structuralTrailEnabled,
            tp1StructuralMinRR: config.tp1StructuralMinRR,
            minimal_roi: config.minimal_roi as Record<string, number> | undefined,
            maxDailyLossR: (config as any).maxDailyLossR,
            dailyProfitTargetR: (config as any).dailyProfitTargetR,
            maxConsecutiveLosses: (config as any).maxConsecutiveLosses,
            maxTradesPerDay: (config as any).maxTradesPerDay,
            trailingDrawdownR: (config as any).trailingDrawdownR,
            riderEnabled: config.riderEnabled as boolean | undefined,
            riderTf: config.riderTf as string | undefined,
            timesfm: (config as any).timesfm, // 🆕 F1/F2: filtro direccional TimesFM (asset_configs/{ticker}.timesfm)
            sessions: config.sessions as any
        };
    }

    // Fallback
    return { ...globalState.dynamicBotConfig, sessionEnabled: true, maxSellsPerDay: 0, sellScorePenalty: 0, maxBuysPerDay: 0, buyScorePenalty: 0 };
}

// 🧠 INICIALIZACIÓN DE LA MEMORIA (Carga los trades de Firebase si el servidor se reinicia)
const unsubscribers: (() => void)[] = [];

if (db) {
    try {
        db.collection('active_trades').get().then((snap: any) => {
            snap.forEach((doc: any) => {
                globalState.activeTrades.set(doc.id, structuredClone(doc.data() as ActiveTrade));
            });
            console.log(`[RADAR] 🧠 Memoria restaurada: ${globalState.activeTrades.size} trades activos cargados.`);

            // 🏇 Inyectar SMCManager para consultas HTF (RIDER mode y otros usos futuros)
            import('../engine/smc/SMCManager.js').then(({ smcManager }) => {
                globalState.smcManager = smcManager;
                console.log('[RIDER] 🏇 SMCManager inyectado en StateStore — RIDER mode disponible.');
            }).catch(() => { /* SMCManager no disponible (modo solo Pine logs) */ });

            // 🧠 Inicializar ML Filter (carga modelo específico del ticker si existe)
            import('../engine/MLFilterNode.js').then(({ initMLFilter }) => {
                initMLFilter();
                console.log('[ML] 🧠 MLFilter inicializado.');
            }).catch(() => { /* MLFilter no disponible */ });
        });

        unsubscribers.push(db.collection('app_settings').doc('global').onSnapshot((snap: any) => {
            if (snap.exists) globalState.globalKillswitches = snap.data()?.killswitches || {};
        }));
        unsubscribers.push(db.collection('app_settings').doc('bot_config').onSnapshot((snap: any) => {
            if (snap.exists) {
                const data = snap.data() || {};
                globalState.dynamicBotConfig = {
                    sniperCooldownMs: Number.isFinite(Number(data.sniperCooldownMs)) ? Number(data.sniperCooldownMs) : globalState.dynamicBotConfig.sniperCooldownMs,
                    minPointsForBuy: Number.isFinite(Number(data.minPointsForBuy)) ? Number(data.minPointsForBuy) : globalState.dynamicBotConfig.minPointsForBuy,
                    minPointsForSell: Number.isFinite(Number(data.minPointsForSell)) ? Number(data.minPointsForSell) : globalState.dynamicBotConfig.minPointsForSell,
                    baseRiskPercentage: Number.isFinite(Number(data.baseRiskPercentage)) ? Number(data.baseRiskPercentage) : globalState.dynamicBotConfig.baseRiskPercentage,
                    slBufferPercent: data.slBufferPercent !== undefined ? Number(data.slBufferPercent) : globalState.dynamicBotConfig.slBufferPercent,
                    fixedRR: data.fixedRR !== undefined ? Number(data.fixedRR) : globalState.dynamicBotConfig.fixedRR,
                    oteEntryPercent: data.oteEntryPercent !== undefined ? Number(data.oteEntryPercent) : globalState.dynamicBotConfig.oteEntryPercent,
                    entryTrigger: data.entryTrigger || globalState.dynamicBotConfig.entryTrigger,
                    autoTrading: data.autoTrading !== undefined ? data.autoTrading : globalState.dynamicBotConfig.autoTrading,
                    maxSmartRiskPercent: data.maxSmartRiskPercent !== undefined ? Number(data.maxSmartRiskPercent) : globalState.dynamicBotConfig.maxSmartRiskPercent
                };
            }
        }));

        // 🆕 v6.0: Listener para configs por activo+sesión
        unsubscribers.push(db.collection('asset_configs').onSnapshot((snap: FirebaseFirestore.QuerySnapshot) => {
            snap.forEach(doc => {
                if (doc.id === 'GLOBAL') {
                    const data = doc.data() || {};
                    globalState.globalPortfolioConfig = {
                        maxDailyLossR: Number.isFinite(Number(data.maxDailyLossR)) ? Number(data.maxDailyLossR) : 0,
                        dailyProfitTargetR: Number.isFinite(Number(data.dailyProfitTargetR)) ? Number(data.dailyProfitTargetR) : 0,
                        maxTradesPerDay: Number.isFinite(Number(data.maxTradesPerDay)) ? Number(data.maxTradesPerDay) : 0,
                        maxConsecutiveLosses: Number.isFinite(Number(data.maxConsecutiveLosses)) ? Number(data.maxConsecutiveLosses) : 0,
                        trailingDrawdownR: Number.isFinite(Number(data.trailingDrawdownR)) ? Number(data.trailingDrawdownR) : 0,
                        enabled: data.enabled === true,
                        disabledSessions: Array.isArray(data.disabledSessions) ? data.disabledSessions : []
                    };
                    console.log('[CONFIG] 🧠 Configuración del Portfolio Global cargada:', globalState.globalPortfolioConfig);
                    return;
                }
                const parsed = AssetSessionConfigSchema.safeParse(doc.data());
                if (!parsed.success) {
                    console.warn(`[CONFIG] Invalid data in asset_configs for ${doc.id}:`, parsed.error.format());
                    return;
                }
                const data = parsed.data;
                globalState.assetSessionConfigs.set(doc.id, {
                    minPointsForBuy: data.minPointsForBuy || globalState.dynamicBotConfig.minPointsForBuy,
                    minPointsForSell: data.minPointsForSell || globalState.dynamicBotConfig.minPointsForSell,
                    slBufferPercent: data.slBufferPercent !== undefined ? data.slBufferPercent : globalState.dynamicBotConfig.slBufferPercent,
                    fixedRR: data.fixedRR !== undefined ? data.fixedRR : globalState.dynamicBotConfig.fixedRR,
                    oteEntryPercent: data.oteEntryPercent !== undefined ? data.oteEntryPercent : globalState.dynamicBotConfig.oteEntryPercent,
                    entryTrigger: data.entryTrigger || globalState.dynamicBotConfig.entryTrigger,
                    enabled: data.enabled !== false, // default enabled
                    maxSellsPerDay: data.maxSellsPerDay || 0,
                    sellScorePenalty: data.sellScorePenalty || 0,
                    maxBuysPerDay: data.maxBuysPerDay || 0,
                    buyScorePenalty: data.buyScorePenalty || 0,
                    partialClosePct: data.partialClosePct,
                    slAfterTp1: data.slAfterTp1,
                    tp15BeEnabled: data.tp15BeEnabled,
                    atrTrailEnabled: data.atrTrailEnabled,
                    structuralTrailEnabled: data.structuralTrailEnabled,
                    tp1StructuralMinRR: data.tp1StructuralMinRR,
                    // 🆕 FIX: campos que el panel exporta pero el listener descartaba
                    minimal_roi: data.minimal_roi,
                    maxDailyLossR: data.maxDailyLossR ?? 0,
                    dailyProfitTargetR: data.dailyProfitTargetR ?? 0,
                    maxConsecutiveLosses: data.maxConsecutiveLosses ?? 0,
                    maxTradesPerDay: data.maxTradesPerDay ?? 0,
                    trailingDrawdownR: data.trailingDrawdownR ?? 0,
                    sessions: data.sessions as any,
                    riderEnabled: data.riderEnabled,
                    riderTf: data.riderTf,
                    autoTrading: data.autoTrading,
                    maxSmartRiskPercent: data.maxSmartRiskPercent,
                    timesfm: (data as any).timesfm // 🆕 F1/F2: el schema es passthrough, pero el listener lo descartaba → el gate nunca veía el filtro
                });
            });
            const actualAssets = [...globalState.assetSessionConfigs.keys()].filter(k => k !== 'GLOBAL');
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



const DEDUP_WINDOW_MS = 60000;
const SYNC_THROTTLE_MS: Record<string, number> = { '5': 0, '15': 90000, '60': 240000, '240': 480000, 'D': 720000 };
// 🆕 FIX P0-4: subido de 10 a 20 min. Con el heartbeat del indicador ahora por tiempo,
// el feed más frecuente (PING/HEARTBEAT de 15m) llega cada ~15 min por cierre de vela;
// 10 min marcaba el ticker como inactivo entre vela y vela.
const HEARTBEAT_TIMEOUT_MS = 20 * 60 * 1000;

function isDuplicate(fingerprint: string, nowMs: number): boolean {
    for (const [key, ts] of globalState.recentAlertCache) {
        if (nowMs - ts > DEDUP_WINDOW_MS) globalState.recentAlertCache.delete(key);
    }
    if (globalState.recentAlertCache.has(fingerprint)) return true;
    globalState.recentAlertCache.set(fingerprint, nowMs);
    return false;
}

const parseTF = (tf: string) => {
    if (tf === 'D') return 'D';
    if (tf === '240') return '4H';
    if (tf === '60') return '1H';
    if (tf === '15') return '15M';
    if (tf === '5') return '5M';
    return `${tf}M`;
};

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



function evaluateImpulse(leg: ImpulseLeg | null | undefined, currentPrice: number, highPrice: number, lowPrice: number, ticker: string, state: RadarState, nowMs: number, store: StateStore = globalState, isBacktest: boolean = false) {
    const config = getConfigForTicker(ticker, nowMs);
    const currentSession = getCurrentSession(nowMs);
    const sessionConfig = config.sessions?.[currentSession];

    const decision = evaluateImpulseCore(leg, currentPrice, highPrice, lowPrice, ticker, state, nowMs, {
        config, currentSession, sessionConfig
    });

    if (decision.newTrade) {
        // 🔥 ESCUDO: Evaluar el trade contra el Modelo de Fricción (Prop Firm)
        const frictionEval = evaluateNetTrade(decision.newTrade, nowMs);

        if (!frictionEval.approved) {
            console.log(`[FRICTION] 🛡️ Trade RECHAZADO en ${ticker}: ${frictionEval.reason}`);
            // Cancelar el gatillo de OTE
            decision.triggerOte = false;
            decision.oteData = null;
        } else {
            const netTrade = frictionEval.netTrade;
            if (frictionEval.frictionCostDetails) {
                console.log(`[FRICTION] ✅ Trade Aprobado en ${ticker}. Detalles: ${frictionEval.frictionCostDetails}`);
            }

            // 💾 Sincronización en RAM y Firebase del trade modificado por fricción
            (netTrade as any).isBacktest = isBacktest;
            store.activeTrades.set(netTrade.tradeId, netTrade);
            if (db && !netTrade.isBacktest) db.collection('active_trades').doc(netTrade.tradeId).set(netTrade).catch(() => { });
        }
    }

    return { updatedLeg: decision.updatedLeg, triggerOte: decision.triggerOte, oteData: decision.oteData };
}

/**
 * Evalúa los límites del Killswitch Global de la Cuenta (Consolidación de Cuenta)
 * consultando los resultados cerrados del día de hoy en 'trade_journal'.
 * Retorna true si hay un bloqueo activo (cuenta deshabilitada temporalmente para operar hoy).
 */
async function evaluateGlobalKillswitch(nowMs: number, store: any, isBacktest: boolean = false): Promise<boolean> {
    if (isBacktest) return false;
    const currentSession = getCurrentSession(nowMs);
    const res = await evaluateGlobalRisk(nowMs, store.globalPortfolioConfig, store.globalPortfolioKillswitchUntil, currentSession, db);

    if (res.isKilled) {
        if (res.killUntilMs && res.killUntilMs > store.globalPortfolioKillswitchUntil) {
            store.globalPortfolioKillswitchUntil = res.killUntilMs;
            const timeStr = new Date(res.killUntilMs).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
            const warningMsg = `🚨 <b>[KILLSWITCH PORTAFOLIO GLOBAL]</b> 🚨\n\n` +
                `⚠️ <b>Cuenta Bloqueada Temporalmente</b>\n` +
                `📋 <b>Causa:</b> ${res.killReason}\n` +
                `⏳ <b>Duración:</b> Hasta el final del día de hoy (reseteo a medianoche ART - aprox ${timeStr})\n\n` +
                `💡 <i>Las alertas en vivo Sniper OTE se filtrarán automáticamente y no se enviarán a ejecución para proteger el balance de la cuenta consolidada.</i>`;

            sendTelegramAlert(warningMsg).catch(() => { });
            console.log(`[KILLSWITCH GLOBAL] ⛔ Cuenta bloqueada. Causa: ${res.killReason}`);
        }
        return true;
    }
    return false;
}

// 🆕 Throttle de notificaciones de killswitch por activo (1 aviso/hora por ticker)
const assetKillNotified = new Map<string, number>();

/**
 * 🆕 Killswitch POR ACTIVO: enforce de maxDailyLossR / dailyProfitTargetR / maxTradesPerDay /
 * maxConsecutiveLosses / trailingDrawdownR configurados en asset_configs/{ticker}.
 */
async function evaluateAssetKillswitch(ticker: string, nowMs: number, store: any, isBacktest: boolean = false): Promise<boolean> {
    if (isBacktest) return false;
    const cfg = getConfigForTicker(ticker, nowMs);
    const limits = {
        maxDailyLossR: cfg.maxDailyLossR,
        dailyProfitTargetR: cfg.dailyProfitTargetR,
        maxTradesPerDay: cfg.maxTradesPerDay,
        maxConsecutiveLosses: cfg.maxConsecutiveLosses,
        trailingDrawdownR: cfg.trailingDrawdownR,
    };
    const res = await evaluateAssetRisk(db, ticker, nowMs, limits, store.globalPortfolioConfig?.assumedWinR ?? 1.5);
    if (res.isKilled) {
        const lastNotif = assetKillNotified.get(ticker) ?? 0;
        if (nowMs - lastNotif > 60 * 60 * 1000) {
            assetKillNotified.set(ticker, nowMs);
            const msg = `🚨 <b>[KILLSWITCH ACTIVO: ${ticker}]</b> 🚨\n\n` +
                `⚠️ <b>Activo bloqueado hasta el fin del día (reseteo medianoche ART)</b>\n` +
                `📋 <b>Causa:</b> ${res.killReason}\n\n` +
                `💡 <i>Límite configurado en asset_configs/${ticker}. Las señales de este activo se ignorarán hoy.</i>`;
            sendTelegramAlert(msg).catch(() => { });
        }
        console.log(`[KILLSWITCH ${ticker}] ⛔ Activo bloqueado. Causa: ${res.killReason}`);
        return true;
    }
    return false;
}
async function countDailySellsForTicker(ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    return await pmCountDailySells(db, ticker, nowMs, isBacktest, backtestSessionId);
}

/**
 * 🆕 v7.2: Cuenta los trades BUY ejecutados hoy para un ticker específico.
 */
async function countDailyBuysForTicker(ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    return await pmCountDailyBuys(db, ticker, nowMs, isBacktest, backtestSessionId);
}

/**
 * Cuenta las pérdidas consecutivas de un activo en la sesión y dirección actual para el día de hoy.
 */
async function countConsecutiveLosses(ticker: string, session: string, direction: 'BUY' | 'SELL', nowMs: number, store: StateStore, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    return await countConsecutiveLossesForAsset(db, ticker, session, direction, nowMs, store.globalPortfolioConfig, isBacktest, backtestSessionId);
}

export async function processTradingAlert(alertText: string, store: StateStore = globalState) {
    if (!db) return;

    // 🔄 BOOTSTRAP: eventos históricos del arranque construyen estado (puntos, OTE, sesgos)
    // pero NO ejecutan trades, NO envían Telegram, NO loguean al journal.
    const isBootstrap = alertText.includes('| BOOTSTRAP');
    if (isBootstrap) alertText = alertText.replace(/\s*\|\s*BOOTSTRAP/g, '');

    const textUpToPayload = alertText.includes('Payload:') ? alertText.split('Payload:')[0] : alertText;
    const parts = textUpToPayload.split(/[,|]/).map(p => p.trim());

    if (parts.length < 2) return;

    const prefix = parts[0].toUpperCase();
    const ticker = parts[1].replace(/"/g, '');
    const upperText = alertText.toUpperCase();

    // 🛡️ v5.4: Lock por ticker — evita race conditions que causan alertas duplicadas
    // Al moverlo aquí arriba prevenimos el TOCTOU de ordenamiento en el backtester 
    // causado por el yield del event loop en el `await import`.
    const previousLock = store.tickerLocks.get(ticker) || Promise.resolve();
    let releaseLock: (() => void) | undefined;
    const newLock = new Promise<void>(resolve => { releaseLock = resolve; });
    store.tickerLocks.set(ticker, newLock);

    // 🧹 Limpieza: borrar el lock del mapa si no ha sido sobrescrito
    newLock.finally(() => {
        if (store.tickerLocks.get(ticker) === newLock) {
            store.tickerLocks.delete(ticker);
        }
    });

    await previousLock; // Esperar procesamiento anterior de este ticker

    // 🕒 El Bypass Temporal (Bar Replay Histórico)
    const tsMatch = alertText.match(/TS:\s*([0-9]+)/i);
    const nowMs = tsMatch ? parseInt(tsMatch[1], 10) : Date.now();

    // Intentar extraer TF del texto de la alerta (ej. 'TF: 5' o 'TF: 15')
    const tfMatchForTolerance = alertText.match(/TF:\s*([a-zA-Z0-9]+)/i);
    const rawTf = tfMatchForTolerance ? tfMatchForTolerance[1] : '';
    const parsedTf = rawTf ? parseTF(rawTf) : ''; // Ej: '5M', '15M', '1H', etc.

    let tfToleranceMs = 43200000; // 12 horas por defecto (evita falsos positivos de backtest en TFs altos si falta 'TF:')
    // Buscar coincidencia en la temporalidad parseada o en el prefix
    const tfStringToMatch = parsedTf || prefix;
    const tfPrefixMatch = tfStringToMatch.match(/(1M|3M|5M|15M|30M|1H|4H|D|1D|1W)/i);

    if (tfPrefixMatch) {
        const tf = tfPrefixMatch[1].toUpperCase();
        if (tf === '1M') tfToleranceMs = 1 * 60000 + 300000;
        else if (tf === '3M') tfToleranceMs = 3 * 60000 + 300000;
        else if (tf === '5M') tfToleranceMs = 5 * 60000 + 300000;
        else if (tf === '15M') tfToleranceMs = 15 * 60000 + 300000;
        else if (tf === '30M') tfToleranceMs = 30 * 60000 + 300000;
        else if (tf === '1H') tfToleranceMs = 60 * 60000 + 300000;
        else if (tf === '4H') tfToleranceMs = 240 * 60000 + 300000;
        else if (tf === '1D') tfToleranceMs = 1440 * 60000 + 300000;
        else if (tf === 'D') tfToleranceMs = 1440 * 60000 + 300000;
        else if (tf === '1W') tfToleranceMs = 10080 * 60000 + 300000;
    }

    const isBacktest = tsMatch !== null && Math.abs(Date.now() - nowMs) > tfToleranceMs;

    let sessionThresholds: { buy: number; sell: number } | null = null;
    if (isBacktest) {
        const { getCurrentSessionThresholds } = await import('../services/backtesting.js');
        sessionThresholds = getCurrentSessionThresholds();
    }

    // 🧠 FASE 1 - MACHINE LEARNING: Guardar la señal cruda para la Fase 2 (Auto-Tune)
    if (!isBacktest && !isBootstrap) { // Solo guardamos las señales reales en vivo
        scheduleRawSignalSave({
            timestamp: nowMs,
            alertText,
            createdAt: new Date(nowMs).toISOString()
        });
    }

    // 🤖 v6.0: Verificación de Apagado Maestro (Master Killswitch)
    if (store.globalKillswitches['GLOBAL_SYSTEM']) {
        if (ticker === 'BTCUSD' && !store.globalKillswitches['BTCUSD']) {
            console.log(`[RADAR] 🤖 Master Killswitch activo, pero permitiendo BTCUSD de forma excepcional.`);
        } else {
            console.log(`[RADAR] 🚫 Alerta para ${ticker} ignorada debido a que el BOT GLOBAL está APAGADO.`);
            return;
        }
    } else if (store.globalKillswitches[ticker]) {
        console.log(`[RADAR] 🚫 Alerta para ${ticker} ignorada por killswitch individual activo.`);
        return;
    }


    // 🔧 v5.5: SOLO tickers reales (no prefijos de eventos como HEARTBEAT, EVENTO_CHOCH...)
    // Los prefijos de eventos llegan porque TradingView usa el prefijo como "ticker" en algunas alertas.
    const FAKE_TICKERS = new Set(['HEARTBEAT', 'EVENTO_CHOCH', 'EVENTO_BOS', 'SWEEP_BROKEN',
        'DIV_BROKEN', 'EVENTO_SMC_DIV', 'EVENTO_SWEEP', 'EVENTO_SWEEP_TL',
        'EVENTO_SWEEP_SCALP', 'SYNC_ZONES', 'PING_PRICE', 'LIQ_GRAB']);
    if (!FAKE_TICKERS.has(ticker)) {
        store.tickerLastSeen.set(ticker, nowMs);
    }

    const tfMatch = alertText.match(/TF:\s*([a-zA-Z0-9]+)/i);
    const eventTf = tfMatch ? tfMatch[1] : 'UNKNOWN';
    const readableTf = parseTF(eventTf);

    let currentDirection: 'BUY' | 'SELL' | null = null;
    if (upperText.includes('BUY') || upperText.includes('BULLISH') || upperText.includes('COMPRA')) currentDirection = 'BUY';
    else if (upperText.includes('SELL') || upperText.includes('BEARISH') || upperText.includes('VENTA')) currentDirection = 'SELL';

    const isClimaxCandle = alertText.includes('Vol: CLIMAX');

    const safeSet = (data: any, options?: any) => {
        if (isBacktest || isBootstrap) return Promise.resolve();
        scheduleStateSave(ticker, data);
        return Promise.resolve();
    };
    // Anclar el día de trading al cierre de NY (17:00 New York, convención FX/prop-firm), DST-aware:
    const todayStr = new Date(getFxDayStartMs(nowMs)).toISOString().split('T')[0];

    let triggerOte = false;
    let oteData: any = null;
    let dispatchData: any = null;
    let state: any = null;

    try {
        // 🔥 Reemplazo completo de la Transacción por Memoria RAM Local 🔥
        triggerOte = false;
        oteData = null;

        // 1. LEER DE LA RAM (Ultra rápido y sin costo de base de datos)
        state = store.localRadarStates.get(ticker);

        // Si el servidor se reinició y la RAM está vacía, leer de archivo JSON local
        if (!state) {
            try {
                const filePath = `radar_states_${ticker}.json`;
                if (fs.existsSync(filePath)) {
                    state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                }
            } catch (e: any) { /* archivo no existe o corrupto */ }
            if (!state) state = emptyState();
            store.localRadarStates.set(ticker, state);
        }

        if (!state.scoreBuy) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
        if (!state.scoreSell) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };
        if (!state.marketBias) state.marketBias = emptyState().marketBias;

        // 🧹 GC por TTL por timeframe (sustituye al reset de 48h): caduca eventos viejos
        // y descarta entradas legacy inválidas (strings del formato antiguo en Firebase)
        gcScore(state.scoreBuy, nowMs);
        gcScore(state.scoreSell, nowMs);

        if (prefix === 'SYNC_ZONES') {
            if (!alertText.includes('Payload:')) return;
            const sourceTf = eventTf;

            const syncKey = `${ticker}_${sourceTf}`;
            const lastSync = store.lastSyncTime.get(syncKey) || 0;
            const throttleMs = SYNC_THROTTLE_MS[sourceTf] || 60000;
            if (nowMs - lastSync < throttleMs) {
                console.log(`[SYNC] ⏭️ SYNC_ZONES throttled para ${ticker} ${sourceTf} (último: hace ${Math.round((nowMs - lastSync) / 1000)}s, límite: ${throttleMs / 1000}s)`);
                return;
            }
            store.lastSyncTime.set(syncKey, nowMs);

            const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();
            const trendMatch = alertText.match(/Trend:\s*(BUY|SELL)/i);
            if (trendMatch) state.marketBias[sourceTf] = trendMatch[1].toUpperCase() as 'BUY' | 'SELL';

            try {
                const rawZones = JSON.parse(payloadStr) as any[];
                const parsedZones: RadarZone[] = rawZones.map(normalizeZone).filter(z => z.top !== undefined && z.btm !== undefined && z.dir !== undefined);
                parsedZones.forEach(z => { z.tf = sourceTf; z.createdAt = nowMs; });

                if (state.lastSyncDate !== todayStr) {
                    state.zones = [];
                    state.zoneConfluence = computeConfluenceTFs(state.zones);
                    state.activeLocks = [];
                    state.lastSyncDate = todayStr;
                }
                state.zones = state.zones.filter((z: any) => z.tf !== sourceTf);
                state.zones.push(...parsedZones);
                state.zoneConfluence = computeConfluenceTFs(state.zones);
            } catch (e) { }
        }
        else if (prefix === 'PING_PRICE') {
            const priceMatch = alertText.match(/Precio:\s*([0-9.,]+)/i);
            if (!priceMatch) return;

            const zUpMatch = alertText.match(/Z-Up:\s*(-?[\d.]+)/i);
            const zDnMatch = alertText.match(/Z-Dn:\s*(-?[\d.]+)/i);
            if (zUpMatch) state.zUp = parseFloat(zUpMatch[1]);
            if (zDnMatch) state.zDn = parseFloat(zDnMatch[1]);

            const currentPrice = parseTVPrice(priceMatch[1]);
            const highMatch = alertText.match(/High:\s*([0-9.,]+)/i);
            const lowMatch = alertText.match(/Low:\s*([0-9.,]+)/i);
            const highPrice = highMatch ? parseTVPrice(highMatch[1]) : currentPrice;
            const lowPrice = lowMatch ? parseTVPrice(lowMatch[1]) : currentPrice;

            // 🔧 FIX: Guardar precio anterior ANTES de actualizar para detectar dirección de entrada
            const previousPrice = state.lastPrice;

            const prevClose = previousPrice ?? currentPrice;
            const tr = Math.max(highPrice - lowPrice, Math.abs(highPrice - prevClose), Math.abs(lowPrice - prevClose));
            if (state.atr14 === undefined) {
                state.atrSeed = (state.atrSeed ?? 0) + tr;
                state.atrSamples = (state.atrSamples ?? 0) + 1;
                if (state.atrSamples >= 14) state.atr14 = state.atrSeed / 14; // SMA de arranque
            } else {
                state.atr14 = (state.atr14 * 13 + tr) / 14; // suavizado de Wilder
            }

            // Actualizar después de guardar la referencia
            state.lastPrice = currentPrice;
            store.lastPingTime = nowMs; // 🏥 Healthcheck
            // Guardar también el precio previo para referencia en el siguiente tick
            (state as any).previousPrice = previousPrice;

            // 🛡️ CRÍTICO: Verificar killswitches ANTES de evaluateImpulse() para evitar trades huérfanos
            const config = getConfigForTicker(ticker, nowMs);
            // 🌊 TickFlow: spread anómalo (noticia/iliquidez) bloquea evaluación de entradas
            const spreadAnomalous = tickFlow.isSpreadAnomalous(ticker);
            const isKillswitched = spreadAnomalous || nowMs < store.streakKillswitchUntil || nowMs < store.vixKillswitchUntil || !config.sessionEnabled;

            // 🧹 Clear stale lastGatillo (older than 24h) to avoid infinite TTL in the UI
            if (state.lastGatillo && nowMs - state.lastGatillo.time > 24 * 60 * 60 * 1000) {
                state.lastGatillo = undefined;
            }

            // ⚙️ Gestión de trades configurada por activo (asset_configs en Firestore).
            // Defaults = comportamiento histórico (parcial 50%, SL al 50% del riesgo, TP1.5 y trail ATR activos).

            if (!isKillswitched) {
                // 🗺️ Estirar patas Macro si están activas
                if (state.activeMacroImpulseBuy) {
                    state.activeMacroImpulseBuy = evaluateMacroStretching(state.activeMacroImpulseBuy, highPrice, lowPrice, nowMs);
                }
                if (state.activeMacroImpulseSell) {
                    state.activeMacroImpulseSell = evaluateMacroStretching(state.activeMacroImpulseSell, highPrice, lowPrice, nowMs);
                }

                const buyRes = evaluateImpulse(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, ticker, state, nowMs, store, isBacktest);
                state.activeImpulseBuy = buyRes.updatedLeg;
                if (buyRes.triggerOte) { triggerOte = true; oteData = buyRes.oteData; console.log(`[SNIPER] 🔫 evaluateImpulse BUY → triggerOte=true para ${ticker}`); }

                const sellRes = evaluateImpulse(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs, store, isBacktest);
                state.activeImpulseSell = sellRes.updatedLeg;
                if (sellRes.triggerOte) { triggerOte = true; oteData = sellRes.oteData; console.log(`[SNIPER] 🔫 evaluateImpulse SELL → triggerOte=true para ${ticker}`); }
            }

            // =========================================================
            // GESTIÓN DE TRADES ACTIVOS (TP Y SL)
            // =========================================================
            if (store.activeTrades.size > 0) {
                for (const [tradeId, trade] of store.activeTrades) {
                    if (trade.ticker !== ticker) continue;
                    if (!!(trade as any).isBacktest !== isBacktest) continue;
                    const nowTrade = nowMs;

                    // 🛡️ v5.4: Anti-instantáneo — no evaluar TP/SL si el trade se creó hace < 5s
                    // Evita que un trade se cierre en el mismo ciclo que se abrió (falsos TP1)
                    const tradeAgeMs = nowTrade - trade.timestamp;
                    if (tradeAgeMs < 5000) {
                        console.log(`[TRADE] ⏭️ ${ticker} #${tradeId}: omitiendo eval TP/SL (antigüedad ${tradeAgeMs}ms < 5s)`);
                        continue;
                    }

                    // 🆕 Overrides por gatillo (auto-tune): congelados en el trade al entrar; fallback a config raíz
                    const mgmtPartialT = Math.min(Math.max(trade.mgmtOverrides?.partialClosePct ?? config.partialClosePct ?? 0.5, 0), 1);
                    const mgmtSlModeT: 'midpoint' | 'breakeven' | 'none' = trade.mgmtOverrides?.slAfterTp1 ?? config.slAfterTp1 ?? 'midpoint';
                    const mgmtTp15T = trade.mgmtOverrides?.tp15BeEnabled ?? config.tp15BeEnabled ?? true;
                    const mgmtAtrTrailT = trade.mgmtOverrides?.atrTrailEnabled ?? config.atrTrailEnabled ?? true;

                    // 🆕 ROI TIME-DECAY: si el trade pierde momentum, bajar expectativa de ganancia
                    // según la tabla minimal_roi del activo/sesión. Inspirado en Freqtrade.
                    const roiTable = trade.mgmtOverrides?.minimal_roi ?? config.minimal_roi;
                    if (roiTable && Object.keys(roiTable).length > 0 && !trade.tp1Hit) {
                        const tradeAgeMin = tradeAgeMs / 60000;
                        const [effectiveROI, roiLabel] = getEffectiveROI(tradeAgeMin, roiTable);
                        if (effectiveROI > 0 && roiLabel) {
                            // ROI > 0: si el PnL flotante YA supera el umbral degradado, cerrar como WIN
                            const currentPnlPct = trade.direction === 'BUY'
                                ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100
                                : (trade.entryPrice - currentPrice) / trade.entryPrice * 100;
                            if (currentPnlPct >= effectiveROI * 100) {
                                if (isDuplicate(`ROI_${trade.tradeId}_${ticker}`, nowTrade)) continue;
                                store.activeTrades.delete(tradeId);
                                if (db && !trade.isBacktest) db.collection('active_trades').doc(tradeId).delete().catch(() => { });
                                trade.roiDecayApplied = roiLabel;
                                const durationMin = Math.round(tradeAgeMs / 60000);
                                const originalSl = trade.originalSlPrice ?? trade.slPrice;
                                const slDistPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
                                const rMultiple = slDistPct > 0 ? parseFloat((currentPnlPct / slDistPct).toFixed(4)) : 0;
                                if (trade.journalId) {
                                    const { db: fireDb } = await import('./memory.js');
                                    if (fireDb && !trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        result: 'WIN', pnl: parseFloat(currentPnlPct.toFixed(2)), rMultiple,
                                        durationMin, roiDecayApplied: roiLabel,
                                    }).catch(() => { });
                                }
                                const roiMsg = `⏱️ <b>ROI TIME-DECAY | ${ticker} | ${trade.direction}</b>\n\n`
                                    + `📥 Entrada: ${trade.entryPrice}\n`
                                    + `💰 PnL: +${currentPnlPct.toFixed(2)}% (umbral ROI: ≥${(effectiveROI).toFixed(2)}%)\n`
                                    + `⏱️ Duración: ${durationMin}min\n`
                                    + `🏷️ ROI aplicado: ${roiLabel}\n\n`
                                    + `💡 El trade alcanzó el objetivo degradado por tiempo.`;
                                if (!isBacktest) sendTelegramAlert(roiMsg).catch(() => { });
                                console.log(`[ROI] ⏱️ ${ticker} ${trade.direction} #${tradeId}: ROI exit (${roiLabel}) PnL=+${currentPnlPct.toFixed(2)}%`);
                                continue;
                            }
                        } else if (effectiveROI === 0 && !trade.roiDecayApplied) {
                            // ROI = 0 (breakeven): ajustar SL a precio de entrada para proteger el trade
                            trade.roiDecayApplied = 'breakeven';
                            if (isBacktest) {
                                trade.slPrice = trade.entryPrice;
                            } else {
                                trade.targetSlPrice = trade.entryPrice;
                                trade.targetSlPending = true;
                                trade.targetSlRetries = 0;
                                if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({
                                    slPrice: trade.entryPrice,
                                    targetSlPrice: trade.entryPrice,
                                    targetSlPending: true,
                                    roiDecayApplied: 'breakeven',
                                }).catch(() => { });
                            }
                            console.log(`[ROI] 🛡️ ${ticker} ${trade.direction} #${tradeId}: ROI breakeven → SL ajustado a entry ${trade.entryPrice}`);
                        }
                    }

                    // 🔄 REINTENTO DE MODIFICACIÓN DE SL (Si quedó pendiente de un tick anterior)
                    if (trade.targetSlPending && trade.targetSlPrice !== undefined && !isBacktest && trade.ctraderPositionId) {
                        trade.targetSlRetries = (trade.targetSlRetries || 0) + 1;
                        console.log(`[CTRADER] 🔄 Reintentando modificar SL a ${trade.targetSlPrice} (Intento ${trade.targetSlRetries}) para posID: ${trade.ctraderPositionId}`);
                        import('../services/ctrader.js').then(async (ctrader) => {
                            const success = await ctrader.modifyStopLoss(trade.ctraderPositionId!, trade.targetSlPrice!);
                            if (success) {
                                console.log(`[CTRADER] ✅ Éxito al modificar SL a ${trade.targetSlPrice} en reintento.`);
                                trade.slPrice = trade.targetSlPrice!;
                                trade.targetSlPending = false;
                                trade.targetSlRetries = 0;
                                if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({
                                    slPrice: trade.slPrice,
                                    targetSlPending: false
                                }).catch(() => { });
                            } else {
                                console.log(`[CTRADER] ⚠️ Fallo al modificar SL a ${trade.targetSlPrice} en reintento, se seguirá intentando.`);
                            }
                        }).catch(err => {
                            console.error(`[CTRADER] ❌ Error importando módulo para reintento de Breakeven: ${err.message}`);
                        });
                    }

                    const openTimeStr = new Date(trade.timestamp).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' });

                    // 🎯 EVALUACIÓN DE TP1
                    if (!trade.tp1Hit) {
                        const tp1Hit = trade.direction === 'BUY'
                            ? highPrice >= trade.tp1Price
                            : lowPrice <= trade.tp1Price;

                        if (tp1Hit) {
                            // 🛡️ FILTRO ANTI-DUPLICADOS
                            if (isDuplicate(`TP1_${trade.tradeId}_${ticker}`, nowTrade)) continue;

                            trade.tp1Hit = true;
                            trade.originalSlPrice = trade.slPrice;

                            // 🆕 RISK REDUCTION post-TP1: SL según mgmtSlModeT ('midpoint' | 'breakeven' | 'none')
                            const distanceToEntry = trade.entryPrice - trade.originalSlPrice;
                            let targetSl: number | null = null;
                            if (mgmtSlModeT === 'midpoint') {
                                targetSl = parseFloat((trade.originalSlPrice + (distanceToEntry * 0.5)).toFixed(5));
                            } else if (mgmtSlModeT === 'breakeven') {
                                targetSl = parseFloat(trade.entryPrice.toFixed(5));
                            }

                            if (targetSl !== null) {
                                if (isBacktest) {
                                    trade.slPrice = targetSl;
                                } else {
                                    trade.targetSlPrice = targetSl;
                                    trade.targetSlPending = true;
                                    trade.targetSlRetries = 0;
                                }
                            }

                            // 🏇 RIDER TRANSITION (EA31337): si la sesión tiene riderEnabled y SL→breakeven,
                            // transferir gestión del trade a la temporalidad superior para salida estructural.
                            const sessionCfg = (config.sessions?.[getCurrentSession(nowTrade)] ?? (config.sessions as any)?.['ALL']) as any;
                            const riderEnabled = sessionCfg?.riderEnabled ?? config.riderEnabled ?? false;
                            const riderTf = sessionCfg?.riderTf ?? config.riderTf ?? 'H1';
                            if (riderEnabled && mgmtSlModeT === 'breakeven' && !trade.managementMode) {
                                trade.managementMode = 'RIDER';
                                trade.riderTf = riderTf;
                                trade.tp2Price = 0; // deshabilitar TP2 fijo — la salida es estructural
                                console.log(`[RIDER] 🏇 ${ticker} ${trade.direction} #${tradeId}: transicionando a RIDER mode (${riderTf}). Salida por estructura HTF.`);
                            }

                            const durationSec = Math.round((nowTrade - trade.timestamp) / 1000);
                            const durationStr = durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`;

                            // 💾 Sincronizar actualización de TP1 (SL no cambia internamente hasta que el broker lo acepte en Real)
                            if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({
                                tp1Hit: true,
                                slPrice: trade.slPrice,
                                targetSlPrice: trade.targetSlPrice || null,
                                targetSlPending: trade.targetSlPending || false,
                                originalSlPrice: trade.originalSlPrice
                            }).catch(() => { });

                            if (trade.journalId) {
                                const { db: fireDb } = await import('./memory.js');
                                if (fireDb) {
                                    if (!trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        tp1Hit: true,
                                        tp1Timestamp: nowTrade,
                                        slPrice: trade.slPrice,
                                        originalSlPrice: trade.originalSlPrice,
                                        closedAt: nowTrade
                                    }).then(() => import('../engine/PortfolioModel.js').then(m => m.invalidateRiskCache())).catch(() => { });
                                }
                            }

                            const slModeText = mgmtSlModeT === 'breakeven' ? 'Breakeven' : mgmtSlModeT === 'none' ? 'Sin cambios' : 'Reducido 50%';
                            const tp1Msg = `🟡 <b>TP1 ALCANZADO | ${ticker} | ${trade.direction}</b>\n\n` +
                                `🕒 Apertura: ${openTimeStr}\n` +
                                `📥 Entrada: ${trade.entryPrice}\n` +
                                `🎯 TP1: ${trade.tp1Price} ✅\n` +
                                `🚀 TP2: ${trade.tp2Price > 0 ? trade.tp2Price : '—'}\n` +
                                `🛑 SL (${slModeText}): ${trade.slPrice}\n` +
                                `⏱️ Duración: ${durationStr}\n\n` +
                                (mgmtPartialT > 0
                                    ? `💡 Toma parcial ejecutada (${Math.round(mgmtPartialT * 100)}%). Stop Loss: ${slModeText}.`
                                    : `💡 Sin toma parcial (0%). La posición completa sigue abierta hacia TP2.`);
                            if (!isBacktest) sendTelegramAlert(tp1Msg).catch(() => { });
                            console.log(`[JOURNAL] 🟡 TP1 alcanzado: ${ticker} ${trade.direction} #${tradeId} — Parcial ${Math.round(mgmtPartialT * 100)}%, SL: ${slModeText}`);

                            // 🆕 EJECUCIÓN AUTOMÁTICA EN cTrader
                            if (!isBacktest && trade.ctraderPositionId) {
                                import('../services/ctrader.js').then(async (ctrader) => {
                                    console.log(`[CTRADER] 🔄 Ejecutando Risk Reduction Automático para posID: ${trade.ctraderPositionId}`);
                                    if (mgmtPartialT > 0) await ctrader.closePartial(trade.ctraderPositionId!, Math.round(mgmtPartialT * 100));
                                    if (targetSl === null) return; // slAfterTp1 'none': no tocar el SL
                                    const success = await ctrader.modifyStopLoss(trade.ctraderPositionId!, targetSl);
                                    if (success) {
                                        console.log(`[CTRADER] ✅ Éxito al modificar SL a ${trade.targetSlPrice}.`);
                                        trade.slPrice = trade.targetSlPrice!;
                                        trade.targetSlPending = false;
                                        if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({ slPrice: trade.slPrice, targetSlPending: false }).catch(() => { });
                                    } else {
                                        console.log(`[CTRADER] ⚠️ Fallo al modificar SL a ${trade.targetSlPrice}, se reintentará luego.`);
                                    }
                                }).catch(err => {
                                    console.error(`[CTRADER] ❌ Error importando módulo para Breakeven: ${err.message}`);
                                });
                            }
                        }
                    }

                    // 🏇 RIDER EXIT (EA31337): si el trade está en modo RIDER, la salida es estructural.
                    // Solo se cierra si el SMCEngine del HTF detecta un CHoCH inverso.
                    // El ATR trailing y SL check siguen activos como protección.
                    if (trade.managementMode === 'RIDER') {
                        const riderEngine = store.smcManager?.getEngine(ticker, trade.riderTf || 'H1');
                        if (riderEngine) {
                            const riderState = riderEngine.getState();
                            const lastChoch = riderState.lastCHoCH;
                            if (lastChoch) {
                                const inverseDir = trade.direction === 'BUY' ? 'Bearish' : 'Bullish';
                                if ((lastChoch as any).direction === inverseDir) {
                                    if (isDuplicate(`RIDER_${trade.tradeId}_${ticker}`, nowTrade)) continue;
                                    store.activeTrades.delete(tradeId);
                                    if (db && !trade.isBacktest) db.collection('active_trades').doc(tradeId).delete().catch(() => { });
                                    
                                    const currentPnlPct = trade.direction === 'BUY'
                                        ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100
                                        : (trade.entryPrice - currentPrice) / trade.entryPrice * 100;
                                    const originalSl = trade.originalSlPrice ?? trade.slPrice;
                                    const slDistPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
                                    const rMultiple = slDistPct > 0 ? parseFloat((currentPnlPct / slDistPct).toFixed(4)) : 0;
                                    const durationMin = Math.round(tradeAgeMs / 60000);
                                    
                                    if (trade.journalId) {
                                        const { db: fireDb } = await import('./memory.js');
                                        if (fireDb && !trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                            result: 'WIN', pnl: parseFloat(currentPnlPct.toFixed(2)), rMultiple,
                                            durationMin, managementMode: 'RIDER', riderTf: trade.riderTf,
                                        }).catch(() => { });
                                    }
                                    
                                    const riderMsg = `🏇 <b>RIDER EXIT | ${ticker} | ${trade.direction}</b>\n\n`
                                        + `📥 Entrada: ${trade.entryPrice}\n`
                                        + `💰 PnL: +${currentPnlPct.toFixed(2)}%\n`
                                        + `⏱️ Duración: ${durationMin}min\n`
                                        + `🔍 HTF (${trade.riderTf}): CHoCH ${inverseDir} detectado → salida estructural\n\n`
                                        + `💡 Trade cerrado por inversión de estructura en temporalidad superior.`;
                                    if (!isBacktest) sendTelegramAlert(riderMsg).catch(() => { });
                                    console.log(`[RIDER] 🏇 ${ticker} ${trade.direction} #${tradeId}: EXIT por CHoCH ${inverseDir} en ${trade.riderTf}. PnL=+${currentPnlPct.toFixed(2)}%`);
                                    continue;
                                }
                            }
                        }
                    }

                    // 🆕 GATILLO DE BREAKEVEN DIFERIDO (TP 1.5)
                    if (trade.tp1Hit && !trade.slHalfwayHit && mgmtTp15T) {
                        const riskDist = Math.abs(trade.tp1Price - trade.entryPrice);
                        const tp1_5Price = trade.direction === 'BUY' ? trade.tp1Price + (riskDist * 0.5) : trade.tp1Price - (riskDist * 0.5);

                        const beHit = trade.direction === 'BUY'
                            ? highPrice >= tp1_5Price
                            : lowPrice <= tp1_5Price;

                        if (beHit) {
                            if (isDuplicate(`BE_${trade.tradeId}_${ticker}`, nowTrade)) continue;

                            trade.slHalfwayHit = true;
                            if (isBacktest) {
                                trade.slPrice = trade.entryPrice;
                            } else {
                                trade.targetSlPrice = trade.entryPrice;
                                trade.targetSlPending = true;
                                trade.targetSlRetries = 0;
                            }

                            // Actualizar Firebase
                            if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({
                                slHalfwayHit: true,
                                slPrice: trade.slPrice,
                                targetSlPrice: trade.targetSlPrice || null,
                                targetSlPending: trade.targetSlPending || false
                            }).catch(() => { });

                            if (trade.journalId) {
                                const { db: fireDb } = await import('./memory.js');
                                if (fireDb) {
                                    if (!trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        slHalfwayHit: true,
                                        slPrice: trade.entryPrice,
                                        closedAt: nowTrade
                                    }).then(() => import('../engine/PortfolioModel.js').then(m => m.invalidateRiskCache())).catch(() => { });
                                }
                            }

                            const beMsg = `🛡️ <b>BREAKEVEN ACTIVADO | ${ticker} | ${trade.direction}</b>\n\n` +
                                `📈 El precio avanzó un 50% extra después del TP1.\n` +
                                `🛑 SL Ajustado a Precio de Entrada: ${trade.entryPrice}\n\n` +
                                `💡 Operación 100% libre de riesgo.`;

                            if (!isBacktest) sendTelegramAlert(beMsg).catch(() => { });
                            console.log(`[JOURNAL] 🛡️ Breakeven diferido activado: ${ticker} ${trade.direction} #${tradeId}`);

                            if (!isBacktest && trade.ctraderPositionId) {
                                import('../services/ctrader.js').then(async (ctrader) => {
                                    console.log(`[CTRADER] 🔄 Ejecutando Breakeven Definitivo para posID: ${trade.ctraderPositionId}`);
                                    const success = await ctrader.modifyStopLoss(trade.ctraderPositionId!, trade.targetSlPrice!);
                                    if (success) {
                                        console.log(`[CTRADER] ✅ Éxito al modificar SL a ${trade.targetSlPrice}.`);
                                        trade.slPrice = trade.targetSlPrice!;
                                        trade.targetSlPending = false;
                                        if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({ slPrice: trade.slPrice, targetSlPending: false }).catch(() => { });
                                    } else {
                                        console.log(`[CTRADER] ⚠️ Fallo al modificar SL a ${trade.targetSlPrice}, se reintentará luego.`);
                                    }
                                }).catch(() => { });
                            }
                        }
                    }

                    // Complemento PING: trailing continuo post-TP1 por distancia
                    if (trade.tp1Hit && mgmtAtrTrailT) {
                        const atrThreshold = (state.atr14 ?? 0) * 1.5;
                        const ratchetStep = (state.atr14 ?? 0) * 0.25;
                        if (trade.direction === 'BUY') {
                            const atrTrailSL = highPrice - atrThreshold;
                            if (atrTrailSL > trade.slPrice + ratchetStep) {
                                if (isBacktest) {
                                    trade.slPrice = atrTrailSL;
                                } else {
                                    trade.targetSlPrice = parseFloat(atrTrailSL.toFixed(5));
                                    trade.targetSlPending = true;
                                    trade.targetSlRetries = 0;
                                    if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({ targetSlPrice: trade.targetSlPrice, targetSlPending: true }).catch(() => { });
                                }
                            }
                        } else {
                            const atrTrailSL = lowPrice + atrThreshold;
                            if (atrTrailSL < trade.slPrice - ratchetStep) {
                                if (isBacktest) {
                                    trade.slPrice = atrTrailSL;
                                } else {
                                    trade.targetSlPrice = parseFloat(atrTrailSL.toFixed(5));
                                    trade.targetSlPending = true;
                                    trade.targetSlRetries = 0;
                                    if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({ targetSlPrice: trade.targetSlPrice, targetSlPending: true }).catch(() => { });
                                }
                            }
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
                            store.activeTrades.delete(tradeId);
                            if (db && !trade.isBacktest) db.collection('active_trades').doc(tradeId).delete().catch(() => { });

                            trade.tp2Hit = true;
                            const pnlTp1Pct = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
                            const pnlTp2Pct = Math.abs(trade.tp2Price - trade.entryPrice) / trade.entryPrice * 100;
                            const finalPnlPct = trade.tp1Hit ? (pnlTp1Pct * mgmtPartialT + pnlTp2Pct * (1 - mgmtPartialT)) : pnlTp2Pct;

                            const originalSl = trade.originalSlPrice ?? trade.slPrice;
                            const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
                            const rMultiple = initialSlLossPct > 0 ? parseFloat((finalPnlPct / initialSlLossPct).toFixed(4)) : 1.5;
                            const durationMin = Math.round((nowTrade - trade.timestamp) / 60000);

                            if (trade.journalId) {
                                const { db: fireDb } = await import('./memory.js');
                                if (fireDb) {
                                    if (!trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        tp2Hit: true,
                                        tp2Timestamp: nowTrade,
                                        result: 'WIN',
                                        pnl: parseFloat(finalPnlPct.toFixed(2)),
                                        rMultiple,
                                        durationMin,
                                    }).catch(() => { });
                                }
                            }
                            if (trade.journalId) {
                                if (!isBacktest) recordResult(trade.journalId, 'WIN', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            } else {
                                if (!isBacktest) recordResult(tradeId, 'WIN', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            }

                            store.consecutiveLosses = 0;

                            const tp2Msg = `🟢 <b>TP2 ALCANZADO (WIN) | ${ticker} | ${trade.direction}</b>\n\n` +
                                `🕒 Apertura: ${openTimeStr}\n` +
                                `📥 Entrada: ${trade.entryPrice}\n` +
                                `🎯 TP1: ${trade.tp1Price} ${trade.tp1Hit ? '✅' : '⏭️'}\n` +
                                `🚀 TP2: ${trade.tp2Price} ✅\n` +
                                `📊 PnL: +${finalPnlPct.toFixed(2)}%\n` +
                                `⏱️ Duración total: ${durationMin} min\n\n` +
                                `🏆 ¡Trade completo! ${store.consecutiveLosses > 0 ? `Racha protección: ${store.consecutiveLosses} pérdidas` : 'Racha limpia.'}`;
                            if (!isBacktest) sendTelegramAlert(tp2Msg).catch(() => { });
                            console.log(`[JOURNAL] 🟢 TP2 alcanzado (WIN): ${ticker} ${trade.direction} #${tradeId}`);
                            continue;
                        }
                    }

                    // 🛑 EVALUACIÓN DE STOP LOSS (O BREAK EVEN)
                    let slHit = false;
                    if (isBacktest) {
                        // Castigo de realidad: añadir spread simulado en el backtest
                        let spreadAdjustment = 0;
                        const upperTicker = ticker.toUpperCase();
                        if (upperTicker.includes('NAS100') || upperTicker.includes('TECH 100')) spreadAdjustment = 0.5; // 0.5 puntos
                        else if (upperTicker.includes('JPY')) spreadAdjustment = 0.005; // 0.5 pips
                        else if (upperTicker.includes('XAU')) spreadAdjustment = 0.1; // 10 centavos
                        else spreadAdjustment = 0.00005; // 0.5 pips standard para forex (EURUSD, GBPUSD)

                        slHit = trade.direction === 'BUY'
                            ? lowPrice <= (trade.slPrice + spreadAdjustment)
                            : highPrice >= (trade.slPrice - spreadAdjustment);
                    } else {
                        // 🔧 Usar currentPrice (bid) en vez de highPrice/lowPrice (inflados por spread).
                        // Un spike de ask puede disparar SL falsamente. El precio de ejecución real es el bid.
                        slHit = trade.direction === 'BUY'
                            ? currentPrice <= trade.slPrice
                            : currentPrice >= trade.slPrice;
                    }

                    if (slHit) {
                        // 🛡️ FILTRO ANTI-DUPLICADOS
                        if (isDuplicate(`CLOSE_${trade.tradeId}_${ticker}`, nowTrade)) continue;

                        // 💾 Eliminar de RAM inmediatamente de forma síncrona para evitar race conditions
                        store.activeTrades.delete(tradeId);
                        if (db && !trade.isBacktest) db.collection('active_trades').doc(tradeId).delete().catch(() => { });

                        const isPartialClose = trade.tp1Hit;
                        const originalSl = trade.originalSlPrice ?? trade.slPrice;
                        const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
                        const currentSlLossPct = Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100;
                        const pnlTp1Pct = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
                        const finalPnlPct = isPartialClose ? (pnlTp1Pct * mgmtPartialT - currentSlLossPct * (1 - mgmtPartialT)) : -currentSlLossPct;
                        const rMultiple = initialSlLossPct > 0 ? parseFloat((finalPnlPct / initialSlLossPct).toFixed(4)) : 0;
                        const finalResult = isPartialClose ? (finalPnlPct >= 0 ? 'BREAKEVEN' : 'LOSS') : 'LOSS';
                        const durationMin = Math.round((nowTrade - trade.timestamp) / 60000);

                        if (trade.journalId) {
                            const { db: fireDb } = await import('./memory.js');
                            if (fireDb) {
                                if (!trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                    slHit: true,
                                    slTimestamp: nowTrade,
                                    result: finalResult,
                                    pnl: parseFloat(finalPnlPct.toFixed(2)),
                                    rMultiple,
                                    durationMin,
                                }).catch(() => { });
                            }
                        }

                        // Si tomamos parciales, igual registramos la operación para no castigar
                        if (!isPartialClose) {
                            if (trade.journalId) {
                                if (!isBacktest) recordResult(trade.journalId, 'LOSS', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            } else {
                                if (!isBacktest) recordResult(tradeId, 'LOSS', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            }
                        } else {
                            if (trade.journalId) {
                                if (!isBacktest) recordResult(trade.journalId, 'BREAKEVEN', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            } else {
                                if (!isBacktest) recordResult(tradeId, 'BREAKEVEN', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            }
                        }

                        // Lógica de racha perdedora con banda neutra
                        const NET_BE_EPS = 0.05;
                        if (rMultiple < -NET_BE_EPS) {
                            store.consecutiveLosses++;
                            if (store.consecutiveLosses >= 5) store.streakKillswitchUntil = nowTrade + 30 * 60 * 1000;
                        } else if (rMultiple >= 0.8) {
                            store.consecutiveLosses = 0;
                        } else if (rMultiple > NET_BE_EPS) {
                            store.consecutiveLosses = Math.max(0, store.consecutiveLosses - 1);
                        }

                        const protectionMsg = store.consecutiveLosses >= 5
                            ? '🔴 ALERTA: 5 pérdidas consecutivas. KILLSWITCH ACTIVADO por 30 min.'
                            : store.consecutiveLosses === 4
                                ? '⚠️ 4 pérdidas consecutivas.'
                                : store.consecutiveLosses === 3
                                    ? '⚠️ 3 pérdidas consecutivas.'
                                    : store.consecutiveLosses === 2
                                        ? '⚠️ 2 pérdidas consecutivas.'
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
                            `📈 Racha actual: ${store.consecutiveLosses} pérdida(s) consecutiva(s)`;

                        if (!isBacktest) sendTelegramAlert(slMsg).catch(() => { });
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

                    if (addScoreEvent(activeScore, { id: eventName, pts, tf: zone.tf || eventTf, ts: nowMs })) {
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
                    const tfList = [...uniqueTFs].map(t => parseTF(t || '')).sort((a: any, b: any) => {
                        const order: Record<string, number> = { '5M': 0, '15M': 1, '1H': 2, '4H': 3, 'D': 4 };
                        return (order[b] || 0) - (order[a] || 0);
                    }).join('+');

                    const eventName = `🧲_CONFLUENCIA_${tfCount}TF_${tfList}`;
                    // TF del evento = el de mayor jerarquía entre las zonas en confluencia
                    const confTf = [...uniqueTFs].reduce((best, t) => (TF_RANK[t || ''] ?? 0) > (TF_RANK[best || ''] ?? 0) ? t : best, [...uniqueTFs][0] || eventTf);
                    addScoreEvent(activeScore, { id: eventName, pts: confluenceBonus, tf: confTf || eventTf, ts: nowMs });
                }
            }
        }
        else if (currentDirection) {
            const activeScore = currentDirection === 'BUY' ? state.scoreBuy : state.scoreSell;
            const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
            let addedPoints = 0;
            let addedEventId: string | null = null;

            if (prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') {
                // 🔍 DIAGNÓSTICO
                console.log(`[RADAR] 📡 ${prefix} ${currentDirection} ${ticker} TF=${eventTf} price=${state.lastPrice}`);
                state.marketBias[eventTf] = currentDirection;

                // 💥 Invalidación estructural acotada: el CHoCH/BOS borra del score CONTRARIO
                // los eventos de TF de igual o menor jerarquía que el gatillo
                structuralInvalidate(oppositeScore, eventTf, nowMs);

                const priceMatchChoch = alertText.match(/Precio:\s*([0-9.,]+)/i);
                const actualPrice = priceMatchChoch ? parseTVPrice(priceMatchChoch[1]) : state.lastPrice;
                // 🔧 FIX: Actualizar lastPrice con el precio del CHoCH para que el entry use precio actualizado
                if (priceMatchChoch && actualPrice) state.lastPrice = actualPrice;

                if (eventTf === '5' || eventTf === '15') {
                    const originMatch = alertText.match(/ORIGIN:\s*([0-9.,]+)/i);

                    if (originMatch && actualPrice) {
                        const newOrigin = parseTVPrice(originMatch[1]);
                        const isBuy = currentDirection === 'BUY';
                        const activeLeg = isBuy ? state.activeImpulseBuy : state.activeImpulseSell;

                        let shouldCreateNew = true;
                        if (activeLeg) {
                            const isInsideRange = actualPrice > Math.min(activeLeg.origin, activeLeg.extreme) && actualPrice < Math.max(activeLeg.origin, activeLeg.extreme);
                            if (isInsideRange) shouldCreateNew = false;

                            // 🛡️ Anti-Pingpong: No crear leg nuevo si el anterior tiene < 3 min
                            // Solo aplica en tiempo real (no en bootstrap/backtest donde los
                            // timestamps son sintéticos y múltiples BOS comparten el mismo TS de vela).
                            const LEG_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutos
                            if (!isBootstrap && !isBacktest) {
                                const elapsed = nowMs - activeLeg.createdAt;
                                if (activeLeg.createdAt && elapsed >= 0 && elapsed < LEG_COOLDOWN_MS) {
                                    shouldCreateNew = false;
                                    console.log(`[FIBO] ⚠️ ${prefix} ${currentDirection} ignorado en ${ticker}: leg anterior tiene ${Math.round(elapsed / 1000)}s (cooldown 3 min)`);
                                }
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
                } else if (eventTf === '15' || eventTf === '60' || eventTf === '240' || eventTf === 'D') {
                    const originMatch = alertText.match(/ORIGIN:\s*([0-9.,]+)/i);

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
                const basePoints = prefix === 'EVENTO_CHOCH' ? 3 : 2; // BOS era 1, ahora es 2 (edge > 85%)
                addedPoints = basePoints * (TF_WEIGHT[eventTf] || 1);
                addedEventId = `${prefix === 'EVENTO_CHOCH' ? 'CHoCH' : 'BOS'}_${readableTf}`;
            }

            if (prefix === 'ZONE_BROKEN') {
                // Filtrado por id de evento: los puntos se recalculan solos vía caché derivado
                activeScore.events = activeScore.events.filter((e: any) => {
                    if (e.id.includes(`_${readableTf}`) && (
                        e.id.startsWith('OB_') || e.id.startsWith('💎_GOD_ZONE_') ||
                        e.id.startsWith('🎯_Silver_Bullet_') || e.id.startsWith('♻️_Breaker_') ||
                        e.id.startsWith('POC_Volume_') || e.id.startsWith('🎯_ZoneTouched_') ||
                        e.id.startsWith('Breaker_')
                    )) {
                        return false;
                    }
                    return true;
                });
                refreshScoreCache(activeScore, nowMs);
                // 🔧 FIX: Limpiar las zonas CONTRARIAS rotas del mapa de zonas en RAM
                // ZONE_BROKEN dir=BUY → presión alcista rompió zonas SELL (soportes/supply)
                // ZONE_BROKEN dir=SELL → presión bajista rompió zonas BUY (demanda/demand)
                state.zones = state.zones.filter((z: any) => {
                    if (z.tf !== eventTf) return true;
                    if (currentDirection === 'BUY' && z.dir === 'BUY') return true;   // Mantener zonas BUY (no afectadas)
                    if (currentDirection === 'SELL' && z.dir === 'SELL') return true;  // Mantener zonas SELL (no afectadas)
                    return false; // zona contraria = la que fue rota por la presión, eliminarla
                });
                return;
            }

            if (prefix === 'DIV_BROKEN') {
                activeScore.events = activeScore.events.filter((e: any) => !e.id.startsWith(`DIV_${readableTf}`));
                refreshScoreCache(activeScore, nowMs);
                return;
            }

            if (prefix === 'SWEEP_BROKEN') {
                activeScore.events = activeScore.events.filter((e: any) => {
                    if (e.id === `🩸_V-Shape_Absorb_${readableTf}` || e.id === `Sweep_${readableTf}_Absorcion`) return false;
                    if (e.id === `Sweep_${readableTf}`) return false;
                    if (e.id === `📉_TL_Sweep_${readableTf}`) return false;
                    if (e.id === `🩸_LIQ_GRAB_${readableTf}`) return false;
                    return true;
                });
                refreshScoreCache(activeScore, nowMs);
                return;
            }

            if (prefix === 'TOUCH_ZONE') {
                const ptMatch = alertText.match(/Puntos:\s*(\d+)/i);
                const dynamicPts = ptMatch ? parseInt(ptMatch[1], 10) : 0;
                if (upperText.includes('BREAKER')) {
                    if (!activeScore.events.some((e: any) => e.id === `Breaker_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 3; addedEventId = `Breaker_${readableTf}`; }
                } else if (upperText.includes('PLATINO') || upperText.includes('POC')) {
                    if (!activeScore.events.some((e: any) => e.id === `POC_Volume_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 4; addedEventId = `POC_Volume_${readableTf}`; }
                } else if (upperText.includes('GOD_ZONE') || upperText.includes('ORO')) {
                    if (!activeScore.events.some((e: any) => e.id === `OB_Gold_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 3; addedEventId = `OB_Gold_${readableTf}`; }
                } else {
                    if (!activeScore.events.some((e: any) => e.id === `OB_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 2; addedEventId = `OB_${readableTf}`; }
                }
            }
            else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
                if (!activeScore.events.some((e: any) => e.id === `Sweep_${readableTf}` || e.id === `🩸_V-Shape_Absorb_${readableTf}`)) {
                    const basePoints = upperText.includes('ABSORCION') ? 6 : 3;
                    addedPoints = basePoints * (TF_WEIGHT[eventTf] || 1);
                    addedEventId = upperText.includes('ABSORCION') ? `🩸_V-Shape_Absorb_${readableTf}` : `Sweep_${readableTf}`;
                }
            }
            else if (prefix === 'EVENTO_SMC_DIV') {
                if (!activeScore.events.some((e: any) => e.id === `DIV_${readableTf}`)) {
                    const dynamicScoreMatch = alertText.match(/Score:\s*([0-9]+)/i);
                    addedPoints = dynamicScoreMatch ? parseInt(dynamicScoreMatch[1]) : 4;

                    // Penalización estadística para SMC_DIV en TF Altos (Estadísticamente tóxico en Daily)
                    if (eventTf === 'D') {
                        addedPoints = 0; // 0 puntos por toxicidad (14% winrate)
                    } else if (eventTf === '240') {
                        addedPoints = Math.min(addedPoints, 2); // Cap de 2 puntos en 4H
                    }

                    addedEventId = `DIV_${readableTf}`;
                }
            }
            else if (prefix === 'LIQ_GRAB') {
                const eventName = `🩸_LIQ_GRAB_${readableTf}`;
                if (!activeScore.events.some((e: any) => e.id === eventName)) {
                    addedPoints = 4 * (TF_WEIGHT[eventTf] || 1); // Falsa ruptura base score

                    // 🌊 TickFlow: clasificar el barrido con micro-estructura de ticks
                    // (institucional = ruptura veloz + absorción + reclaim rápido)
                    const nivelMatch = alertText.match(/Nivel:\s*([0-9.,]+)/i);
                    if (nivelMatch && currentDirection) {
                        try {
                            const sweepLevel = parseTVPrice(nivelMatch[1]);
                            const analysis = tickFlow.analyzeSweep(ticker, sweepLevel, currentDirection, nowMs);
                            console.log(`[TICKFLOW] ${ticker} sweep @${sweepLevel} → ${analysis.classification} (${analysis.reason})`);
                            if (analysis.classification === 'INSTITUTIONAL') {
                                addedPoints = 5 * (TF_WEIGHT[eventTf] || 1);
                            } else if (analysis.classification === 'RETAIL') {
                                addedPoints = 0; // Penalización total para sweeps retail
                            }
                        } catch { /* nunca bloquear scoring por analítica de ticks */ }
                    }

                    addedEventId = eventName;
                }
            }
            // NOTA: EVENTO_BOS ya se procesa en el bloque principal (líneas 1271-1360)
            // El bias y los puntos se asignan allí. Este bloque era redundante.
            else if (prefix === 'HEARTBEAT') {
                // Watchdog: solo actualiza lastHeartbeat, no suma puntos
                state.lastHeartbeat = nowMs;
                const zUpMatch = alertText.match(/Z-Up:\s*(-?[\d.]+)/i);
                const zDnMatch = alertText.match(/Z-Dn:\s*(-?[\d.]+)/i);
                if (zUpMatch) state.zUp = parseFloat(zUpMatch[1]);
                if (zDnMatch) state.zDn = parseFloat(zDnMatch[1]);
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
                if (!activeScore.events.some((e: any) => e.id === eventName)) {
                    const basePoints = zoneScore >= 9 ? 5 : zoneScore >= 7 ? 4 : zoneScore >= 5 ? 3 : 2;
                    addedPoints = basePoints * (TF_WEIGHT[eventTf] || 1);
                    addedEventId = eventName;
                }
            }
            else if (prefix === 'EVENTO_SWEEP_TL') {
                if (!activeScore.events.some((e: any) => e.id === `📉_TL_Sweep_${readableTf}`)) { addedPoints = 2; addedEventId = `📉_TL_Sweep_${readableTf}`; }
                if (oppositeScore.events.some((e: any) => e.id === `📉_TL_Sweep_${readableTf}`)) {
                    oppositeScore.events = oppositeScore.events.filter((e: any) => e.id !== `📉_TL_Sweep_${readableTf}`);
                    refreshScoreCache(oppositeScore, nowMs);
                }
            }
            // FIX: Handler ZONE_TOUCHED duplicado eliminado (ya se procesa en línea 1437)

            if (addedPoints > 0 && addedEventId) {
                // 🛡️ Clamp de seguridad: ningún evento individual puede sumar más de MAX_EVENT_POINTS.
                // Mata toda la clase de bugs de parsing (timestamps, regex) en el punto de suma.
                const MAX_EVENT_POINTS = 50;
                if (addedPoints > MAX_EVENT_POINTS) {
                    console.error(`[RADAR] 🚨 addedPoints anómalo (${addedPoints}) en "${alertText.substring(0, 80)}" → clamp a ${MAX_EVENT_POINTS}`);
                    addedPoints = MAX_EVENT_POINTS;
                }
                addScoreEvent(activeScore, { id: addedEventId, pts: addedPoints, tf: eventTf, ts: nowMs });

                // 🔄 Re-validación tardía: si hay un leg pendiente sin confluencia de zona,
                // ahora que llegó un evento de zona, re-evaluar si ya se puede validar
                if (prefix !== 'EVENTO_CHOCH' && prefix !== 'EVENTO_BOS') {
                    const pendingLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
                    if (pendingLeg && !pendingLeg.isValidated && pendingLeg.chochPoints) {
                        const hasZoneNow = activeScore.events.some((e: any) =>
                            e.id.includes('OB_') || e.id.includes('GOD_') || e.id.includes('Breaker_') ||
                            e.id.includes('Sweep_') || e.id.includes('DIV_') || e.id.includes('TL_Sweep_') ||
                            e.id.includes('ZoneTouched_') || e.id.includes('Silver_Bullet_')
                        );
                        if (hasZoneNow) {
                            pendingLeg.isValidated = true;
                            pendingLeg.chochEvents = [...activeScore.events.map((e: any) => e.id), `CHoCH_${readableTf}`];
                            console.log(`[RADAR] ✅ Leg ${currentDirection} en ${ticker} VALIDADO tardíamente con confluencia: ${addedPoints} pts de ${prefix}`);

                            // 🔧 FIX: Disparar trade INMEDIATAMENTE si el leg tiene puntos suficientes
                            // (Evita el retraso de 1 vela cuando el CHoCH no tenía zona al confirmarse)
                            const lateConfig = getConfigForTicker(ticker, nowMs);
                            const canFireChoch = lateConfig.entryTrigger === 'CHOCH' || lateConfig.entryTrigger === 'BOTH' || lateConfig.entryTrigger === 'SMART';
                            const lateMinPts = currentDirection === 'BUY' ? lateConfig.minPointsForBuy : lateConfig.minPointsForSell;
                            const lateTotalPts = pendingLeg.chochPoints!;
                            const cooldownOk = nowMs - (state.lastSniperAlert ?? 0) >= lateConfig.sniperCooldownMs;

                            if (canFireChoch && lateConfig.sessionEnabled && cooldownOk && lateTotalPts >= lateMinPts) {
                                const dec = getDecimals(ticker);
                                const slBuf = calculateDynamicSlBuffer(ticker, pendingLeg.origin, 0);
                                const adjSL = currentDirection === 'BUY' ? pendingLeg.origin - slBuf : pendingLeg.origin + slBuf;
                                const curPrice = state.lastPrice ?? pendingLeg.extreme;
                                const rDist = Math.abs(curPrice - adjSL);

                                // SMART mode: verificar distancia excesiva al origen
                                let fireNow = true;
                                if (lateConfig.entryTrigger === 'SMART') {
                                    const maxRisk = lateConfig.maxSmartRiskPercent !== undefined ? lateConfig.maxSmartRiskPercent : 0.15;
                                    const pctLimit = curPrice * (maxRisk / 100);
                                    let atr = 0;
                                    for (let i = state.zones.length - 1; i >= 0; i--) { if (state.zones[i].atr) { atr = state.zones[i].atr!; break; } }
                                    if (rDist > (atr > 0 ? atr * 1.5 : pctLimit)) {
                                        fireNow = false;
                                        console.log(`[RADAR] 🧠 Re-val tardía ${ticker}: distancia excesiva, esperando OTE.`);
                                    }
                                }

                                if (fireNow) {
                                    const fTP1 = currentDirection === 'BUY' ? curPrice + rDist : curPrice - rDist;
                                    const fTP2 = currentDirection === 'BUY' ? curPrice + (rDist * lateConfig.fixedRR) : curPrice - (rDist * lateConfig.fixedRR);
                                    const tId = Math.random().toString(36).substring(2, 8).toUpperCase();
                                    const legTfMatch = (pendingLeg.chochEvents || []).find((e: string) => e.includes('CHoCH') || e.includes('BOS'));
                                    const legTf = legTfMatch ? (legTfMatch.match(/(\d+M)/)?.[1] || readableTf) : readableTf;

                                    oteData = {
                                        tradeId: tId, direction: currentDirection,
                                        dirText: currentDirection === 'BUY' ? 'COMPRA' : 'VENTA',
                                        stopLoss: adjSL.toFixed(dec), tp1: fTP1.toFixed(dec), tp2: fTP2.toFixed(dec),
                                        entryPrice: curPrice,
                                        points: lateTotalPts, events: pendingLeg.chochEvents || activeScore.events.map((e: any) => e.id),
                                        confluenceReport: (pendingLeg.chochReport || '') + `\n🔄 <b>Re-validación Tardía:</b> Leg validado por ${prefix} (+${addedPoints} pts).`,
                                        bestZone: pendingLeg.bestZone || null,
                                        marketBias: { ...state.marketBias },
                                        isChochEntry: true,
                                        tf: legTf
                                    };
                                    triggerOte = true;
                                    state.lastSniperAlert = nowMs;
                                    activeScore.events = []; refreshScoreCache(activeScore, nowMs);
                                    const oppScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
                                    oppScore.events = []; refreshScoreCache(oppScore, nowMs);
                                    if (lateConfig.entryTrigger === 'CHOCH' || lateConfig.entryTrigger === 'SMART') pendingLeg.oteScored = true;
                                    console.log(`[RADAR] 🎯 Re-validación tardía: trade INMEDIATO ${ticker} ${currentDirection} (${lateTotalPts} pts)`);
                                }
                            }
                        }
                    }
                }
            }

            // --- CAPA 4: VALIDACIÓN DEL CHOCH / BOS ---
            // 🆕 v5.5 HÍBRIDO: Permitir que 15M (o 5M) actúe como gatillo principal en lugar de solo 3M
            if ((prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') && (eventTf === '5' || eventTf === '15')) {
                const triggerType = prefix === 'EVENTO_CHOCH' ? 'CHoCH🚀' : 'BOS🔨';

                // 🧹 1. FIX DE MEMORIA FANTASMA (Cooldown)
                // Durante el cooldown, NO reseteamos el score — se acumula para el siguiente CHoCH.
                const config = getConfigForTicker(ticker, nowMs);
                if (nowMs - (state.lastSniperAlert ?? 0) < config.sniperCooldownMs) {
                    console.log(`[RADAR] ${triggerType} ignorado por Cooldown en ${ticker} (score preservado: ${computePoints(activeScore, nowMs)} pts).`);
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
                const caseC_TrapZone = (chLow !== null && chHigh !== null) ? state.zones.filter((z: any) =>
                    z.dir !== currentDirection &&
                    z.top >= chLow && z.btm <= chHigh
                ).length : 0;

                // El respaldo viene del mapa espacial Y/O de la mochila secuencial
                const hasSpatialBacking = caseA_OriginInZone || caseB_PathTouchedZone;
                const hasSequentialBacking = activeScore.events.some((e: any) =>
                    e.id.includes('OB_') || e.id.includes('GOD_') || e.id.includes('Breaker_') ||
                    e.id.includes('ZoneTouched_') || e.id.includes('OTE_') ||
                    (e.id.includes('DIV_') && !e.id.includes('_3')) ||
                    (e.id.includes('Sweep_') && !e.id.includes('_3')) ||
                    (e.id.includes('TL_Sweep_') && !e.id.includes('_3'))
                );
                const hasHTFBacking = hasSpatialBacking || hasSequentialBacking;

                if (caseA_OriginInZone) console.log(`[RADAR] 🗺️ Caso A | Origen ${chOrigin} nació dentro de zona macro.`);
                if (caseB_PathTouchedZone && !caseA_OriginInZone) console.log(`[RADAR] 🗺️ Caso B | Vela CHoCH (${chLow}-${chHigh}) tocó zona macro en su camino.`);
                if (caseC_TrapZone > 0) console.log(`[RADAR] ⚠️ Caso C | ${caseC_TrapZone} zona(s) contraria(s) dentro del CHoCH → posible trampa.`);

                const is15MAgainst = state.marketBias['15'] !== currentDirection && state.marketBias['15'] !== 'NEUTRAL';
                const isMacroAligned = (state.marketBias['D'] === currentDirection) || (state.marketBias['240'] === currentDirection) || (state.marketBias['60'] === currentDirection);
                const isDAgainst = state.marketBias['D'] !== currentDirection && state.marketBias['D'] !== 'NEUTRAL';
                const is4HAgainst = state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL';
                const is1HAgainst = state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL';

                let baseBiasPoints = isMacroAligned ? 5 : 0;

                // Los bonus VWAP / Macro OTE entran como eventos (pts incluidos en computePoints)
                if (upperText.includes('VWAP: UNDER') && currentDirection === 'BUY') addScoreEvent(activeScore, { id: 'VWAP_Discount', pts: 2, tf: eventTf, ts: nowMs });
                else if (upperText.includes('VWAP: OVER') && currentDirection === 'SELL') addScoreEvent(activeScore, { id: 'VWAP_Premium', pts: 2, tf: eventTf, ts: nowMs });

                // Sumamos todo el puntaje bruto inicial
                let macroOteBonus = 0;
                const activeMacroLeg = currentDirection === 'BUY' ? state.activeMacroImpulseBuy : state.activeMacroImpulseSell;
                if (activeMacroLeg && isInsideMacroOteZone(activeMacroLeg, chExtreme ?? state.lastPrice ?? 0)) {
                    macroOteBonus = 6; // +6 Puntos de confluencia por OTE macro activa
                    addScoreEvent(activeScore, { id: 'Macro_OTE_Confluence', pts: 6, tf: eventTf, ts: nowMs });
                }

                let totalPoints = computePoints(activeScore, nowMs) + baseBiasPoints + 2;
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
                if (isDAgainst) totalPoints -= 2;
                if (is4HAgainst && is1HAgainst) totalPoints -= 3;
                // Penalización por zona trampa (Caso C)
                const trapPenalty = caseC_TrapZone > 0 ? caseC_TrapZone * 2 : 0;
                if (trapPenalty > 0) totalPoints -= trapPenalty;

                // 📊 4. ARMADO DE REPORTE PARA TELEGRAM
                const getIcon = (tf: string) => state.marketBias[tf] === 'BUY' ? '🟢' : state.marketBias[tf] === 'SELL' ? '🔴' : '⚪';

                let confluenceReport = `🗺️ <b>Contexto Macro:</b>\n`;
                confluenceReport += `${getIcon("D")} D: ${state.marketBias["D"] || 'NEUTRAL'}\n`;
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
                // (sessionThresholds defined at the top of the function)

                if (!config.sessionEnabled) {
                    console.log(`[RADAR] 🚫 Trading desactivado para ${ticker} en esta sesión`);
                    return;
                }

                const currentSession = getCurrentSession(nowMs);
                // 🆕 FIX: fallback a 'ALL' (el panel exporta la sesión OFF como ALL)
                const sessionConfig = config.sessions?.[currentSession] ?? (config.sessions as any)?.['ALL'];

                let triggerEnabled = false;
                let liveTriggerCfg: any = null; // 🆕 config del gatillo que dispara (genes tuneados)
                let minPtsRequired = currentDirection === 'BUY'
                    ? (sessionThresholds?.buy || config.minPointsForBuy)
                    : (sessionThresholds?.sell || config.minPointsForSell);

                if (sessionThresholds) {
                    triggerEnabled = (config.entryTrigger === 'CHOCH' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
                    minPtsRequired = currentDirection === 'BUY' ? sessionThresholds.buy : sessionThresholds.sell;
                } else if (sessionConfig) {
                    const tfKeyChoch = `choch${eventTf}m` as keyof typeof sessionConfig;
                    const tfKeyBos = `bos${eventTf}m` as keyof typeof sessionConfig;

                    if (triggerType === 'CHoCH🚀') {
                        const tfConfig = sessionConfig[tfKeyChoch] as any;
                        if (tfConfig) {
                            liveTriggerCfg = tfConfig;
                            triggerEnabled = tfConfig.enabled ?? false;
                            minPtsRequired = currentDirection === 'BUY'
                                ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? config.minPointsForBuy)
                                : (tfConfig.minScoreSell ?? tfConfig.minScore ?? config.minPointsForSell);
                        } else if ((sessionConfig as any).choch) {
                            triggerEnabled = (sessionConfig as any).choch.enabled ?? false;
                            minPtsRequired = (sessionConfig as any).choch.minScore ?? (currentDirection === 'BUY' ? config.minPointsForBuy : config.minPointsForSell);
                        }
                    } else if (triggerType === 'BOS🔨') {
                        const tfConfig = sessionConfig[tfKeyBos] as any;
                        if (tfConfig) {
                            liveTriggerCfg = tfConfig;
                            triggerEnabled = tfConfig.enabled ?? false;
                            minPtsRequired = currentDirection === 'BUY'
                                ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? config.minPointsForBuy)
                                : (tfConfig.minScoreSell ?? tfConfig.minScore ?? config.minPointsForSell);
                        } else if ((sessionConfig as any).bos) {
                            triggerEnabled = (sessionConfig as any).bos.enabled ?? false;
                            minPtsRequired = (sessionConfig as any).bos.minScore ?? (currentDirection === 'BUY' ? config.minPointsForBuy : config.minPointsForSell);
                        }
                    }
                } else {
                    if (triggerType === 'BOS🔨') {
                        triggerEnabled = (config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
                    } else {
                        triggerEnabled = (config.entryTrigger === 'CHOCH' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
                    }
                }

                const isCrypto = ticker.includes('BTC') || ticker.includes('ETH');
                if (isCrypto) minPtsRequired = Math.max(minPtsRequired - 1, 3); // Crypto: 1 punto menos

                const bestZone = state.zones.filter((z: any) => z.dir === currentDirection).sort((a: any, b: any) => (b.score || 0) - (a.score || 0))[0] || null;

                if (true) {
                    const activeLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
                    if (activeLeg) {
                        // 🛡️ Requiere al menos 1 evento de zona real O respaldo espacial del mapa de zonas
                        const hasZoneConfluence = activeScore.events.some((e: any) =>
                            e.id.includes('OB_') || e.id.includes('GOD_') || e.id.includes('Breaker_') ||
                            e.id.includes('Sweep_') || e.id.includes('DIV_') || e.id.includes('TL_Sweep_') ||
                            e.id.includes('ZoneTouched_') || e.id.includes('Silver_Bullet_')
                        );

                        // El respaldo espacial (Caso A/B) también valida: si el CHoCH nació en zona macro
                        // o la tocó en su recorrido, no necesita eventos secuenciales adicionales.
                        // ⚡ HIGH_SCORE_BYPASS: si acumuló ≥12 pts por eventos puros (CHoCH + Sweeps + DIV),
                        // se valida aunque no haya zonas en memoria. Caso típico: reversión contra tendencia
                        // donde 4H/1H son SELL pero 3M hace CHoCH BUY con múltiples confluencias.
                        const HIGH_SCORE_BYPASS = Math.min(minPtsRequired, 8); // Bypass "puntaje alto sin zonas" desacoplado del umbral de entrada
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
                        activeLeg.chochEvents = [...activeScore.events.map((e: any) => e.id), `${triggerType}_${readableTf}`];
                        activeLeg.chochReport = confluenceReport;
                        activeLeg.bestZone = bestZone;

                        if (efectiveValidation && triggerEnabled && totalPoints >= minPtsRequired) {
                            const decimals = getDecimals(ticker);
                            const currentSession = getCurrentSession(nowMs);
                            const sessionConfig = config.sessions?.[currentSession] ?? (config.sessions as any)?.['ALL'];
                            // 🔧 FIX: usar buffer configurado (no 0) + piso mínimo para
                            // que cTrader acepte el SL/TP (rechaza distancias < ~10 pips forex).
                            const rawBuffer = liveTriggerCfg?.slBuff ?? sessionConfig?.slBufferPercent ?? config.slBufferPercent;
                            let slBufferAmt = calculateDynamicSlBuffer(ticker, activeLeg.origin, rawBuffer);
                            // Piso absoluto: 10 pips forex (0.0010), 100 puntos índices, 1.0 crypto/commodities
                            const minPipDist = getMinPipDistance(ticker);
                            if (slBufferAmt < minPipDist) slBufferAmt = minPipDist;
                            const adjustedSL = currentDirection === 'BUY' ? activeLeg.origin - slBufferAmt : activeLeg.origin + slBufferAmt;
                            const stopLoss = adjustedSL.toFixed(decimals);
                            const currentPrice = state.lastPrice ?? activeLeg.extreme;
                            const riskDist = Math.abs(currentPrice - adjustedSL);
                            const fixedTP1 = currentDirection === 'BUY'
                                ? currentPrice + riskDist
                                : currentPrice - riskDist;
                            const tp1 = fixedTP1.toFixed(decimals);
                            const fixedTP2 = currentDirection === 'BUY'
                                ? currentPrice + (riskDist * (liveTriggerCfg?.tp2 ?? config.fixedRR))
                                : currentPrice - (riskDist * (liveTriggerCfg?.tp2 ?? config.fixedRR));
                            const tp2 = fixedTP2.toFixed(decimals);
                            const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();

                            oteData = {
                                tradeId, direction: currentDirection,
                                dirText: currentDirection === 'BUY' ? 'COMPRA' : 'VENTA',
                                stopLoss, tp1, tp2, entryPrice: currentPrice,
                                points: totalPoints, events: [...activeScore.events.map((e: any) => e.id), `${triggerType}_${readableTf}`],
                                confluenceReport: confluenceReport || '',
                                bestZone, marketBias: { ...state.marketBias },
                                isChochEntry: true,
                                tf: readableTf,
                                // 🆕 genes de gestión tuneados por el auto-tune para ESTE gatillo
                                mgmtOverrides: extractMgmtOverrides(liveTriggerCfg)
                            };
                            let takeChoch = false;
                            let disableOte = false;
                            let smartReport = '';

                            let oteSessionEnabled = false;
                            if (sessionConfig) {
                                const oteTfKeyChoch = `oteChoch${eventTf}m` as keyof typeof sessionConfig;
                                const oteTfKeyBos = `oteBos${eventTf}m` as keyof typeof sessionConfig;

                                if (triggerType === 'CHoCH🚀') {
                                    const tfConfig = sessionConfig[oteTfKeyChoch] as any;
                                    if (tfConfig) oteSessionEnabled = tfConfig.enabled ?? false;
                                    else if ((sessionConfig as any).oteChoch) oteSessionEnabled = (sessionConfig as any).oteChoch.enabled ?? false;
                                } else {
                                    const tfConfig = sessionConfig[oteTfKeyBos] as any;
                                    if (tfConfig) oteSessionEnabled = tfConfig.enabled ?? false;
                                    else if ((sessionConfig as any).oteBos) oteSessionEnabled = (sessionConfig as any).oteBos.enabled ?? false;
                                }
                            } else {
                                oteSessionEnabled = (config.entryTrigger === 'OTE' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
                            }

                            if (config.entryTrigger === 'SMART') {
                                function parseTfToMinutes(tfStr: string): number {
                                    if (!tfStr) return 0;
                                    const upper = tfStr.toUpperCase();
                                    if (upper === 'D' || upper === '1D') return 1440;
                                    if (upper === 'W' || upper === '1W') return 10080;
                                    const val = parseInt(upper);
                                    if (!isNaN(val)) {
                                        if (upper.includes('H')) return val * 60;
                                        return val;
                                    }
                                    return 0;
                                }

                                const signalTfMs = parseTfToMinutes(readableTf);

                                // 🔧 MEJORA 1: Filtrar Paredes de Papel (Ignorar debiles y de menor TF)
                                const oppositeZones = state.zones.filter((z: any) => {
                                    if (z.dir === currentDirection) return false;
                                    if (z.medal === 'SMC_DIV') return false; // Divergencias no son zonas duras

                                    const zTfMs = parseTfToMinutes(z.tf || '');
                                    const isStrong = z.lvl === 'Strong' || z.medal?.includes('GOD');

                                    // Consideramos el obstáculo SI es fuerte O SI es de igual/mayor temporalidad
                                    return isStrong || zTfMs >= signalTfMs;
                                });

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

                                // 🔧 MEJORA 2: Locomotora Institucional (Ignorar mal RR si el momentum es brutal)
                                const MOMENTUM_EXTREMO_UMBRAL = (minPtsRequired || 8) + 5; // ej: si min es 8, 13 es extremo
                                const hasExtremeMomentum = totalPoints >= MOMENTUM_EXTREMO_UMBRAL;

                                // 🔧 MEJORA 3: Límite de distancia al origen (Forzar OTE si el SL queda demasiado lejos)
                                const maxSmartRisk = config.maxSmartRiskPercent !== undefined ? config.maxSmartRiskPercent : 0.15;
                                const limitByPercent = currentPrice * (maxSmartRisk / 100);

                                let latestAtr = 0;
                                for (let i = state.zones.length - 1; i >= 0; i--) {
                                    if (state.zones[i].atr) { latestAtr = state.zones[i].atr!; break; }
                                }

                                const maxAllowedRiskDist = latestAtr > 0 ? latestAtr * 1.5 : limitByPercent;

                                if (riskDist > maxAllowedRiskDist) {
                                    const limitType = latestAtr > 0 ? '1.5x ATR' : `${maxSmartRisk}%`;
                                    smartReport = `\n🧠 <b>Modo SMART:</b> Distancia al origen excesiva (${riskDist.toFixed(decimals)} > ${maxAllowedRiskDist.toFixed(decimals)} [${limitType}]). Vela demasiado extendida. Se fuerza retroceso OTE.`;
                                    takeChoch = false;
                                    disableOte = false;
                                } else if (isClimaxCandle) {
                                    smartReport = `\n🧠 <b>Modo SMART:</b> Vela de quiebre (CHoCH/BOS) con VOLUMEN EXTREMO detectada. Posible agotamiento. Se fuerza espera a retroceso OTE.`;
                                    takeChoch = false;
                                    disableOte = false;
                                } else if (rrChoch >= 1.5 || hasExtremeMomentum) {
                                    if (rrChoch < 1.5) {
                                        smartReport = `\n🧠 <b>Modo SMART:</b> RR Estimado ${rrChoch.toFixed(1)}x. Obstáculo detectado, pero ignorado por MOMENTUM EXTREMO (${totalPoints} pts). Se toma el CHoCH directo.`;
                                    } else {
                                        smartReport = `\n🧠 <b>Modo SMART:</b> RR Estimado ${rrChoch.toFixed(1)}x. Camino despejado. Se toma el CHoCH directo (OTE desactivado).`;
                                    }
                                    takeChoch = true;
                                    disableOte = true;
                                } else {
                                    smartReport = `\n🧠 <b>Modo SMART:</b> RR Estimado ${rrChoch.toFixed(1)}x. Riesgo alto para CHoCH directo, esperando pullback a OTE.`;
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
                                // ✅ Cooldown y reset SOLO cuando el trade realmente se dispara
                                state.lastSniperAlert = nowMs;
                                activeScore.events = []; refreshScoreCache(activeScore, nowMs);
                                oppositeScore.events = []; refreshScoreCache(oppositeScore, nowMs);
                            }

                            if (disableOte) {
                                activeLeg.oteScored = true; // Al marcarlo puntuado, JARVIS ignorará futuros retrocesos
                            }
                        }
                    }
                }
            }
            else if (prefix === 'HEARTBEAT') state.lastHeartbeat = nowMs;
        }

        // 🔧 FIX v5.4: 15M zones now live 6h (antes 2h) para cubrir el gap entre killzones
        // London 4-6 ART → NY 10:30-12:30 ART = 4.5h sin sync. Con 6h las zonas sobreviven.
        const MAX_ZONE_AGE_MS: Record<string, number> = {
            '3': 1800000, '5': 3600000, '15': 21600000,
            '60': 28800000, '240': 86400000, 'D': 604800000,
        };
        state.zones = state.zones.filter((z: any) => {
            if (!z.createdAt) return true;
            return (nowMs - z.createdAt) < (MAX_ZONE_AGE_MS[z.tf || '60'] || 14400000);
        });

        // 💾 2. GUARDAR LOS CAMBIOS EN LA RAM LOCAL SIEMPRE
        store.localRadarStates.set(ticker, state);

        // 💾 3. GUARDAR EN FIREBASE (BACKUP INTELIGENTE CADA 5 MINUTOS O EN EVENTOS)
        const timeSinceLastSave = nowMs - (store.lastFirebaseSave.get(ticker) || 0);
        const FIREBASE_INTERVAL_MS = 5 * 60 * 1000; // 5 Minutos

        // 🔄 Refrescar la caché derivada `points` antes de persistir (la leen clientes externos)
        refreshScoreCache(state.scoreBuy, nowMs);
        refreshScoreCache(state.scoreSell, nowMs);

        state.version = (state.version || 0) + 1;
        state.lastModified = nowMs;

        if (prefix !== 'PING_PRICE' || timeSinceLastSave > FIREBASE_INTERVAL_MS) {
            safeSet(state, { merge: true }).catch((err: any) => console.error(`[FIREBASE] Error guardando estado ${ticker}: ${err.message}`));
            store.lastFirebaseSave.set(ticker, nowMs);
        }

        if (triggerOte && oteData) {
            state.lastGatillo = {
                dir: oteData.direction as 'BUY' | 'SELL',
                price: oteData.entryPrice,
                time: nowMs,
                type: oteData.isChochEntry ? 'CHOCH' : 'OTE',
                status: 'EVALUANDO...',
                tf: oteData.tf
            };
            state.version = (state.version || 0) + 1;
            state.lastModified = nowMs;
            safeSet(state, { merge: true }).catch(() => { });
            dispatchData = oteData;
        }

        if (dispatchData) {
            if (!isBootstrap) {
                await dispatchOteSignal(dispatchData, state, null, { ticker, nowMs, isBacktest, sessionThresholds, store });
            } else {
                console.log(`[BOOTSTRAP] ⏭️ Se generó OTE para ${ticker} pero se omite ejecución (fase de construcción de estado)`);
            }
        }

    } catch (e: any) {
        console.error(`[RADAR] Error crítico en memoria/Firebase:`, e.message);
    } finally {
        releaseLock!(); // 🛡️ v5.4: Liberar lock del ticker tras despachar la orden (previene doble entrada TOCTOU)
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
                globalState.vixKillswitchUntil = Date.now() + 20 * 60 * 1000;
            } else {
                globalState.vixKillswitchUntil = 0;
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
                .catch((e: any) => console.error('[DAILY] Error generando resumen:', e));
        }
    };
    setInterval(scheduleDailySummary, 5 * 60 * 1000);
    scheduleDailySummary();

    setInterval(() => {
        const now = Date.now();
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

        for (const [id, trade] of globalState.activeTrades) {
            const age = now - trade.timestamp;
            // 🛡️ Si no hay registros de pings para este ticker, usamos la hora de creación del trade
            // para evitar que se interprete como inactivo desde 1970 (inactividad = now)
            const lastSeen = globalState.tickerLastSeen.get(trade.ticker) || trade.timestamp;
            const inactivity = now - lastSeen;

            // Si globalState.tickerLastSeen está completamente vacío (post-reinicio), no cerrar el trade
            if (globalState.tickerLastSeen.size === 0) {
                continue; // No cerrar trades hasta que llegue el primer PING real
            }

            // Cierre por timeout: ELIMINADO SEGÚN SOLICITUD

            // Limpieza de trades huérfanos (7 días)
            if (age > SEVEN_DAYS) {
                globalState.activeTrades.delete(id);
                if (db && !trade.isBacktest) db.collection('active_trades').doc(id).delete().catch(() => { });
                console.log(`[JOURNAL] 🧹 Trade ${id} expirado de RAM (7 días)`);
            }
        }

        for (const [ticker, lastSeen] of globalState.tickerLastSeen) {
            const inactiveMin = Math.round((now - lastSeen) / 60000);
            if (now - lastSeen > HEARTBEAT_TIMEOUT_MS) {
                // 🔔 Alerta proactiva de desconexión
                const state = globalState.localRadarStates.get(ticker);
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
                globalState.tickerLastSeen.delete(ticker); // Lo borramos para que no vuelva a alertar
                console.warn(`[WATCHDOG] 🔌 ${ticker}: DESCONECTADO hace ${inactiveMin} min. Alerta Silenciosa.`);
            }
        }
    }, WATCHDOG_INTERVAL_MS);
}

/**
 * 🆕 v7.2: Inyectar el ID de la posición de cTrader en la RAM
 * Esto permite que trading.ts pueda hacer cierres parciales y breakeven automáticamente
 */
export function updateTradePositionId(tradeId: string, positionId: string) {
    const trade = globalState.activeTrades.get(tradeId);
    if (trade) {
        trade.ctraderPositionId = positionId;
        console.log(`[RADAR] 🔗 Enlazado trade #${tradeId} con cTrader posID: ${positionId} en RAM`);
    }
}

async function dispatchOteSignal(dispatchData: any, state: any, docRef: any, ctx: any) {
    const { ticker, nowMs, isBacktest, sessionThresholds, store } = ctx;
    const oteData = dispatchData;
    const { db: fireDb } = await import('./memory.js');
    const db = fireDb;

    // 🔧 FIX: safeSet debe estar en el scope de dispatchOteSignal (no hereda el de processTradingAlert)
    const safeSet = (data: any, options?: any) => {
        if (isBacktest) return Promise.resolve();
        if (docRef) return docRef.set(data, options);
        return Promise.resolve(); // sin Firestore, sin problema
    };

    // =========================================================================
    // EJECUCIÓN OTE FUERA DE LA TRANSACCIÓN
    // =========================================================================
    {
        console.log(`[SNIPER] 🎯 triggerOte=true para ${ticker} ${oteData.direction}. Puntos: ${oteData.points}. Evaluando killswitches...`);

        state.lastGatillo = {
            dir: oteData.direction as 'BUY' | 'SELL',
            price: oteData.entryPrice,
            time: nowMs,
            type: oteData.isChochEntry ? 'CHOCH' : 'OTE',
            status: 'EVALUANDO...',
            tf: oteData.tf
        };

        state.version = (state.version || 0) + 1;
        state.lastModified = nowMs;
        safeSet(state, { merge: true }).catch((err: any) => console.error(`[FIREBASE] Error guardando gatillo ${ticker}: ${err.message}`)); // Update status in UI immediately

        const config = getConfigForTicker(ticker, nowMs);
        if (!config.sessionEnabled) {
            console.log(`[RADAR] 🚫 Trading desactivado para ${ticker} en esta sesión (OTE bloqueado)`);
            state.lastGatillo.status = 'BLOCKED_SESSION';
            safeSet(state).catch(() => { });
            // Limpiar si se pre-creó en evaluateImpulse (para OTE)
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }

        const currentSession = getCurrentSession(nowMs);
        const warmupMin = (config as any).sessionWarmupMin ?? 15;
        if ((currentSession === 'LONDON' || currentSession === 'NY') && minutesSinceSessionOpen(nowMs) < warmupMin) {
            console.log(`[RADAR] 🚫 Trading bloqueado por warmup de sesión (${currentSession}) para ${ticker}`);
            state.lastGatillo.status = 'BLOCKED_WARMUP';
            safeSet(state).catch(() => { });
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }

        const isGlobalKilled = await evaluateGlobalKillswitch(nowMs, store, isBacktest);
        if (isGlobalKilled) {
            console.log(`[GLOBAL KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por riesgo global consolidado de la cuenta.`);
            state.lastGatillo.status = 'BLOCKED_GLOBAL';
            safeSet(state).catch(() => { });
            // Limpiar si se pre-creó en evaluateImpulse (para OTE)
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }

        // 🆕 Killswitch POR ACTIVO (límites de asset_configs/{ticker})
        if (await evaluateAssetKillswitch(ticker, nowMs, store, isBacktest)) {
            console.log(`[ASSET KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por límite de riesgo del activo.`);
            state.lastGatillo.status = 'BLOCKED_ASSET';
            safeSet(state).catch(() => { });
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }

        if (nowMs < store.streakKillswitchUntil) {
            const remainingMin = Math.round((store.streakKillswitchUntil - nowMs) / 60000);
            console.log(`[KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por racha perdedora (${store.consecutiveLosses} pérdidas). Restan ${remainingMin} min de bloqueo.`);
            state.lastGatillo.status = 'BLOCKED_RACHA';
            safeSet(state).catch(() => { });
            // Limpiar si se pre-creó en evaluateImpulse (para OTE)
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }
        if (nowMs < store.vixKillswitchUntil) {
            const remainingMin = Math.round((store.vixKillswitchUntil - nowMs) / 60000);
            console.log(`[KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por VIX>30. Restan ${remainingMin} min de bloqueo.`);
            state.lastGatillo.status = 'BLOCKED_VIX';
            safeSet(state).catch(() => { });
            // Limpiar si se pre-creó en evaluateImpulse (para OTE)
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }

        // ═══ TIMESFM FILTER (F1) — post-killswitches, pre-ejecución ═══
        // Espejo del gate en backtestEngine.ts createTrade. Regla de oro: si el puente
        // falla / forecast viejo / timeout → se loguea DEGRADADO y el trade SIGUE (nunca frenar).
        const tfmCfg = resolveTimesfmConfig((config as any).timesfm);
        if (tfmCfg.enabled && !isBacktest) {
            const atrNow = state.atr14 ?? 0;
            const tfmDecision: TimesfmDecision = atrNow > 0
                ? await fetchLiveTimesfmDecision({
                    ticker,
                    tfMinutes: parseInt(String(oteData.tf || '15').replace(/\D/g, '')) || 15,
                    signalDir: oteData.direction as 'BUY' | 'SELL',
                    currentPrice: oteData.entryPrice,
                    atr14: atrNow,
                    smcPoints: oteData.points,
                    cfg: tfmCfg,
                })
                : { action: 'APPROVE', riskMult: 1.0, forecastDir: 'FLAT', highConviction: false, spreadAtr: 0, forecastMedian: 0, reason: 'DEGRADADO: ATR no inicializado', degraded: true };
            const tfmAudit: Record<string, unknown> = {
                ts: nowMs, ticker, direction: oteData.direction, points: oteData.points,
                action: tfmDecision.action, riskMult: tfmDecision.riskMult,
                forecastDir: tfmDecision.forecastDir, spreadAtr: +tfmDecision.spreadAtr.toFixed(4),
                reason: tfmDecision.reason, degraded: tfmDecision.degraded, dryRun: tfmCfg.dryRun === true,
                tp2Dynamic: false,
            };
            console.log(`[TIMESFM${tfmCfg.dryRun ? ' DRY' : ''}] ${ticker} ${oteData.direction} → ${tfmDecision.action} (mult=${tfmDecision.riskMult}) — ${tfmDecision.reason}`);
            // 🆕 Radar v2: registrar veredicto para el dashboard (mapa en memoria + gatillo actual)
            lastTfmByTicker.set(ticker, {
                action: tfmDecision.action, riskMult: tfmDecision.riskMult,
                degraded: tfmDecision.degraded, dryRun: tfmCfg.dryRun === true, ts: nowMs,
            });
            (state.lastGatillo as any).tfm = {
                action: tfmDecision.action, riskMult: tfmDecision.riskMult,
                degraded: tfmDecision.degraded, dryRun: tfmCfg.dryRun === true,
            };
            if (tfmCfg.dryRun) {
                // F2 shadow: auditar sin aplicar — el trade sigue con riskMult intacto
            } else if (tfmDecision.action === 'REJECT') {
                appendTimesfmAudit(tfmCfg.auditPath ?? 'logs/timesfm_audit.jsonl', tfmAudit);
                state.lastGatillo.status = 'BLOCKED_TIMESFM';
                safeSet(state).catch(() => { });
                store.activeTrades.delete(oteData.tradeId);
                if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
                return;
            } else {
                oteData.timesfmAction = tfmDecision.action;
                oteData.riskMult = tfmDecision.riskMult;
                // Fase C: TP2 dinámico por q90 (SL sigue estructural/slBuff por diseño).
                if (tfmCfg.tp2Dynamic === 'q90' && tfmDecision.forecast && !tfmDecision.degraded) {
                    const dyn = resolveTp2FromForecast(tfmDecision.forecast, oteData.direction as 'BUY' | 'SELL', oteData.entryPrice, tfmCfg.tp2Q90Step ?? 2);
                    if (dyn !== null) {
                        oteData.tp2 = String(dyn);
                        oteData.tp2DynamicSource = 'q90';
                        tfmAudit.tp2Dynamic = true;
                        tfmAudit.tp2Price = dyn;
                    }
                }
            }
            appendTimesfmAudit(tfmCfg.auditPath ?? 'logs/timesfm_audit.jsonl', tfmAudit);
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
            const sellConfig = getConfigForTicker(ticker, nowMs);

            // 🛑 Verificar pérdidas consecutivas (MCL) direccionales por sesión y activo
            const currentSession = getCurrentSession(nowMs);
            const sessionConfig = sellConfig.sessions?.[currentSession];
            if (sessionConfig && sessionConfig.maxSellLosses !== undefined && sessionConfig.maxSellLosses > 0) {
                const currentConsecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'SELL', nowMs, store, isBacktest, activeSessionId);
                if (currentConsecutiveLosses >= sessionConfig.maxSellLosses) {
                    console.log(`[MCL LIMIT] ⛔ Setup ${ticker} SELL BLOQUEADO: ${currentConsecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas en sesión ${currentSession}.`);
                    state.lastGatillo!.status = 'BLOCKED_MCL_LIMIT';
                    safeSet(state).catch(() => { });
                    store.activeTrades.delete(oteData.tradeId);
                    if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });

                    sendTelegramAlert(
                        `🚨 <b>[MCL LIMIT]</b> ${ticker} SELL ignorado.\n\n` +
                        `📊 Se alcanzaron <b>${currentConsecutiveLosses}/${sessionConfig.maxSellLosses}</b> pérdidas consecutivas de tipo SELL hoy en la sesión <b>${currentSession}</b>.\n` +
                        `💡 <i>Límite de pérdidas consecutivas (maxSellLosses) superado.</i>`
                    ).catch(() => { });
                    return;
                }
                console.log(`[MCL LIMIT] ✅ ${ticker} SELL permitido: ${currentConsecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas de tipo SELL.`);
            }

            // 📊 Verificar límite diario de SELLs
            if (sellConfig.maxSellsPerDay > 0) {
                const dailySells = await countDailySellsForTicker(ticker, nowMs, isBacktest, activeSessionId);
                if (dailySells >= sellConfig.maxSellsPerDay) {
                    console.log(`[SELL LIMIT] ⛔ Setup ${ticker} SELL BLOQUEADO: ${dailySells}/${sellConfig.maxSellsPerDay} SELLs diarios alcanzados.`);
                    state.lastGatillo!.status = 'BLOCKED_SELL_LIMIT';
                    safeSet(state).catch(() => { });
                    store.activeTrades.delete(oteData.tradeId);
                    if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });

                    sendTelegramAlert(
                        `⚠️ <b>[SELL LIMIT]</b> ${ticker} SELL ignorado.\n\n` +
                        `📊 Ya se ejecutaron <b>${dailySells}/${sellConfig.maxSellsPerDay}</b> operaciones SELL hoy en este activo.\n` +
                        `💡 <i>Configurá maxSellsPerDay en asset_configs para ajustar el límite.</i>`
                    ).catch(() => { });
                    return;
                }
                console.log(`[SELL LIMIT] ✅ ${ticker} SELL permitido: ${dailySells}/${sellConfig.maxSellsPerDay} SELLs usados hoy.`);
            }

        }

        // 🆕 v7.2: FILTRO DE OPERACIONES BUY (Anti-Long Bias)
        if (oteData.direction === 'BUY') {
            const buyConfig = getConfigForTicker(ticker, nowMs);

            // 🛑 Verificar pérdidas consecutivas (MCL) direccionales por sesión y activo
            const currentSession = getCurrentSession(nowMs);
            const sessionConfig = buyConfig.sessions?.[currentSession];
            if (sessionConfig && sessionConfig.maxBuyLosses !== undefined && sessionConfig.maxBuyLosses > 0) {
                const currentConsecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'BUY', nowMs, store, isBacktest, activeSessionId);
                if (currentConsecutiveLosses >= sessionConfig.maxBuyLosses) {
                    console.log(`[MCL LIMIT] ⛔ Setup ${ticker} BUY BLOQUEADO: ${currentConsecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas en sesión ${currentSession}.`);
                    state.lastGatillo!.status = 'BLOCKED_MCL_LIMIT';
                    safeSet(state).catch(() => { });
                    store.activeTrades.delete(oteData.tradeId);
                    if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });

                    sendTelegramAlert(
                        `🚨 <b>[MCL LIMIT]</b> ${ticker} BUY ignorado.\n\n` +
                        `📊 Se alcanzaron <b>${currentConsecutiveLosses}/${sessionConfig.maxBuyLosses}</b> pérdidas consecutivas de tipo BUY hoy en la sesión <b>${currentSession}</b>.\n` +
                        `💡 <i>Límite de pérdidas consecutivas (maxBuyLosses) superado.</i>`
                    ).catch(() => { });
                    return;
                }
                console.log(`[MCL LIMIT] ✅ ${ticker} BUY permitido: ${currentConsecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas de tipo BUY.`);
            }

            // 📊 Verificar límite diario de BUYs
            if (buyConfig.maxBuysPerDay > 0) {
                const dailyBuys = await countDailyBuysForTicker(ticker, nowMs, isBacktest, activeSessionId);
                if (dailyBuys >= buyConfig.maxBuysPerDay) {
                    console.log(`[BUY LIMIT] ⛔ Setup ${ticker} BUY BLOQUEADO: ${dailyBuys}/${buyConfig.maxBuysPerDay} BUYs diarios alcanzados.`);
                    state.lastGatillo!.status = 'BLOCKED_BUY_LIMIT';
                    safeSet(state).catch(() => { });
                    store.activeTrades.delete(oteData.tradeId);
                    if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });

                    sendTelegramAlert(
                        `⚠️ <b>[BUY LIMIT]</b> ${ticker} BUY ignorado.\n\n` +
                        `📊 Ya se ejecutaron <b>${dailyBuys}/${buyConfig.maxBuysPerDay}</b> operaciones BUY hoy en este activo.\n` +
                        `💡 <i>Configurá maxBuysPerDay en asset_configs para ajustar el límite.</i>`
                    ).catch(() => { });
                    return;
                }
                console.log(`[BUY LIMIT] ✅ ${ticker} BUY permitido: ${dailyBuys}/${buyConfig.maxBuysPerDay} BUYs usados hoy.`);
            }

        }

        // 🆕 Filtro Anti-Piramidación y Lógica SAR (Stop and Reverse)
        let existingTradeForTicker: ActiveTrade | undefined;
        for (const trade of store.activeTrades.values()) {
            if (trade.ticker === ticker && trade.tradeId !== oteData.tradeId) {
                existingTradeForTicker = trade;
                break;
            }
        }

        // 🛡️ Extra check: Si no hay en RAM, revisemos cTrader real para evitar duplicados huérfanos
        let cTraderPos: any;
        if (!isBacktest && !existingTradeForTicker) {
            try {
                const ctrader = await import('../services/ctrader.js');
                if (ctrader.isCTraderReady()) {
                    const openPositions = await ctrader.getOpenPositions(ticker);
                    if (openPositions && openPositions.length > 0) {
                        cTraderPos = openPositions[0];
                        const cTraderDir = (cTraderPos.tradeData?.tradeSide || cTraderPos.tradeSide || '').toString().toUpperCase();
                        // Crear un mock de ActiveTrade para aplicar la misma lógica
                        existingTradeForTicker = {
                            tradeId: String(cTraderPos.positionId || cTraderPos.id || 'CTRADER_MOCK'),
                            ticker: ticker,
                            direction: cTraderDir.includes('BUY') ? 'BUY' : 'SELL',
                            entryPrice: cTraderPos.entryPrice || cTraderPos.price || 0,
                            tp1Price: 0, tp2Price: 0, slPrice: 0,
                            tp1Hit: false, tp2Hit: false,
                            score: 0, // Score 0 significa que cualquier señal nueva le ganará en SAR
                            timestamp: Date.now(), isBacktest: isBacktest,
                            ctraderPositionId: String(cTraderPos.positionId || cTraderPos.id)
                        };
                        console.log(`[ANTI-PYRAMID] ⚠️ Trade encontrado en cTrader (huérfano en RAM): ${existingTradeForTicker.direction} posID: ${existingTradeForTicker.ctraderPositionId}`);
                    }
                }
            } catch (e) {
                console.error("[ANTI-PYRAMID] Error verificando posiciones cTrader:", e);
            }
        }

        let sarPendingClose: any = null;
        if (existingTradeForTicker) {
            const cleanupPrecreatedTrade = () => {
                if (oteData && oteData.tradeId) {
                    store.activeTrades.delete(oteData.tradeId);
                    if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
                }
            };

            if (existingTradeForTicker.direction === oteData.direction) {
                // Mismo sentido -> Bloquear para evitar piramidación
                console.log(`[ANTI-PYRAMID] ⛔ Señal ${oteData.direction} ignorada para ${ticker}: ya hay una operación activa en la misma dirección.`);
                cleanupPrecreatedTrade();
                if (state.lastGatillo) state.lastGatillo.status = 'BLOCKED_ANTIPYRAMID';
                safeSet(state).catch(() => { });
                if (!isBacktest) sendTelegramAlert(`⚠️ <b>SEÑAL IGNORADA</b> | ${ticker}\nSe detectó una nueva señal <b>${oteData.direction}</b>, pero ya hay una operación abierta en la misma dirección. (Anti-Piramidación)`).catch(() => { });
                return;
            } else {
                // Dirección Opuesta -> SAR (Stop and Reverse)
                if (oteData.points > existingTradeForTicker.score) {
                    console.log(`[SAR] 🔄 Reversión Activada (Diferida) para ${ticker}: Nueva señal ${oteData.direction} (Score: ${oteData.points}) supera a la activa (Score: ${existingTradeForTicker.score}).`);
                    sarPendingClose = existingTradeForTicker;
                } else {
                    // Puntaje menor o igual -> Ignorar la nueva señal
                    console.log(`[SAR] ⛔ Reversión Denegada para ${ticker}: Nueva señal ${oteData.direction} (Score: ${oteData.points}) no supera a la activa (Score: ${existingTradeForTicker.score}).`);
                    cleanupPrecreatedTrade();
                    if (state.lastGatillo) state.lastGatillo.status = 'BLOCKED_SAR_DENIED';
                    safeSet(state).catch(() => { });
                    if (!isBacktest) sendTelegramAlert(`⚠️ <b>SEÑAL DESCARTADA</b> | ${ticker}\n\nSe detectó una señal <b>${oteData.direction}</b> (Puntaje: ${oteData.points}), pero se mantiene la operación <b>${existingTradeForTicker.direction}</b> actual porque tiene mayor o igual convicción (Puntaje: ${existingTradeForTicker.score}).`).catch(() => { });
                    return;
                }
            }
        }

        const fingerprint = `OTE_${ticker}_${oteData.direction}_${oteData.tp1}`;
        console.log(`[SNIPER] 🔍 Verificando duplicado: ${fingerprint}`);
        if (!isDuplicate(fingerprint, nowMs)) {

            state.lastGatillo.status = 'PROCESANDO...';
            safeSet(state).catch((err: any) => console.error('[SNIPER] ❌ Fallo guardando estado (safeSet):', err?.message ?? err));

            let kronosAnnotation = '';
            let kronosVerdict: string = 'SKIP';
            let swarmAnnotation = '';
            let swarmConsensus: string = 'SKIP';
            let sessionId: string | undefined;

            if (isBacktest) {
                const { getCurrentSessionId } = await import('../services/backtesting.js');
                sessionId = getCurrentSessionId() || undefined;
            } else if (envConfig.KRONOS_AI_ENABLED) {
                let kronosRawDetails = '';
                // Kronos AI local (LSTM, sin quota externa) — off por default (sin backtest)
                try {
                    const { evaluateWithKronos } = await import('../services/kronos.js');
                    const kRes = await evaluateWithKronos(
                        ticker,
                        oteData.direction as 'BUY' | 'SELL',
                        Number(oteData.entryPrice),
                        Number(oteData.stopLoss),
                        Number(oteData.tp1)
                    );
                    kronosVerdict = (kRes as any).isConfirmed ? 'CONFIRMED' : 'DIVERGENCE';
                    kronosRawDetails = (kRes as any).rawDetails || (kRes as any).details || '';
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
                                consecutiveLosses: store.consecutiveLosses,
                                winRate: 0,
                                kronosVerdict: kronosVerdict,
                                kronosDetails: kronosRawDetails
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

            const config = getConfigForTicker(ticker, nowMs);
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
                session: getCurrentSession(nowMs),
                bias4H: state.marketBias['240'] === oteData.direction ? 'ALIGNED' : state.marketBias['240'] === 'NEUTRAL' ? 'NEUTRAL' : 'AGAINST',
                bias1H: state.marketBias['60'] === oteData.direction ? 'ALIGNED' : state.marketBias['60'] === 'NEUTRAL' ? 'NEUTRAL' : 'AGAINST',
                vwapDistance: (oteData.events.includes('VWAP_Premium') || oteData.events.includes('VWAP_Discount')) ? 1 : 0,
                tf: oteData.tf
            }).catch(() => 'ERR');

            // 🧠 REGISTRO EN ACTIVE TRADES SI ES ENTRADA DIRECTA (isChochEntry: true)
            let activeTrade = store.activeTrades.get(oteData.tradeId);
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
                    slHalfwayHit: false,
                    score: oteData.points || 0,
                    timestamp: nowMs, isBacktest: isBacktest
                };
                // 🆕 Congelar genes de gestión del gatillo en el trade (Firestore-safe: solo si existen)
                const oteMgmt = (oteData as any).mgmtOverrides;
                if (oteMgmt) activeTrade.mgmtOverrides = oteMgmt;
                store.activeTrades.set(oteData.tradeId, activeTrade);
                if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).set(activeTrade).catch(() => { });
                console.log(`[SNIPER] 💾 Registrado trade activo DIRECTO para ${ticker} #${oteData.tradeId}`);
            }

            if (journalId && journalId !== 'ERR' && journalId !== 'N/A') {
                activeTrade.journalId = journalId;
                // 💾 Actualizar el journalId en Firebase
                if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).update({ journalId }).catch(() => { });
            }

            // 🤖 cTrader: Send trade with confirmation buttons (semi-automatic mode)
            if (!isBacktest) {
                try {
                    const { config: globalConfig } = await import('../config.js');
                    const { sendTradeConfirmation } = await import('../services/ctrader_confirmation.js');
                    const ctraderConfigured = !!(globalConfig.CTRADER_CLIENT_ID && globalConfig.CTRADER_ACCESS_TOKEN);

                    if (ctraderConfigured) {
                        const recheckKillswitchesBeforeExecution = async (): Promise<string | null> => {
                            const nowLive = Date.now();
                            const cfg = getConfigForTicker(ticker, nowLive);
                            if (!cfg.sessionEnabled) return 'BLOCKED_SESSION';
                            if (store.globalKillswitches['GLOBAL_SYSTEM'] || store.globalKillswitches[ticker]) return 'BLOCKED_KILLSWITCH';
                            if (await evaluateGlobalKillswitch(nowLive, store, isBacktest)) return 'BLOCKED_GLOBAL';
                            if (await evaluateAssetKillswitch(ticker, nowLive, store, isBacktest)) return 'BLOCKED_ASSET';
                            if (nowLive < store.streakKillswitchUntil) return 'BLOCKED_RACHA';
                            if (nowLive < store.vixKillswitchUntil) return 'BLOCKED_VIX';
                            // 🌊 TickFlow: spread anómalo = probable noticia/iliquidez → no ejecutar
                            if (tickFlow.isSpreadAnomalous(ticker)) return 'BLOCKED_SPREAD';
                            return null;
                        };

                        const blockedBy = await recheckKillswitchesBeforeExecution();
                        if (blockedBy) {
                            console.log(`[KILLSWITCH] ⛔ TOCTOU Prevención: Ejecución bloqueada por ${blockedBy} para ${ticker}`);
                            if (state.lastGatillo) state.lastGatillo.status = blockedBy;
                            safeSet(state).catch(() => { });
                            store.activeTrades.delete(oteData.tradeId);
                            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
                            return;
                        }

                        if (store.dynamicBotConfig.autoTrading) {
                            // 🚀 MODO AUTOMÁTICO: Ejecutar directamente
                            const { executeMarketOrder } = await import('../services/ctrader.js');
                            const { config: envConfig } = await import('../config.js');
                            console.log(`[SNIPER] 🤖 Modo AUTO activado. Ejecutando ${ticker} inmediatamente...`);

                            const result = await executeMarketOrder({
                                ticker,
                                direction: oteData.direction as 'BUY' | 'SELL',
                                entryPrice: oteData.entryPrice,
                                slPrice: parseFloat(oteData.stopLoss),
                                tp1Price: parseFloat(oteData.tp1),
                                tp2Price: oteData.tp2 !== 'Buscando DOL macro...' ? parseFloat(oteData.tp2) : undefined,
                                tradeId: oteData.tradeId,
                                riskPercent: envConfig.CTRADER_RISK_PERCENT * (oteData.riskMult ?? 1), // 🆕 TimesFM F1: riesgo modulado
                            });

                            if (result.success && result.positionId) {
                                if (sarPendingClose) {
                                    try {
                                        if (sarPendingClose.ctraderPositionId) {
                                            const ctrader = await import('../services/ctrader.js');
                                            await ctrader.closePosition(sarPendingClose.ctraderPositionId);
                                        }
                                        store.activeTrades.delete(sarPendingClose.tradeId);
                                        if (db && !isBacktest) db.collection('active_trades').doc(sarPendingClose.tradeId).delete().catch(() => { });
                                        if (sarPendingClose.journalId) recordResult(sarPendingClose.journalId, 'REVERSAL').catch(() => { });
                                    } catch (e) {
                                        console.error('[SAR] Error cierre diferido automático:', e);
                                    }
                                }

                                updateTradePositionId(oteData.tradeId, result.positionId);
                                if (db && journalId) {
                                    if (!isBacktest) db.collection('trade_journal').doc(journalId).update({
                                        ctraderPositionId: result.positionId,
                                        ctraderLots: result.lots,
                                        ctraderExecutedPrice: result.executedPrice,
                                        ctraderStatus: 'EXECUTED',
                                        ctraderDemo: globalConfig.CTRADER_DEMO,
                                    }).catch(() => { });
                                }
                                const successMsg = `🚀 <b>AUTO-EJECUCIÓN EXITOSA</b>\n\n${msg}\n\n✅ <b>Ejecutado a:</b> ${result.executedPrice}\n🆔 <b>posID:</b> ${result.positionId}`;
                                await sendTelegramAlert(successMsg);
                            } else {
                                const errorMsg = `❌ <b>ERROR AUTO-EJECUCIÓN</b>\n\n${msg}\n\n⚠️ Error: ${result.error}`;
                                await sendTelegramAlert(errorMsg);
                            }
                        } else {
                            // ⏸️ MODO SEMI-AUTOMÁTICO: Enviar alerta WITH cTrader execution buttons
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
                                sarPendingClose,
                                riskMult: oteData.riskMult ?? 1, // 🆕 TimesFM F1
                            });
                            console.log(`[SNIPER] ✅ Alerta FRANCOTIRADOR + botones cTrader enviada para ${ticker}`);
                        }
                    } else {
                        // cTrader not configured — send normal alert (original behavior)
                        await sendTelegramAlert(msg);
                        console.log(`[SNIPER] ✅ Alerta FRANCOTIRADOR enviada (sin cTrader) para ${ticker}`);
                    }
                } catch (teleErr: any) {
                    // Fallback to normal alert if confirmation system fails
                    console.error(`[SNIPER] ⚠️ Error en sistema de confirmación, enviando alerta normal:`, teleErr.message);
                    try { await sendTelegramAlert(msg); } catch { }
                }
            } else {
                console.log(`[SNIPER] ⏭️ Modo backtest — alerta FRANCOTIRADOR NO enviada a Telegram`);
            }

            state.lastGatillo.status = 'ENVIADO';
            safeSet(state).catch(() => { });
        } else {
            console.log(`[SNIPER] ⚠️ DUPLICADO bloqueado: ${fingerprint}`);
            state.lastGatillo.status = 'DUPLICADO';
            safeSet(state).catch(() => { });

            // Limpiar si se pre-creó en evaluateImpulse (para OTE)
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
        }
    }

}