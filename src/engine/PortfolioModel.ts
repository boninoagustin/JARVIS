// PortfolioModel.ts - Lógica de control de riesgo global y de cuenta
import type { firestore } from 'firebase-admin';

import type { GlobalPortfolioConfig } from './Types.js';

export interface KillswitchResult {
    isKilled: boolean;
    killUntilMs?: number;
    killReason?: string;
}

// Caché mejorado que previene "race conditions" (estampidas de promesas)
const riskCache = new Map<string, { at: number; result?: any; promise?: Promise<any> }>();
const TTL = 30 * 1000; // 30s: suficiente anti-estampida, mínima ventana de bypass

export function invalidateRiskCache(prefix?: string): void {
    for (const key of riskCache.keys()) {
        if (!prefix || key.startsWith(prefix)) riskCache.delete(key);
    }
}


const NY_TZ = 'America/New_York';

/**
 * Offset UTC (ms) de un timezone en un instante dado. Negativo al oeste de Greenwich.
 * Usa Intl `longOffset` (ej. "GMT-04:00") para NO depender de la zona horaria del server.
 */
function getTimezoneOffsetMs(timeZone: string, atMs: number): number {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    const name = dtf.formatToParts(new Date(atMs)).find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3])) * 60000;
}

/**
 * Inicio del día FX (convención prop-firm / Funding Pips): las 17:00 de Nueva York.
 * El día de trading rota al cierre de la sesión NY, no a medianoche local. DST-aware.
 */
export function getFxDayStartMs(nowMs: number): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: NY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(nowMs));
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
    const year = get('year'), month = get('month'), day = get('day'), hour = get('hour');

    let fxYear = year, fxMonth = month, fxDay = day;
    if (hour < 17) {
        const prev = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
        prev.setUTCDate(prev.getUTCDate() - 1);
        fxYear = prev.getUTCFullYear(); fxMonth = prev.getUTCMonth() + 1; fxDay = prev.getUTCDate();
    }

    const offsetMs = getTimezoneOffsetMs(NY_TZ, Date.UTC(fxYear, fxMonth - 1, fxDay, 17, 0, 0));
    return Date.UTC(fxYear, fxMonth - 1, fxDay, 17, 0, 0) - offsetMs;
}

/**
 * Función genérica de caché con Mutex/Promesas para evitar queries duplicadas
 */
async function withCache<T>(key: string, nowMs: number, fetcher: () => Promise<T>, fallback: T): Promise<T> {
    const cached = riskCache.get(key);
    
    // 1. Si hay un resultado válido y no ha expirado, retornarlo de inmediato
    if (cached && cached.result !== undefined && nowMs - cached.at < TTL) {
        return cached.result;
    }
    
    // 2. Si hay una promesa en vuelo, esperarla
    if (cached && cached.promise) {
        try {
            return await cached.promise;
        } catch (e) {
            // Si la promesa falló, seguimos adelante para reintentar
        }
    }
    
    // 3. Crear la nueva promesa y guardarla en caché
    const promise = fetcher().then(result => {
        riskCache.set(key, { at: nowMs, result });
        return result;
    }).catch(err => {
        console.error(`[RISK] 🚨 Error leyendo trade_journal (key=${key}) — usando cache/fallback:`, err);
        // En caso de fallo, intentamos devolver el último valor conocido si existe, o el fallback
        const lastKnown = riskCache.get(key);
        const STALE_TOLERANCE = 5 * 60 * 1000;
        if (lastKnown?.result !== undefined && Date.now() - lastKnown.at < STALE_TOLERANCE) {
            return lastKnown.result;
        }
        return fallback;
    });
    
    riskCache.set(key, { at: nowMs, promise });
    return promise;
}

export async function evaluateGlobalRisk(
    nowMs: number,
    globalPortfolioConfig: GlobalPortfolioConfig,
    currentKillswitchUntil: number,
    currentSession: string,
    db: firestore.Firestore,
    isBacktest: boolean = false,
    backtestSessionId?: string
): Promise<KillswitchResult> {
    if (!globalPortfolioConfig.enabled) return { isKilled: false };

    if (globalPortfolioConfig.disabledSessions && globalPortfolioConfig.disabledSessions.includes(currentSession)) {
        return { isKilled: true, killReason: `Sesión actual (${currentSession}) está deshabilitada globalmente.` };
    }

    if (nowMs < currentKillswitchUntil) return { isKilled: true };
    if (!db) return { isKilled: false };

    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`global_${namespace}`, nowMs, async () => {
        const fxDayStartMs = getFxDayStartMs(nowMs);

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', fxDayStartMs - 48 * 60 * 60 * 1000)
            .get();

        if (snapshot.empty) return { isKilled: false } as KillswitchResult;

        // Limpieza de tipos 'any' utilizando as ActiveTrade
        const trades = snapshot.docs
            .map(d => d.data() as Record<string, any>)
            .filter(t => {
                const modeMatch = isBacktest ? t.mode === 'backtesting' : t.mode !== 'backtesting';
                const sessionMatch = isBacktest ? (backtestSessionId ? t.sessionId === backtestSessionId : true) : true;
                return modeMatch && sessionMatch && t.result;
            })
            .filter(t => (typeof t.closedAt === 'number' ? t.closedAt : t.timestamp) >= fxDayStartMs)
            .sort((a, b) => (a.closedAt ?? a.timestamp) - (b.closedAt ?? b.timestamp));

        let totalTrades = trades.length;
        let dailyPnLR = 0;
        let peakPnLR = 0;
        let consecutiveLosses = 0;
        let maxConsecutiveLosses = 0;

        for (const t of trades) {
            let rMultiple = Number(t.rMultiple);
            if (!Number.isFinite(rMultiple) || t.rMultiple == null) {
                if (t.result === 'WIN') rMultiple = globalPortfolioConfig.assumedWinR ?? 1.5;
                else if (t.result === 'LOSS') rMultiple = -1.0;
                else rMultiple = 0;
            }

            // Acumular crudo (redondeo solo al comparar/mostrar, no en cada acumulación)
            dailyPnLR += rMultiple;
            if (dailyPnLR > peakPnLR) peakPnLR = dailyPnLR;

            if (rMultiple < 0) {
                consecutiveLosses++;
                if (consecutiveLosses > maxConsecutiveLosses) maxConsecutiveLosses = consecutiveLosses;
            } else if (rMultiple > 0) {
                consecutiveLosses = 0;
            }
        }

        const trailingDrawdown = Math.round((peakPnLR - dailyPnLR) * 1000) / 1000;
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

        let result = { isKilled: false } as KillswitchResult;
        if (isKilled) {
            const endOfDayMs = getFxDayStartMs(fxDayStartMs + 30 * 60 * 60 * 1000) - 1000;
            result = { isKilled: true, killUntilMs: endOfDayMs, killReason };
        }

        return result;
    }, { isKilled: false, killReason: 'risk-data-unavailable (fail-open)' });
}

/** 🆕 Límites de riesgo POR ACTIVO (asset_configs/{ticker}) — espejo de evaluateGlobalRisk filtrado por ticker */
export interface AssetRiskLimits {
    maxDailyLossR?: number;
    dailyProfitTargetR?: number;
    maxTradesPerDay?: number;
    maxConsecutiveLosses?: number;
    trailingDrawdownR?: number;
}

export async function evaluateAssetRisk(
    db: firestore.Firestore,
    ticker: string,
    nowMs: number,
    limits: AssetRiskLimits,
    assumedWinR: number = 1.5,
    isBacktest: boolean = false,
    backtestSessionId?: string
): Promise<KillswitchResult> {
    const hasAnyLimit = (limits.maxDailyLossR ?? 0) > 0 || (limits.dailyProfitTargetR ?? 0) > 0 ||
        (limits.maxTradesPerDay ?? 0) > 0 || (limits.maxConsecutiveLosses ?? 0) > 0 || (limits.trailingDrawdownR ?? 0) > 0;
    if (!hasAnyLimit) return { isKilled: false };
    if (!db) return { isKilled: false };

    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`asset_${namespace}_${ticker}`, nowMs, async () => {
        const fxDayStartMs = getFxDayStartMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', fxDayStartMs - 48 * 60 * 60 * 1000)
            .get();

        if (snapshot.empty) return { isKilled: false } as KillswitchResult;

        const trades = snapshot.docs
            .map(d => d.data() as Record<string, any>)
            .filter(t => {
                const modeMatch = isBacktest ? t.mode === 'backtesting' : t.mode !== 'backtesting';
                const sessionMatch = isBacktest ? (backtestSessionId ? t.sessionId === backtestSessionId : true) : true;
                return modeMatch && sessionMatch && t.result && tickerVariants.includes(t.ticker);
            })
            .filter(t => (typeof t.closedAt === 'number' ? t.closedAt : t.timestamp) >= fxDayStartMs)
            .sort((a, b) => (a.closedAt ?? a.timestamp) - (b.closedAt ?? b.timestamp));

        let totalTrades = trades.length;
        let dailyPnLR = 0;
        let peakPnLR = 0;
        let consecutiveLosses = 0;
        let maxConsecutiveLosses = 0;

        for (const t of trades) {
            let rMultiple = Number(t.rMultiple);
            if (!Number.isFinite(rMultiple) || t.rMultiple == null) {
                if (t.result === 'WIN') rMultiple = assumedWinR;
                else if (t.result === 'LOSS') rMultiple = -1.0;
                else rMultiple = 0;
            }

            dailyPnLR += rMultiple;
            if (dailyPnLR > peakPnLR) peakPnLR = dailyPnLR;

            if (rMultiple < 0) {
                consecutiveLosses++;
                if (consecutiveLosses > maxConsecutiveLosses) maxConsecutiveLosses = consecutiveLosses;
            } else if (rMultiple > 0) {
                consecutiveLosses = 0;
            }
        }

        const trailingDrawdown = Math.round((peakPnLR - dailyPnLR) * 1000) / 1000;
        let isKilled = false;
        let killReason = '';

        if ((limits.maxDailyLossR ?? 0) > 0 && dailyPnLR <= -(limits.maxDailyLossR!)) {
            isKilled = true;
            killReason = `[${ticker}] Max Daily Loss superado (-${limits.maxDailyLossR}R | PnL: ${dailyPnLR.toFixed(2)}R)`;
        } else if ((limits.dailyProfitTargetR ?? 0) > 0 && dailyPnLR >= limits.dailyProfitTargetR!) {
            isKilled = true;
            killReason = `[${ticker}] Daily Profit Target alcanzado (+${limits.dailyProfitTargetR}R | PnL: ${dailyPnLR.toFixed(2)}R)`;
        } else if ((limits.maxTradesPerDay ?? 0) > 0 && totalTrades >= limits.maxTradesPerDay!) {
            isKilled = true;
            killReason = `[${ticker}] Max Trades per Day superado (${limits.maxTradesPerDay} trades | Realizados: ${totalTrades})`;
        } else if ((limits.maxConsecutiveLosses ?? 0) > 0 && maxConsecutiveLosses >= limits.maxConsecutiveLosses!) {
            isKilled = true;
            killReason = `[${ticker}] Max Consecutive Losses superado (${limits.maxConsecutiveLosses} | Racha: ${maxConsecutiveLosses})`;
        } else if ((limits.trailingDrawdownR ?? 0) > 0 && trailingDrawdown >= limits.trailingDrawdownR!) {
            isKilled = true;
            killReason = `[${ticker}] Trailing Drawdown superado (${limits.trailingDrawdownR}R | Drawdown: ${trailingDrawdown.toFixed(2)}R)`;
        }

        let result = { isKilled: false } as KillswitchResult;
        if (isKilled) {
            const endOfDayMs = getFxDayStartMs(fxDayStartMs + 30 * 60 * 60 * 1000) - 1000;
            result = { isKilled: true, killUntilMs: endOfDayMs, killReason };
        }

        return result;
    }, { isKilled: false, killReason: `[${ticker}] asset-risk-data-unavailable (fail-open)` });
}

export async function countDailySellsForTicker(db: firestore.Firestore, ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    
    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`sells_${namespace}_${ticker}`, nowMs, async () => {
        const fxDayStartMs = getFxDayStartMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', fxDayStartMs)
            .where('direction', '==', 'SELL')
            .get();

        const result = snapshot.docs.filter(d => {
            const data = d.data() as Record<string, any>;
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
        
        return result;
    }, 0); // 0 = fail open
}

export async function countDailyBuysForTicker(db: firestore.Firestore, ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    
    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`buys_${namespace}_${ticker}`, nowMs, async () => {
        const fxDayStartMs = getFxDayStartMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', fxDayStartMs)
            .where('direction', '==', 'BUY')
            .get();

        const result = snapshot.docs.filter(d => {
            const data = d.data() as Record<string, any>;
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
        
        return result;
    }, 0);
}

export async function countConsecutiveLossesForAsset(db: firestore.Firestore, ticker: string, session: string, direction: 'BUY' | 'SELL', nowMs: number, globalPortfolioConfig: GlobalPortfolioConfig, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    
    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`streak_${namespace}_${ticker}_${session}_${direction}`, nowMs, async () => {
        const fxDayStartMs = getFxDayStartMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', fxDayStartMs)
            .where('direction', '==', direction)
            .get();

        if (snapshot.empty) return 0;

        const trades = snapshot.docs
            .map(d => d.data() as Record<string, any>)
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
            if (!Number.isFinite(rMultiple) || t.rMultiple == null) {
                if (t.result === 'WIN') rMultiple = globalPortfolioConfig.assumedWinR ?? 1.5;
                else if (t.result === 'LOSS') rMultiple = -1.0;
                else rMultiple = 0;
            }

            if (rMultiple < 0) streak++;
            else if (rMultiple > 0) streak = 0;
        }
        
        return streak;
    }, 0);
}
