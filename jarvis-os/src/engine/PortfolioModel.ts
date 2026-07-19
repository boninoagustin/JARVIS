// PortfolioModel.ts - Lógica de control de riesgo global y de cuenta

export interface KillswitchResult {
    isKilled: boolean;
    killUntilMs?: number;
    killReason?: string;
}

export async function evaluateGlobalRisk(
    nowMs: number,
    globalPortfolioConfig: any,
    currentKillswitchUntil: number,
    currentSession: string,
    db: any
): Promise<KillswitchResult> {
    if (!globalPortfolioConfig.enabled) return { isKilled: false };

    if (globalPortfolioConfig.disabledSessions && globalPortfolioConfig.disabledSessions.includes(currentSession)) {
        return { isKilled: true, killReason: `Sesión actual (${currentSession}) está deshabilitada globalmente.` };
    }

    if (nowMs < currentKillswitchUntil) return { isKilled: true };
    if (!db) return { isKilled: false };

    try {
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now);
        const dateParts = argDateStr.split('-');
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1;
        const day = parseInt(dateParts[2]);

        const artMidnight = new Date(Date.UTC(year, month, day, 3, 0, 0));
        const artMidnightMs = artMidnight.getTime();

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

        if (isKilled) {
            const endOfDayMs = artMidnightMs + 24 * 60 * 60 * 1000 - 1000;
            return { isKilled: true, killUntilMs: endOfDayMs, killReason };
        }

        return { isKilled: false };
    } catch (e: any) {
        console.error('[PortfolioModel] Error evaluando el riesgo unificado:', e.message);
        return { isKilled: false };
    }
}

export async function countDailySellsForTicker(db: any, ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now);
        const dateParts = argDateStr.split('-');
        const artMidnightMs = new Date(Date.UTC(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]), 3, 0, 0)).getTime();

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', 'SELL')
            .get();

        return snapshot.docs.filter((d: any) => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
    } catch (e) {
        return 0;
    }
}

export async function countDailyBuysForTicker(db: any, ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now);
        const dateParts = argDateStr.split('-');
        const artMidnightMs = new Date(Date.UTC(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]), 3, 0, 0)).getTime();

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', 'BUY')
            .get();

        return snapshot.docs.filter((d: any) => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
    } catch (e) {
        return 0;
    }
}

export async function countConsecutiveLossesForAsset(db: any, ticker: string, session: string, direction: 'BUY' | 'SELL', nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now);
        const dateParts = argDateStr.split('-');
        const artMidnightMs = new Date(Date.UTC(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]), 3, 0, 0)).getTime();

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
        return streak;
    } catch (e) {
        return 0;
    }
}

