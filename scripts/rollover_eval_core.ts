/** Pure, descriptive rollover evidence. No trading, Firestore or listeners. */
export const M5_MS = 5 * 60_000;
export const CUT = Date.parse('2026-09-14T03:00:00Z');
export interface BidBar { ts: number; low: number; high: number }
export function parseTimestamp(value: any): number | null {
    let result: unknown = null;
    try {
        if (typeof value === 'number') result = value;
        else if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) result = Date.parse(value);
        else if (value instanceof Date) result = value.getTime();
        else if (value && typeof value.toMillis === 'function') result = value.toMillis();
        else if (value && typeof (value.seconds ?? value._seconds) === 'number') {
            result = (value.seconds ?? value._seconds) * 1000 + (value.nanoseconds ?? value._nanoseconds ?? 0) / 1e6;
        }
    } catch { return null; }
    return typeof result === 'number' && Number.isFinite(result) && result > 0 && Number.isFinite(new Date(result).getTime()) ? result : null;
}
export interface ClosedTrade {
    key: string; ticker: string; direction: 'BUY' | 'SELL'; openedAt: number; closedAt: number; initialSlPrice: number;
}
export function normalizeTrade(raw: any, evaluatedAt: number): { trade?: ClosedTrade; reason?: string } {
    const closedAt = parseTimestamp(raw.closedAt) ?? parseTimestamp(raw.closedAtISO);
    if (closedAt === null) return { reason: 'missing_or_invalid_close' };
    if (raw.initialSlPrice == null || !Number.isFinite(Number(raw.initialSlPrice)) || Number(raw.initialSlPrice) <= 0) {
        return { reason: 'missing_original_stop' };
    }
    const openedAt = parseTimestamp(raw.timestamp);
    if (openedAt === null) return { reason: 'missing_or_invalid_open' };
    if (closedAt <= openedAt) return { reason: 'invalid_lifetime' };
    if (closedAt > evaluatedAt) return { reason: 'close_in_future' };
    if (raw.direction !== 'BUY' && raw.direction !== 'SELL') return { reason: 'invalid_direction' };
    const identity = raw.ctraderPositionId ?? raw.id ?? raw.journalId;
    if (identity == null || String(identity).trim() === '') return { reason: 'missing_identity' };
    if (typeof raw.ticker !== 'string' || !raw.ticker.trim() || raw.ticker === '_GLOBAL') return { reason: 'invalid_ticker' };
    const entry = Number(raw.entryPrice), sl = Number(raw.initialSlPrice);
    if (!Number.isFinite(entry) || entry <= 0 || (raw.direction === 'BUY' ? sl >= entry : sl <= entry)) {
        return { reason: 'invalid_original_stop' };
    }
    return { trade: {
        key: `${raw.ctraderAccountId ?? ''}:${identity}`, ticker: raw.ticker, direction: raw.direction,
        openedAt, closedAt, initialSlPrice: sl,
    } };
}
export interface CalendarEvidence {
    metadataAvailable: boolean; scheduleTimeZone: string | null;
    pauseStartMs: number | null; reopenMs: number | null; periodKey: string | null;
}
export type CalendarResolver = (ticker: string, nowMs: number) => CalendarEvidence;
export interface ObservationWindow { key: string; start: number; end: number; timeZone: string }
/** Observation spans protection start (-9m) through earliest restoration (+15m).
 * These are descriptive sampling bounds, NOT a counterfactual execution model.
 */
export function tradeWindows(trade: ClosedTrade, getCalendar: CalendarResolver): { windows: ObservationWindow[]; reason?: string } {
    const dayMs = 86_400_000;
    const windows = new Map<string, ObservationWindow>();
    for (let day = Math.floor(trade.openedAt / dayMs) * dayMs; day <= trade.closedAt; day += dayMs) {
        // Query the calendar backwards from each UTC date boundary, then before
        // that pause's eligibility (-9m). This also finds multiple intraday gaps.
        let probe = day + dayMs - 1;
        while (probe >= day) {
            const calendar = getCalendar(trade.ticker, probe);
            if (!calendar.metadataAvailable) return { windows: [], reason: 'calendar_unresolved' };
            if (calendar.pauseStartMs === null || calendar.reopenMs === null || !calendar.periodKey || !calendar.scheduleTimeZone) break;
            const start = calendar.pauseStartMs - 9 * 60_000;
            const end = calendar.reopenMs + 15 * 60_000;
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start > probe) break;
            if (start >= Math.max(CUT, trade.openedAt) && start < trade.closedAt) {
                windows.set(calendar.periodKey, { key: calendar.periodKey, start, end, timeZone: calendar.scheduleTimeZone });
            }
            probe = start - 1;
        }
    }
    return { windows: [...windows.values()].sort((a, b) => a.start - b.start) };
}
export interface BarData { bars: BidBar[]; error?: string }
export interface WindowEvidence {
    tradeKey: string; windowKey: string; start: number; end: number; observedUntil: number;
    touch: 'observed' | 'not_observed' | 'unknown'; status: string; barCount: number;
    /** Coverage of exposure by fully contained Bid M5 intervals, not executable ticks. */
    coverage: 'complete' | 'partial' | 'unavailable';
    /** Null with gaps: the calendar does not establish how many feed bars should exist. */
    barsMissing: number | null; coverageGaps: { start: number; end: number }[];
    survivedWindow: boolean; causalAttribution: 'not_established';
}
export interface EvaluationAggregate {
    ticker: string; nVentanas: number; slTocado: number; sobrevivio: number; rSalvado: null;
    dBlocked: number; slIndeterminado: number; status: 'descriptive_only';
    excluded: Record<string, number>; evidence: WindowEvidence[];
    blockedRule: 'C'; ruleAEvidence: 'not_established';
}
export interface EvaluationInput {
    trades: any[]; evaluatedAt: number; getCalendar: CalendarResolver;
    barsByTicker: Record<string, BarData>; blockedByTicker?: Record<string, number>;
}
export function evaluateRollover(input: EvaluationInput): { tickers: EvaluationAggregate[]; global: EvaluationAggregate } {
    const aggregates = new Map<string, EvaluationAggregate>();
    const seenWindows = new Set<string>();
    const make = (ticker: string): EvaluationAggregate => ({ ticker, nVentanas: 0, slTocado: 0, sobrevivio: 0,
        rSalvado: null, dBlocked: 0, slIndeterminado: 0, status: 'descriptive_only', excluded: {}, evidence: [],
        blockedRule: 'C', ruleAEvidence: 'not_established' });
    const put = (ticker: string) => {
        if (!aggregates.has(ticker)) aggregates.set(ticker, make(ticker));
        return aggregates.get(ticker)!;
    };
    for (const raw of input.trades) {
        const a = put(typeof raw.ticker === 'string' ? raw.ticker : '_UNKNOWN');
        const normalized = normalizeTrade(raw, input.evaluatedAt);
        if (!normalized.trade) {
            const reason = normalized.reason!;
            a.excluded[reason] = (a.excluded[reason] ?? 0) + 1;
            continue;
        }
        const trade = normalized.trade;
        const calendar = tradeWindows(trade, input.getCalendar);
        if (calendar.reason) {
            const reason = input.barsByTicker[trade.ticker]?.error ?? calendar.reason;
            a.excluded[reason] = (a.excluded[reason] ?? 0) + 1;
            continue;
        }
        for (const window of calendar.windows) {
            const identity = `${trade.ticker}:${trade.key}:${window.key}`;
            if (seenWindows.has(identity)) {
                a.excluded.duplicate_position_window = (a.excluded.duplicate_position_window ?? 0) + 1;
                continue;
            }
            seenWindows.add(identity);
            const until = Math.min(window.end, trade.closedAt);
            const data = input.barsByTicker[trade.ticker];
            const bars = (data?.error ? [] : data?.bars ?? [])
                .filter(b => Number.isFinite(b.ts) && Number.isFinite(b.low) && Number.isFinite(b.high) &&
                    b.low > 0 && b.high >= b.low && b.ts >= window.start && b.ts + M5_MS <= until)
                .sort((a, b) => a.ts - b.ts);
            // Union complete bar intervals, including uncovered exposure edges.
            // Scheduled closure explains absent feed, but supplies no price path.
            const coverageGaps: { start: number; end: number }[] = [];
            let coveredUntil = window.start;
            for (const bar of bars) {
                if (bar.ts > coveredUntil) coverageGaps.push({ start: coveredUntil, end: bar.ts });
                coveredUntil = Math.max(coveredUntil, bar.ts + M5_MS);
            }
            if (coveredUntil < until) coverageGaps.push({ start: coveredUntil, end: until });
            const coverage = !bars.length ? 'unavailable' : coverageGaps.length ? 'partial' : 'complete';
            const touch = trade.direction === 'BUY' && bars.some(b => b.low <= trade.initialSlPrice);
            // Positive evidence remains descriptive despite gaps. A negative
            // observation requires complete interval coverage; SELL needs Ask.
            const unknown = trade.direction === 'SELL' || (!touch && coverage !== 'complete');
            const survivedWindow = trade.closedAt > window.end;
            a.nVentanas++;
            if (unknown) a.slIndeterminado++;
            if (touch) { a.slTocado++; if (survivedWindow) a.sobrevivio++; }
            a.evidence.push({ tradeKey: trade.key, windowKey: window.key, start: window.start, end: window.end,
                observedUntil: until, touch: unknown ? 'unknown' : touch ? 'observed' : 'not_observed',
                status: trade.direction === 'SELL' ? 'ask_unavailable' : data?.error ? data.error : !bars.length ? 'bid_bars_unavailable' : touch ? 'bid_bar_traversal_observed' : coverage === 'partial' ? 'bid_bar_coverage_gaps' : 'not_observed_in_available_bid_bars', barCount: bars.length,
                coverage, barsMissing: coverage === 'complete' ? 0 : null, coverageGaps,
                survivedWindow, causalAttribution: 'not_established' });
        }
    }
    for (const [ticker, count] of Object.entries(input.blockedByTicker ?? {})) {
        if (Number.isSafeInteger(count) && count >= 0 && ticker !== '_GLOBAL') put(ticker).dBlocked = count;
    }
    const global = make('_GLOBAL');
    const tickers = [...aggregates.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
    for (const a of tickers) {
        global.nVentanas += a.nVentanas; global.slTocado += a.slTocado; global.sobrevivio += a.sobrevivio;
        global.slIndeterminado += a.slIndeterminado; global.dBlocked += a.dBlocked;
        for (const [reason, count] of Object.entries(a.excluded)) global.excluded[reason] = (global.excluded[reason] ?? 0) + count;
    }
    return { tickers, global };
}
export function decodeTrendbar(raw: any): BidBar | null {
    if (!raw || raw.low == null || raw.utcTimestampInMinutes == null) return null;
    const low = Number(raw.low), delta = Number(raw.deltaHigh ?? 0), minute = Number(raw.utcTimestampInMinutes);
    if (!Number.isSafeInteger(low) || low <= 0 || !Number.isSafeInteger(delta) || delta < 0 ||
        !Number.isSafeInteger(low + delta) || !Number.isSafeInteger(minute) || minute <= 0) return null;
    return { ts: minute * 60_000, low: low / 100_000, high: (low + delta) / 100_000 };
}
