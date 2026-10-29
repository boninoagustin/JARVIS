// PortfolioModel.ts - Lógica de control de riesgo global y de cuenta
import type { firestore } from 'firebase-admin';

import type { GlobalPortfolioConfig } from './Types.js';
import { computeTradeRiskR } from './TradeRisk.js';

export interface KillswitchResult {
    isKilled: boolean;
    killUntilMs?: number;
    killReason?: string;
    /** Data safety hold: blocks new entries, never requests position closure or a day latch. */
    riskDataStatus?: 'held';
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

// Live journal.closedAt is ISO in broker reconciliation and epoch-ms in older writers.
// Never use the entry timestamp as evidence of when a live position closed.
function dataHold(killReason: string): KillswitchResult {
    return { isKilled: true, riskDataStatus: 'held', killReason };
}

function uniquePositions(rows: Record<string, any>[], verifyClosures = false): { rows: Record<string, any>[]; conflict: boolean } {
    const unique: Record<string, any>[] = [];
    const seen = new Map<string, Record<string, any>>();
    const fingerprint = (t: Record<string, any>) => JSON.stringify([t.ticker, t.direction, closeTimeMs(t.closedAt),
        t.result, sanitizeRMultiple(t.rMultiple, t.result, 0), t.riskAccountingStatus ?? null, t.riskAccountingProvenance ?? null]);
    for (const t of rows) {
        const key = t.ctraderPositionId != null ? `broker:${t.ctraderPositionId}`
            : t.tradeId ? `trade:${t.tradeId}` : t.journalId ? `journal:${t.journalId}` : undefined;
        const previous = key ? seen.get(key) : undefined;
        if (previous) {
            if (verifyClosures && fingerprint(previous) !== fingerprint(t)) return { rows: [], conflict: true };
            continue;
        }
        if (key) seen.set(key, t);
        unique.push(t);
    }
    return { rows: unique, conflict: false };
}

function hasUnverifiedAccounting(t: Record<string, any>): boolean {
    if (t.riskAccountingStatus !== 'VERIFIED' || t.riskAccountingProvenance !== 'broker_fill') return true;
    const s = t.riskSnapshot;
    if (computeTradeRiskR(0, s) === null || s.ticker !== t.ticker || s.direction !== t.direction ||
        s.currency !== t.accountCurrency || s.riskAmountAccount !== t.riskAmountAccount) return true;
    const computed = computeTradeRiskR(t.ctrader_real_pnl, s);
    const saved = sanitizeRMultiple(t.rMultiple, t.result, 0);
    return computed === null || !Number.isFinite(saved) || Math.abs(computed - saved) > Math.max(1, Math.abs(computed)) * 1e-12;
}

/** Pending execution/accounting is an entry-only hold, including records with no result. */
export function hasPendingExecutionIncident(t: Record<string, any>, canonical?: Record<string, any>, nowMs = Date.now()): boolean {
    if (t.mode === 'backtesting' || t.isBacktest) return false;
    // Explicit incidents are independent obligations, never erased by a duplicate marker.
    if (t.executionUncertain === true || t.executionIncidentPending === true || t.closeAccountingPending === true ||
        t.executionFillUnverified === true || t.ctraderStatus === 'EXECUTION_PENDING_RECONCILIATION') return true;
    if (t.duplicateOf && (t.ctraderPositionId != null || t.ctraderStatus === 'EXECUTED')) {
        // Only the journal snapshot's exact document reference can certify a derivative
        // open duplicate. A marker alone (including chains/cycles) is not close evidence.
        if (!canonical || canonical.duplicateOf || canonical.mode === 'backtesting' || canonical.isBacktest ||
            !isRealizedTrade(canonical) || hasPendingExecutionIncident(canonical) || hasUnverifiedAccounting(canonical) ||
            canonical.closedAtSource !== 'broker_execution' || !Number.isFinite(closeTimeMs(canonical.closedAt)) ||
            closeTimeMs(canonical.closedAt) > nowMs || t.ctraderPositionId == null || canonical.ctraderPositionId == null ||
            String(t.ctraderPositionId) !== String(canonical.ctraderPositionId) || t.ticker !== canonical.ticker || t.direction !== canonical.direction) return true;
        if (t.riskAccountingStatus === 'INVALID' ||
            ['accountCurrency', 'riskAmountAccount', 'result', 'rMultiple', 'ctrader_real_pnl'].some(key => t[key] != null && t[key] !== canonical[key])) return true;
        if (t.riskSnapshot != null && (computeTradeRiskR(0, t.riskSnapshot) === null ||
            Object.keys(canonical.riskSnapshot).some(key => t.riskSnapshot[key] !== canonical.riskSnapshot[key]))) return true;
        return false; // Suppress only the missing-risk derivative; canonical risk still counts normally.
    }
    return !isRealizedTrade(t) && (t.ctraderPositionId != null || t.ctraderStatus === 'EXECUTED') &&
        (t.riskAccountingStatus !== 'VERIFIED' || computeTradeRiskR(0, t.riskSnapshot) === null ||
            t.riskSnapshot?.ticker !== t.ticker || t.riskSnapshot?.direction !== t.direction ||
            t.accountCurrency !== t.riskSnapshot?.currency);
}

function isRealizedTrade(t: Record<string, any>): boolean {
    return !t.duplicateOf && t.ctraderStatus !== 'ABORTED' &&
        ['WIN', 'LOSS', 'BREAKEVEN'].includes(t.result);
}

function closeTimeMs(value: unknown): number {
    if (typeof value === 'number') return new Date(value).getTime();
    if (typeof value !== 'string') return NaN;
    // Require a zoned ISO instant, not locale-dependent text or Date.parse's normalized Feb 30.
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/);
    if (!m) return NaN;
    const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (date.getUTCMonth() + 1 !== Number(m[2]) || date.getUTCDate() !== Number(m[3]) ||
        Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59 ||
        Number(m[7] ?? 0) > 23 || Number(m[8] ?? 0) > 59) return NaN;
    return Date.parse(value);
}

function unknownCloseTimeReason(rows: Record<string, any>[], fxDayStartMs: number): string | undefined {
    const unknown = rows.find(t => t.mode !== 'backtesting' && isRealizedTrade(t) &&
        !(Number.isFinite(closeTimeMs(t.closedAt)) && closeTimeMs(t.closedAt) < fxDayStartMs) &&
        (!Number.isFinite(closeTimeMs(t.closedAt)) || (t.closedAtSource != null && t.closedAtSource !== 'broker_execution')));
    if (!unknown) return undefined;
    if (unknown.closedAtSource != null && unknown.closedAtSource !== 'broker_execution') return 'risk-data-unverified:close-time:provenance';
    // No live entry-date fallback: legacy closure day cannot be proven. Hold until repaired.
    return unknown.closedAt == null
        ? 'risk-data-unverified:close-time:legacy-closure-time-unknown'
        : 'risk-data-unverified:close-time:invalid';
}

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
async function withCache<T>(key: string, nowMs: number, fetcher: () => Promise<T>, fallback: T, liveGate = false): Promise<T> {
    const cached = riskCache.get(key);
    const age = cached ? nowMs - cached.at : Infinity;
    if (cached?.result !== undefined && age >= 0 && age < TTL) return cached.result;
    if (cached?.promise) return cached.promise;

    const promise = fetcher().then(result => {
        // An invalidated in-flight read must not repopulate the cache.
        if (riskCache.get(key)?.promise === promise) riskCache.set(key, { at: nowMs, result });
        return result;
    }).catch(err => {
        console.error(`[RISK] Error leyendo trade_journal (key=${key}) — ${liveGate ? 'new entries held' : 'legacy fallback'}:`, err);
        if (riskCache.get(key)?.promise === promise) riskCache.delete(key);
        // Never let an expired 'allow' result bypass a live data outage.
        if (!liveGate && cached?.result !== undefined && age >= 0 && age < 5 * 60 * 1000) return cached.result;
        return fallback;
    });
    riskCache.set(key, { at: nowMs, promise });
    return promise;
}

/**
 * Live: accept finite journal R (including legacy numeric strings); unknown is NaN, not credit.
 * No magnitude/result clamp: legitimate large R must retain its monetary meaning.
 * BACKTEST ONLY: preserve the historical result fallback, BE clamp and |R| > 10 clamp.
 */
export function sanitizeRMultiple(rawR: unknown, result: string | undefined, assumedWinR: number, isBacktest = false): number {
    if (!isBacktest) {
        if (typeof rawR !== 'number' && !(typeof rawR === 'string' && rawR.trim() !== '')) return NaN;
        const r = Number(rawR);
        return Number.isFinite(r) ? r : NaN;
    }
    // Explicit backtest-only compatibility: historical result-based estimates and clamps.
    let rMultiple = Number(rawR);
    if (!Number.isFinite(rMultiple) || rawR == null) {
        if (result === 'WIN') rMultiple = assumedWinR;
        else if (result === 'LOSS') rMultiple = -1.0;
        else rMultiple = 0;
    } else if (result === 'BREAKEVEN' && (rMultiple < -0.5 || rMultiple > 0.5)) {
        rMultiple = 0;
    } else if (Math.abs(rMultiple) > 10) {
        if (result === 'WIN') rMultiple = assumedWinR;
        else if (result === 'LOSS') rMultiple = -1.0;
        else rMultiple = 0;
    }
    return rMultiple;
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
    if (isBacktest && !globalPortfolioConfig.enabled) return { isKilled: false };

    if (globalPortfolioConfig.enabled && globalPortfolioConfig.disabledSessions && globalPortfolioConfig.disabledSessions.includes(currentSession)) {
        return { isKilled: true, killReason: `Sesión actual (${currentSession}) está deshabilitada globalmente.` };
    }

    if (globalPortfolioConfig.enabled && nowMs < currentKillswitchUntil) return { isKilled: true };
    if (!db) return isBacktest ? { isKilled: false } : dataHold('risk-data-unavailable');

    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`global_${namespace}${isBacktest ? '' : `_${getFxDayStartMs(nowMs)}_${JSON.stringify(globalPortfolioConfig)}`}`, nowMs, async () => {
        const fxDayStartMs = getFxDayStartMs(nowMs);

        // A live position can close today after opening arbitrarily long ago. Mixed
        // ISO/epoch close times cannot share a Firestore range query; do not truncate by entry.
        const journal = db.collection('trade_journal');
        const snapshot = await (isBacktest
            ? journal.where('timestamp', '>=', fxDayStartMs - 48 * 60 * 60 * 1000)
            : journal).get();

        if (snapshot.empty) return { isKilled: false } as KillswitchResult;

        if (!isBacktest) {
            const journalRows = new Map(snapshot.docs.map(d => [d.id, d.data()]));
            if ([...journalRows.values()].some(t => hasPendingExecutionIncident(t, journalRows.get(t.duplicateOf), nowMs))) return dataHold('risk-data-unverified:execution-incident');
            const reason = unknownCloseTimeReason(snapshot.docs.map(d => d.data()), fxDayStartMs);
            if (reason) return dataHold(reason);
        }

        let trades = snapshot.docs
            .map(d => d.data() as Record<string, any>)
            .filter(t => {
                const modeMatch = isBacktest ? t.mode === 'backtesting' : t.mode !== 'backtesting';
                const sessionMatch = isBacktest ? (backtestSessionId ? t.sessionId === backtestSessionId : true) : true;
                return modeMatch && sessionMatch && t.result && (isBacktest || isRealizedTrade(t));
            })
            .filter(t => isBacktest
                ? (typeof t.closedAt === 'number' ? t.closedAt : t.timestamp) >= fxDayStartMs
                : closeTimeMs(t.closedAt) >= fxDayStartMs && closeTimeMs(t.closedAt) <= nowMs)
            .sort((a, b) => isBacktest
                ? (a.closedAt ?? a.timestamp) - (b.closedAt ?? b.timestamp)
                : closeTimeMs(a.closedAt) - closeTimeMs(b.closedAt));

        if (!isBacktest) {
            const unique = uniquePositions(trades, true);
            if (unique.conflict) return dataHold('risk-data-unverified:duplicate-conflict');
            trades = unique.rows;
        }
        const totalTrades = trades.length;
        let dailyPnLR = 0;
        let peakPnLR = 0;
        let consecutiveLosses = 0;
        let maxConsecutiveLosses = 0;

        for (const t of trades) {
            if (!isBacktest && hasUnverifiedAccounting(t)) return dataHold('risk-data-unverified:accounting');
            const rMultiple = sanitizeRMultiple(t.rMultiple, t.result, globalPortfolioConfig.assumedWinR ?? 1.5, isBacktest);
            if (!isBacktest && !Number.isFinite(rMultiple)) return dataHold('risk-data-unverified:rMultiple');

            // Acumular crudo (redondeo solo al comparar/mostrar, no en cada acumulación)
            dailyPnLR += rMultiple;
            if (!isBacktest && !Number.isFinite(dailyPnLR)) return dataHold('risk-data-unverified:nonfinite-total');
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

        // Live accounting safety is independent from disabled strategy thresholds.
        if (!globalPortfolioConfig.enabled) return { isKilled: false };
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
    }, isBacktest ? { isKilled: false, killReason: 'risk-data-unavailable (backtest legacy fail-open)' }
        : dataHold('risk-data-unavailable'), !isBacktest);
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
    if (isBacktest && !hasAnyLimit) return { isKilled: false };
    if (!db) return isBacktest ? { isKilled: false } : dataHold(`[${ticker}] asset-risk-data-unavailable`);

    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`asset_${namespace}_${ticker}${isBacktest ? '' : `_${getFxDayStartMs(nowMs)}_${JSON.stringify(limits)}`}`, nowMs, async () => {
        const fxDayStartMs = getFxDayStartMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        // A live position can close today after opening arbitrarily long ago. Mixed
        // ISO/epoch close times cannot share a Firestore range query; do not truncate by entry.
        const journal = db.collection('trade_journal');
        const snapshot = await (isBacktest
            ? journal.where('timestamp', '>=', fxDayStartMs - 48 * 60 * 60 * 1000)
            : journal).get();

        if (snapshot.empty) return { isKilled: false } as KillswitchResult;

        if (!isBacktest) {
            const journalRows = new Map(snapshot.docs.map(d => [d.id, d.data()]));
            if ([...journalRows.values()].some(t => hasPendingExecutionIncident(t, journalRows.get(t.duplicateOf), nowMs))) return dataHold(`[${ticker}] risk-data-unverified:execution-incident`);
            const reason = unknownCloseTimeReason(snapshot.docs.map(d => d.data()).filter(t => tickerVariants.includes(t.ticker)), fxDayStartMs);
            if (reason) return dataHold(`[${ticker}] ${reason}`);
        }

        let trades = snapshot.docs
            .map(d => d.data() as Record<string, any>)
            .filter(t => {
                const modeMatch = isBacktest ? t.mode === 'backtesting' : t.mode !== 'backtesting';
                const sessionMatch = isBacktest ? (backtestSessionId ? t.sessionId === backtestSessionId : true) : true;
                return modeMatch && sessionMatch && t.result && tickerVariants.includes(t.ticker) && (isBacktest || isRealizedTrade(t));
            })
            .filter(t => isBacktest
                ? (typeof t.closedAt === 'number' ? t.closedAt : t.timestamp) >= fxDayStartMs
                : closeTimeMs(t.closedAt) >= fxDayStartMs && closeTimeMs(t.closedAt) <= nowMs)
            .sort((a, b) => isBacktest
                ? (a.closedAt ?? a.timestamp) - (b.closedAt ?? b.timestamp)
                : closeTimeMs(a.closedAt) - closeTimeMs(b.closedAt));

        if (!isBacktest) {
            const unique = uniquePositions(trades, true);
            if (unique.conflict) return dataHold('risk-data-unverified:duplicate-conflict');
            trades = unique.rows;
        }
        const totalTrades = trades.length;
        let dailyPnLR = 0;
        let peakPnLR = 0;
        let consecutiveLosses = 0;
        let maxConsecutiveLosses = 0;

        for (const t of trades) {
            if (!isBacktest && hasUnverifiedAccounting(t)) return dataHold('risk-data-unverified:accounting');
            const rMultiple = sanitizeRMultiple(t.rMultiple, t.result, assumedWinR, isBacktest);
            if (!isBacktest && !Number.isFinite(rMultiple)) return dataHold(`[${ticker}] risk-data-unverified:rMultiple`);

            dailyPnLR += rMultiple;
            if (!isBacktest && !Number.isFinite(dailyPnLR)) return dataHold('risk-data-unverified:nonfinite-total');
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
    }, isBacktest ? { isKilled: false, killReason: `[${ticker}] asset-risk-data-unavailable (backtest legacy fail-open)` }
        : dataHold(`[${ticker}] asset-risk-data-unavailable`), !isBacktest);
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

        const entries = snapshot.docs.map(d => d.data() as Record<string, any>).filter(data => {
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            // This is an ENTRY counter: a still-open trade/partial counts, a rejection does not.
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker) && (isBacktest ||
                (!data.duplicateOf && data.ctraderStatus !== 'ABORTED' && data.result !== 'SKIP' && data.result !== 'ABORTED' &&
                    typeof data.timestamp === 'number' && Number.isFinite(data.timestamp) && data.timestamp <= nowMs));
        });
        return isBacktest ? entries.length : uniquePositions(entries).rows.length;
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

        const entries = snapshot.docs.map(d => d.data() as Record<string, any>).filter(data => {
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            // This is an ENTRY counter: a still-open trade/partial counts, a rejection does not.
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker) && (isBacktest ||
                (!data.duplicateOf && data.ctraderStatus !== 'ABORTED' && data.result !== 'SKIP' && data.result !== 'ABORTED' &&
                    typeof data.timestamp === 'number' && Number.isFinite(data.timestamp) && data.timestamp <= nowMs));
        });
        return isBacktest ? entries.length : uniquePositions(entries).rows.length;
    }, 0);
}

export async function countConsecutiveLossesForAsset(db: firestore.Firestore, ticker: string, session: string, direction: 'BUY' | 'SELL', nowMs: number, globalPortfolioConfig: GlobalPortfolioConfig, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    
    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`streak_${namespace}_${ticker}_${session}_${direction}`, nowMs, async () => {
        const fxDayStartMs = getFxDayStartMs(nowMs);

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const journal = db.collection('trade_journal');
        const snapshot = await (isBacktest ? journal.where('timestamp', '>=', fxDayStartMs) : journal)
            .where('direction', '==', direction).get();

        if (snapshot.empty) return 0;
        if (!isBacktest) {
            // Closed-risk counter, not an entry counter. Unknowns cannot reset a known loss streak;
            // the live risk gates carry the explicit safety hold (this compatibility API is numeric).
            const closed = snapshot.docs.map(d => d.data()).filter(t => t.mode !== 'backtesting' &&
                tickerVariants.includes(t.ticker) && t.session === session && isRealizedTrade(t) &&
                closeTimeMs(t.closedAt) >= fxDayStartMs && closeTimeMs(t.closedAt) <= nowMs)
                .sort((a, b) => closeTimeMs(a.closedAt) - closeTimeMs(b.closedAt));
            let streak = 0;
            for (const t of uniquePositions(closed).rows) {
                if (hasUnverifiedAccounting(t)) continue;
                const r = sanitizeRMultiple(t.rMultiple, t.result, 0);
                if (r < 0) streak++;
                else if (r > 0) streak = 0;
            }
            return streak;
        }
        // BACKTEST: retain entry-time ordering and result fallback, intentionally not live-aligned.

        let trades = snapshot.docs
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
