// PortfolioModel.ts - Lógica de control de riesgo global y de cuenta
import type { firestore } from 'firebase-admin';

import type { GlobalPortfolioConfig, ActiveTrade } from './Types.js';

export interface KillswitchResult {
    isKilled: boolean;
    killUntilMs?: number;
    killReason?: string;
}

// Caché mejorado que previene "race conditions" (estampidas de promesas)
const riskCache = new Map<string, { at: number; result?: any; promise?: Promise<any> }>();
const TTL = 5 * 60 * 1000;


function getArgentinaMidnightMs(nowMs: number): number {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
    const [year, month, day] = formatter.format(new Date(nowMs)).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 3, 0, 0)).getTime();
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
        // En caso de fallo, intentamos devolver el último valor conocido si existe, o el fallback
        const lastKnown = riskCache.get(key);
        if (lastKnown && lastKnown.result !== undefined) {
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
    db: firestore.Firestore
): Promise<KillswitchResult> {
    if (!globalPortfolioConfig.enabled) return { isKilled: false };

    if (globalPortfolioConfig.disabledSessions && globalPortfolioConfig.disabledSessions.includes(currentSession)) {
        return { isKilled: true, killReason: `Sesión actual (${currentSession}) está deshabilitada globalmente.` };
    }

    if (nowMs < currentKillswitchUntil) return { isKilled: true };
    if (!db) return { isKilled: false };

    return withCache('global', nowMs, async () => {
        const artMidnightMs = getArgentinaMidnightMs(nowMs);

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .get();

        if (snapshot.empty) return { isKilled: false } as KillswitchResult;

        // Limpieza de tipos 'any' utilizando as ActiveTrade
        const trades = snapshot.docs
            .map(d => d.data() as Record<string, any>)
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
                if (t.result === 'WIN') rMultiple = 1.5;
                else if (t.result === 'LOSS') rMultiple = -1.0;
                else rMultiple = 0;
            }

            // Corrección de punto flotante
            dailyPnLR = Math.round((dailyPnLR + rMultiple) * 1000) / 1000;
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
            const endOfDayMs = artMidnightMs + 24 * 60 * 60 * 1000 - 1000;
            result = { isKilled: true, killUntilMs: endOfDayMs, killReason };
        }

        return result;
    }, { isKilled: true, killReason: 'risk-data-unavailable: límites en fail-closed' });
}

export async function countDailySellsForTicker(db: firestore.Firestore, ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    
    return withCache(`sells_${ticker}`, nowMs, async () => {
        const artMidnightMs = getArgentinaMidnightMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', 'SELL')
            .get();

        const result = snapshot.docs.filter(d => {
            const data = d.data() as Record<string, any>;
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
        
        return result;
    }, 999); // 999 = fail closed
}

export async function countDailyBuysForTicker(db: firestore.Firestore, ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    
    return withCache(`buys_${ticker}`, nowMs, async () => {
        const artMidnightMs = getArgentinaMidnightMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', 'BUY')
            .get();

        const result = snapshot.docs.filter(d => {
            const data = d.data() as Record<string, any>;
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
        
        return result;
    }, 999);
}

export async function countConsecutiveLossesForAsset(db: firestore.Firestore, ticker: string, session: string, direction: 'BUY' | 'SELL', nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    
    return withCache(`streak_${ticker}_${session}_${direction}`, nowMs, async () => {
        const artMidnightMs = getArgentinaMidnightMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
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
            if (isNaN(rMultiple) || rMultiple === undefined) {
                if (t.result === 'WIN') rMultiple = 1.5;
                else if (t.result === 'LOSS') rMultiple = -1.0;
                else rMultiple = 0;
            }

            if (rMultiple < 0) streak++;
            else if (rMultiple > 0) streak = 0;
        }
        
        return streak;
    }, 999);
}
