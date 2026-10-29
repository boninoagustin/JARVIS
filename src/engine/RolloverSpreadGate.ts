// Broker calendar only: never import TickFlow here (it imports this module).
export interface RolloverSchedule {
    scheduleTimeZone: string;
    schedule: { startSecond: number; endSecond: number }[];
}
export interface RolloverCalendar {
    metadataAvailable: boolean;
    scheduleTimeZone: string | null;
    marketOpen: boolean;
    pauseStartMs: number | null;
    reopenMs: number | null;
    periodKey: string | null;
    protectionWindow: boolean;
    widenWindow: boolean;
    entryWindow: boolean;
    restoreEligible: boolean;
}
const schedules = new Map<string, RolloverSchedule>();
const formatters = new Map<string, Intl.DateTimeFormat>();
const weekSessions = new Map<string, { start: number; end: number }[]>();
const MINUTE = 60_000;
const DAY = 86_400_000;
const WEEK_SECONDS = 604800;

/** Invalid metadata removes the old calendar: live must fail closed. */
export function registerRolloverSchedule(ticker: string, metadata: RolloverSchedule): boolean {
    const key = ticker.toUpperCase();
    try {
        if (typeof metadata?.scheduleTimeZone !== 'string' || !metadata.scheduleTimeZone.trim()) throw new Error('missing timezone');
        new Intl.DateTimeFormat('en-US', { timeZone: metadata.scheduleTimeZone }).format(0);
        const schedule = metadata.schedule.map(s => ({ startSecond: Number(s.startSecond), endSecond: Number(s.endSecond) })).sort((a, b) => a.startSecond - b.startSecond);
        if (!schedule.length || schedule.some((s, i) => !Number.isFinite(s.startSecond) || !Number.isFinite(s.endSecond) || s.startSecond < 0 || s.endSecond > WEEK_SECONDS || s.endSecond <= s.startSecond || (i > 0 && s.startSecond < schedule[i - 1]!.endSecond))) throw new Error('invalid schedule');
        schedules.set(key, { scheduleTimeZone: metadata.scheduleTimeZone, schedule });
        return true;
    } catch {
        schedules.delete(key);
        return false;
    }
}
function fallback(ticker: string): RolloverSchedule | null {
    const t = ticker.toUpperCase();
    if (/XAU|GOLD/.test(t)) return { scheduleTimeZone: 'UTC', schedule: Array.from({ length: 5 }, (_, i) => ({ startSecond: 79260 + i * 86400, endSecond: 161940 + i * 86400 })) };
    if (/^(USD|EUR|GBP|JPY|AUD|NZD|CAD|CHF|CNH|CNY|SGD|HKD|NOK|SEK|MXN|ZAR|TRY|PLN){2}$/.test(t)) return { scheduleTimeZone: 'America/New_York', schedule: Array.from({ length: 5 }, (_, i) => ({ startSecond: 61205 + i * 86400, endSecond: 145795 + i * 86400 })) };
    return null;
}
function wallTime(ms: number, tz: string): number {
    let formatter = formatters.get(tz);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
        formatters.set(tz, formatter);
    }
    const p = formatter.formatToParts(ms);
    const n = (name: string) => Number(p.find(x => x.type === name)?.value);
    return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
}
function utcFromWall(wall: number, tz: string): number {
    let utc = wall;
    for (let i = 0; i < 4; i++) {
        const delta = wall - wallTime(utc, tz);
        if (!delta) break;
        utc += delta;
    }
    return utc;
}
/** Schedule seconds are local wall seconds since Sunday 00:00, NOT UTC. */
export function getRolloverCalendar(ticker: string, nowMs: number): RolloverCalendar {
    const registered = schedules.get(ticker.toUpperCase());
    const meta = registered ?? fallback(ticker);
    const empty: RolloverCalendar = { metadataAvailable: !!registered, scheduleTimeZone: meta?.scheduleTimeZone ?? null, marketOpen: false, pauseStartMs: null, reopenMs: null, periodKey: null, protectionWindow: false, widenWindow: false, entryWindow: false, restoreEligible: false };
    if (!meta || !Number.isFinite(nowMs)) return empty;
    const wall = wallTime(nowMs, meta.scheduleTimeZone);
    const date = new Date(wall);
    const sunday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay());
    // TickFlow calls this on every tick: cache DST conversions per local week,
    // including the schedule itself in the key to avoid stale metadata reuse.
    const cacheKey = `${ticker.toUpperCase()}:${meta.scheduleTimeZone}:${sunday}:${meta.schedule.map(s => `${s.startSecond}-${s.endSecond}`).join(',')}`;
    let sessions = weekSessions.get(cacheKey);
    if (!sessions) {
        sessions = [];
        for (let week = -1; week <= 1; week++) for (const s of meta.schedule) sessions.push({ start: utcFromWall(sunday + week * 7 * DAY + s.startSecond * 1000, meta.scheduleTimeZone), end: utcFromWall(sunday + week * 7 * DAY + s.endSecond * 1000, meta.scheduleTimeZone) });
        sessions.sort((a, b) => a.start - b.start);
        if (weekSessions.size >= 64) weekSessions.delete(weekSessions.keys().next().value!);
        weekSessions.set(cacheKey, sessions);
    }
    const marketOpen = sessions.some(s => nowMs >= s.start && nowMs < s.end);
    // Only short intraday gaps count as rollover. Never widen ahead of a weekend.
    const pauses = sessions.slice(0, -1).map((s, i) => ({ start: s.end, end: sessions[i + 1]!.start })).filter(p => p.end > p.start && p.end - p.start <= 6 * 60 * MINUTE);
    const eligible = pauses.filter(p => p.start - 9 * MINUTE <= nowMs);
    const pause = eligible[eligible.length - 1];
    if (!pause) return { ...empty, marketOpen, restoreEligible: marketOpen };
    return { ...empty, marketOpen, pauseStartMs: pause.start, reopenMs: pause.end, periodKey: `${ticker.toUpperCase()}:${pause.start}`, protectionWindow: nowMs >= pause.start - 9 * MINUTE && nowMs < pause.start - 2 * MINUTE, widenWindow: nowMs >= pause.start - 4 * MINUTE && nowMs < pause.start - 2 * MINUTE, entryWindow: nowMs >= pause.start && nowMs < pause.end + 30 * MINUTE, restoreEligible: marketOpen && nowMs >= pause.end + 15 * MINUTE };
}
export interface VerifiedRolloverPauses {
    metadataAvailable: boolean;
    pauses: readonly { pauseStartMs: number; reopenMs: number }[];
}
/** All short gaps intersecting a source range, using VERIFIED symbol metadata only.
 * Separate from the legacy latest-pause selector so legacy timing is unchanged. */
export function getVerifiedRolloverPauses(ticker: string, fromMs: number, toMs: number): VerifiedRolloverPauses {
    const meta = schedules.get(ticker.toUpperCase());
    const invalid = (): VerifiedRolloverPauses => ({ metadataAvailable: false, pauses: [] });
    if (!meta || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs
        || toMs - fromMs > 31 * DAY || !Number.isFinite(new Date(fromMs).getTime())
        || !Number.isFinite(new Date(toMs).getTime())) return invalid();
    const wallFrom = wallTime(fromMs, meta.scheduleTimeZone);
    const wallTo = wallTime(toMs, meta.scheduleTimeZone);
    const date = new Date(wallFrom);
    const sunday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay());
    const lastWeek = Math.floor((wallTo - sunday) / (7 * DAY));
    const sessions: { start: number; end: number }[] = [];
    for (let week = -1; week <= lastWeek + 1; week++) for (const s of meta.schedule) {
        sessions.push({ start: utcFromWall(sunday + week * 7 * DAY + s.startSecond * 1000, meta.scheduleTimeZone),
            end: utcFromWall(sunday + week * 7 * DAY + s.endSecond * 1000, meta.scheduleTimeZone) });
    }
    sessions.sort((a, b) => a.start - b.start);
    const pauses: { pauseStartMs: number; reopenMs: number }[] = [];
    for (let i = 0; i < sessions.length - 1; i++) {
        const start = sessions[i]!.end, end = sessions[i + 1]!.start;
        if (end > start && end - start <= 6 * 60 * MINUTE && fromMs < end && toMs > start)
            pauses.push({ pauseStartMs: start, reopenMs: end });
    }
    return { metadataAvailable: true, pauses };
}

export interface RolloverSpreadSnapshot {
    bid: number; ask: number; ts: number; ageMs: number; samples: number;
    spread: number; baselineSpread: number | null;
}
/** Quote subtraction can add a few ULPs; never round by an instrument pip. */
export function isRolloverSpreadWithinLimit(spread: number, limit: number, bid: number, ask: number): boolean {
    if (!Number.isFinite(spread) || !Number.isFinite(limit) || !Number.isFinite(bid)
        || !Number.isFinite(ask) || spread < 0 || limit <= 0) return false;
    const tolerance = 4 * Number.EPSILON * Math.max(1, Math.abs(bid), Math.abs(ask), limit);
    return spread <= limit + tolerance;
}
export function isSpreadNormalized(snapshot: RolloverSpreadSnapshot | null, nowMs: number, baseSpreadPrice: number, pipSize: number): boolean {
    if (!snapshot || !Number.isFinite(nowMs) || !Number.isFinite(pipSize) || pipSize <= 0 || !Number.isFinite(baseSpreadPrice) || baseSpreadPrice < 0) return false;
    const q = snapshot;
    const age = nowMs - q.ts;
    if (!Number.isFinite(q.bid) || q.bid <= 0 || !Number.isFinite(q.ask) || q.ask < q.bid || !Number.isFinite(age) || age < 0 || age > 10000 || !Number.isFinite(q.ageMs) || q.ageMs < 0 || q.ageMs > 10000 || !Number.isFinite(q.samples) || q.samples < 100 || q.baselineSpread === null || !Number.isFinite(q.baselineSpread) || q.baselineSpread <= 0 || !Number.isFinite(q.spread) || q.spread < 0) return false;
    // Use executable sides too; a contradictory snapshot must never lower spread.
    return isRolloverSpreadWithinLimit(Math.max(q.spread, q.ask - q.bid),
        Math.max(1.65 * q.baselineSpread, baseSpreadPrice + 0.8 * pipSize), q.bid, q.ask);
}
export interface RolloverEntryGateOptions {
    live: boolean;
    enabled?: boolean;
    baseSpreadPrice: number;
    pipSize: number;
}
export interface RolloverEntryGateResult {
    blocked: boolean;
    reason: 'MISSING_SCHEDULE' | 'MARKET_CLOSED' | 'ROLLOVER_WINDOW' | 'SPREAD_NOT_NORMALIZED' | null;
    calendar: RolloverCalendar;
}
export function evaluateRolloverEntryGate(ticker: string, nowMs: number, snapshot: RolloverSpreadSnapshot | null, options: RolloverEntryGateOptions): RolloverEntryGateResult {
    const calendar = getRolloverCalendar(ticker, nowMs);
    if (options.enabled === false) return { blocked: false, reason: null, calendar };
    const reason = options.live && !calendar.metadataAvailable ? 'MISSING_SCHEDULE' : !calendar.marketOpen ? 'MARKET_CLOSED' : calendar.entryWindow ? 'ROLLOVER_WINDOW' : options.live && !isSpreadNormalized(snapshot, nowMs, options.baseSpreadPrice, options.pipSize) ? 'SPREAD_NOT_NORMALIZED' : null;
    // No timer thaw/latch: each evaluation demands evidence anew.
    return { blocked: reason !== null, reason, calendar };
}

export function isRolloverBaselineWindow(ticker: string, nowMs: number): boolean {
    const c = getRolloverCalendar(ticker, nowMs);
    return !c.marketOpen || c.entryWindow;
}
