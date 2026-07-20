// PortfolioModel.ts - Lógica de control de riesgo global y de cuenta
import type { firestore } from 'firebase-admin';

import { GlobalPortfolioConfig } from './Types.js';

export interface KillswitchResult {
    isKilled: boolean;
    killUntilMs?: number;
    killReason?: string;
}

const riskCache = new Map<string, { at: number; result: any }>();
const TTL = 5 * 60 * 1000;


function getArgentinaMidnightMs(nowMs: number): number {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
    const [year, month, day] = formatter.format(new Date(nowMs)).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 3, 0, 0)).getTime();
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

    try {
        const artMidnightMs = getArgentinaMidnightMs(nowMs);

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .get();

        if (snapshot.empty) return { isKilled: false };

        const trades = snapshot.docs
            .map((d: any) => d.data())
            .filter((t: any) => t.mode !== 'backtesting' && t.result)
            .sort((a: any, b: any) => a.timestamp - b.timestamp);

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

            dailyPnLR += rMultiple;
            if (dailyPnLR > peakPnLR) peakPnLR = dailyPnLR;

            if (rMultiple < 0) {
                consecutiveLosses++;
                if (consecutiveLosses > maxConsecutiveLosses) maxConsecutiveLosses = consecutiveLosses;
            } else if (rMultiple > 0) {
                consecutiveLosses = 0;
            }
        }

        const trailingDrawdown = peakPnLR - dailyPnLR;
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

        riskCache.set('global', { at: nowMs, result });
        return result;
    } catch (e: any) {
        console.error('[PortfolioModel] Error evaluando el riesgo unificado:', e.message);
        const c = riskCache.get('global');
        if (c && nowMs - c.at < TTL) return c.result;
        return { isKilled: true, killReason: 'risk-data-unavailable: límites en fail-closed' };
    }
}

export async function countDailySellsForTicker(db: firestore.Firestore, ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const artMidnightMs = getArgentinaMidnightMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', 'SELL')
            .get();

        const result = snapshot.docs.filter((d: any) => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
        riskCache.set(`sells_${ticker}`, { at: nowMs, result });
        return result;
    } catch (e) {
        const c = riskCache.get(`sells_${ticker}`);
        if (c && nowMs - c.at < TTL) return c.result;
        return 999; // fail closed if no cache
    }
}

export async function countDailyBuysForTicker(db: firestore.Firestore, ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const artMidnightMs = getArgentinaMidnightMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', 'BUY')
            .get();

        const result = snapshot.docs.filter((d: any) => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
        riskCache.set(`buys_${ticker}`, { at: nowMs, result });
        return result;
    } catch (e) {
        const c = riskCache.get(`buys_${ticker}`);
        if (c && nowMs - c.at < TTL) return c.result;
        return 999; // fail closed if no cache
    }
}

export async function countConsecutiveLossesForAsset(db: firestore.Firestore, ticker: string, session: string, direction: 'BUY' | 'SELL', nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const artMidnightMs = getArgentinaMidnightMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', direction)
            .get();

        if (snapshot.empty) return 0;

        const trades = snapshot.docs
            .map((d: any) => d.data())
            .filter((t: any) => {
                const isMatchingTicker = tickerVariants.includes(t.ticker);
                const isMatchingSession = t.session === session;
                const modeMatch = isBacktest ? t.mode === 'backtesting' : t.mode !== 'backtesting';
                const sessionMatch = isBacktest ? (backtestSessionId ? t.sessionId === backtestSessionId : true) : true;
                return modeMatch && sessionMatch && isMatchingTicker && isMatchingSession && t.result;
            })
            .sort((a: any, b: any) => a.timestamp - b.timestamp);

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
        riskCache.set(`streak_${ticker}_${session}_${direction}`, { at: nowMs, result: streak });
        return streak;
    } catch (e) {
        const c = riskCache.get(`streak_${ticker}_${session}_${direction}`);
        if (c && nowMs - c.at < TTL) return c.result;
        return 999; // fail closed if no cache
    }
}

