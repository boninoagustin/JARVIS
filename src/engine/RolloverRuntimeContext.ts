import { getVerifiedRolloverPauses } from './RolloverSpreadGate.js';
import type { ExecutionObservation, ExecutionBar } from './ExecutionTypes.js';
import type { RolloverFreezeContext, RolloverTriageConfig } from './RolloverTriagePolicy.js';

export interface RolloverSignalContext {
    rolloverFreeze?: RolloverFreezeContext;
    observationInterval?: { startMs: number; endMs: number };
}
/** Bind Alpha's actual high/low and previous extrema to their complete source range.
 * Never infer a candle identity from wall clock or attach an old EX1 observation. */
export function buildRolloverSignalContext(ticker: string, nowMs: number, policy: RolloverRuntimePolicy | undefined,
    observation: ExecutionObservation | undefined, prices: { high: number; low: number; prevHigh?: number; prevLow?: number }): RolloverSignalContext {
    if (policy?.freezeSignals !== true) return {};
    const unknown = (): RolloverSignalContext => ({ rolloverFreeze: {
        profile: 'rollover_freeze_v1', ticker, metadataAvailable: false, intervals: [] } });
    if (!observation || observation.ticker !== ticker || observation.observedAtMs !== nowMs
        || !observation.bar || !Number.isFinite(nowMs)) return unknown();
    const equalPrice = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b)
        && Math.abs(a - b) <= Math.max(1e-8, 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)));
    const bars: ExecutionBar[] = [observation.bar];
    if (!equalPrice(observation.bar.high, prices.high) || !equalPrice(observation.bar.low, prices.low)) return unknown();
    if (prices.prevHigh !== undefined || prices.prevLow !== undefined) {
        const previous = observation.previousClosedBar;
        if (!previous || !previous.closed || !equalPrice(previous.high, prices.prevHigh!)
            || !equalPrice(previous.low, prices.prevLow!)) return unknown();
        bars.push(previous);
    }
    if (bars.some(b => ![b.openTimeMs,b.closeTimeMs,b.availableAtMs].every(Number.isFinite)
        || b.openTimeMs >= b.closeTimeMs || b.openTimeMs > nowMs || b.availableAtMs > nowMs
        || (b.closed && b.closeTimeMs > nowMs))) return unknown();
    const startMs = Math.min(...bars.map(b => b.openTimeMs));
    const endMs = Math.max(...bars.map(b => b.closed ? b.closeTimeMs : Math.min(b.closeTimeMs, nowMs + 1)));
    return { rolloverFreeze: buildRolloverFreezeContext(ticker, startMs, endMs, policy), observationInterval: { startMs, endMs } };
}

/** Explicit research configuration; absence is always the existing behavior. */
export interface RolloverRuntimePolicy {
    profile?: 'legacy' | 'rollover_triage_v1';
    freezeSignals?: boolean;
    freezeBeforeReopenMs?: number;
    freezeAfterReopenMs?: number;
    triage?: RolloverTriageConfig;
    peakSpread?: { price: number; availableAtMs: number };
}

/** Enumerate the complete source-bar range, not only the latest pause at now.
 * Whole-bar exclusion is experimental; raw price/risk/exits must still be fed. */
export function buildRolloverFreezeContext(ticker: string, startMs: number, endMs: number,
    policy?: RolloverRuntimePolicy): RolloverFreezeContext | undefined {
    if (policy?.freezeSignals !== true) return undefined;
    const before = policy.freezeBeforeReopenMs ?? 5 * 60000;
    const after = policy.freezeAfterReopenMs ?? 10 * 60000;
    const unknown = (): RolloverFreezeContext => ({ profile: 'rollover_freeze_v1', ticker,
        metadataAvailable: false, intervals: [] });
    if (!ticker || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
        || !Number.isFinite(before) || !Number.isFinite(after) || before < 0 || after < 0
        || before > 6 * 3600000 || after > 6 * 3600000) return unknown();
    const result = getVerifiedRolloverPauses(ticker, startMs - after, endMs + before);
    if (!result.metadataAvailable) return unknown();
    const intervals = result.pauses.map(p => ({ startMs: p.reopenMs - before, endMs: p.reopenMs + after }))
        .filter(w => w.endMs > w.startMs && startMs < w.endMs && endMs > w.startMs);
    return { profile: 'rollover_freeze_v1', ticker, metadataAvailable: true, intervals };
}
