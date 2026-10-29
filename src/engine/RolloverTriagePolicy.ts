import { getRolloverCalendar, isSpreadNormalized } from './RolloverSpreadGate.js';
import type { RolloverSpreadSnapshot } from './RolloverSpreadGate.js';

/** Caller derives ALL intervals from the verified broker-symbol calendar. No NY
 * universal clock. All intervals and observations are half-open [start,end).
 * Missing metadata/invalid context fails closed ONLY inside the signal model. */
export interface RolloverFreezeContext {
    profile: 'rollover_freeze_v1';
    ticker: string;
    metadataAvailable: boolean;
    intervals: readonly { readonly startMs: number; readonly endMs: number }[];
}
export function shouldFreezeRolloverObservation(startMs: number, endMs: number, context?: RolloverFreezeContext): boolean {
    if (context?.profile !== 'rollover_freeze_v1') return false;
    if (!context.metadataAvailable || !context.ticker || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
        || !Array.isArray(context.intervals) || context.intervals.some(w => !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs) || w.endMs <= w.startMs)) return true;
    return context.intervals.some(w => startMs < w.endMs && endMs > w.startMs);
}


/** Experimental proposals only. Never executes, persists or counts a trade. */
export type RolloverTriageAction = 'HOLD' | 'MOVE_TO_NET_BE' | 'CLOSE_PROACTIVE_MARKET'
    | 'WIDEN_BOUNDED_SL' | 'RESTORE_ORIGINAL_SL' | 'FORCE_CLOSE_BREACHED_ORIG_SL';
export interface RolloverTriageConfig {
    maxExtraRiskR: number;
    greenPeakMultiple: number;
    greenMinR: number;
    structuralPeakMultiple: number;
    beMinDistancePeakMultiple: number;
    severeLossR: number;
    maxQuoteAgeMs: number;
}
export interface RolloverPendingReference {
    readonly tradeId: string;
    readonly periodKey: string;
    readonly originalSlPrice: number;
    readonly widenedSlPrice: number;
    readonly initialRiskPrice: number;
    readonly extraRiskR: number;
    readonly status: 'INTENT' | 'CONFIRMED';
}
export interface RolloverTriageContext {
    profile?: 'legacy' | 'rollover_triage_v1';
    ticker: string;
    tradeId: string;
    direction: 'BUY' | 'SELL';
    nowMs: number;
    entryPrice: number;
    initialSlPrice: number;
    /** Captured at fill and persisted; never inferred from mutable SL. */
    initialRiskPrice: number;
    currentSlPrice: number;
    quote: { bid: number; ask: number; bidTimestampMs: number; askTimestampMs: number } | null;
    tickSize: number;
    minStopDistancePrice: number;
    protectionEarned: boolean;
    /** Cash allocated to REMAINING position, incl. exit fee/swap/unrecovered entry costs.
     * Positive realized partial profit is NOT used to subsidize the remaining BE. */
    costs: { remainingCostsCash: number; remainingValuePerPriceUnit: number } | null;
    partial: { tp1Confirmed: boolean; realizedNetCash: number } | null;
    htf: { aligned: boolean; availableAtMs: number } | null;
    /** Independently measured prior rollover spread, available as-of, in price units. */
    peakSpread: { price: number; availableAtMs: number } | null;
    pending?: RolloverPendingReference | null;
    /** Durable lifetime latch, retained after restoration. One widening per trade. */
    widenReference?: RolloverPendingReference | null;
    config: RolloverTriageConfig;
    normalization: { snapshot: RolloverSpreadSnapshot | null; baseSpreadPrice: number; pipSize: number };
}
export interface RolloverTriageProposal {
    action: RolloverTriageAction;
    reason: string;
    /** Stable across retries; executor must serialize and persist intent before AMEND. */
    proposalId?: string;
    stopLossPrice?: number;
    pendingIntent?: RolloverPendingReference;
}
const hold = (reason: string): RolloverTriageProposal => ({ action: 'HOLD', reason });
const positive = (n: number) => Number.isFinite(n) && n > 0;
const epsilon = (...xs: number[]) => 16 * Number.EPSILON * Math.max(1, ...xs.map(Math.abs));
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

export function evaluateRolloverTriage(c: Readonly<RolloverTriageContext>): RolloverTriageProposal {
    if (c.profile !== 'rollover_triage_v1') return hold('legacy_profile');
    const cfg = c.config;
    if (!cfg || ![cfg.maxExtraRiskR,cfg.greenPeakMultiple,cfg.greenMinR,cfg.structuralPeakMultiple,cfg.beMinDistancePeakMultiple,cfg.severeLossR,cfg.maxQuoteAgeMs].every(Number.isFinite) || cfg.maxExtraRiskR <= 0 || cfg.maxExtraRiskR > 0.30
        || cfg.greenPeakMultiple <= 0 || cfg.greenMinR < 0 || cfg.structuralPeakMultiple <= 0
        || cfg.beMinDistancePeakMultiple <= 0 || cfg.severeLossR >= 0 || cfg.maxQuoteAgeMs <= 0 || cfg.maxQuoteAgeMs > 10000) return hold('invalid_config');
    if (!c.tradeId || !c.ticker || !['BUY', 'SELL'].includes(c.direction) || !Number.isFinite(c.nowMs)
        || ![c.entryPrice,c.initialSlPrice,c.initialRiskPrice,c.currentSlPrice,c.tickSize].every(positive)
        || !Number.isFinite(c.minStopDistancePrice) || c.minStopDistancePrice < 0) return hold('invalid_trade');
    const dir = c.direction === 'BUY' ? 1 : -1;
    const tol = epsilon(c.entryPrice, c.initialSlPrice, c.currentSlPrice);
    if (Math.abs(dir * (c.entryPrice - c.initialSlPrice) - c.initialRiskPrice) > tol) return hold('invalid_initial_risk');
    const cal = getRolloverCalendar(c.ticker, c.nowMs);
    if (!cal.metadataAvailable || !cal.marketOpen) return hold('calendar_unavailable_or_closed');
    const q = c.quote;
    if (!q || !positive(q.bid) || !positive(q.ask) || q.ask < q.bid
        || ![q.bidTimestampMs,q.askTimestampMs].every(ts => Number.isFinite(ts) && ts <= c.nowMs && c.nowMs - ts <= cfg.maxQuoteAgeMs)) return hold('quote_unknown');
    const executable = dir === 1 ? q.bid : q.ask;
    const propose = (action: RolloverTriageAction, reason: string, sl?: number, pendingIntent?: RolloverPendingReference): RolloverTriageProposal => ({
        action, reason, proposalId: `${c.tradeId}:${c.pending?.periodKey ?? cal.periodKey ?? 'none'}:${action}:${sl ?? 'market'}`,
        ...(sl !== undefined ? { stopLossPrice: sl } : {}), ...(pendingIntent ? { pendingIntent } : {})
    });
    if (c.pending) {
        const p = c.pending;
        if (p.status !== 'CONFIRMED') return hold('pending_execution_unconfirmed');
        const extra = dir * (p.originalSlPrice - p.widenedSlPrice) / c.initialRiskPrice;
        if (p.tradeId !== c.tradeId || !p.periodKey || ![p.originalSlPrice,p.widenedSlPrice,p.initialRiskPrice].every(positive)
            || Math.abs(p.initialRiskPrice - c.initialRiskPrice) > tol || !Number.isFinite(p.extraRiskR)
            || extra <= 0 || extra > 0.30 + tol / c.initialRiskPrice || Math.abs(extra - p.extraRiskR) > tol / c.initialRiskPrice) return hold('invalid_pending_reference');
        // No expiry and no requirement that the current period equals the original period.
        if (dir * (c.currentSlPrice - p.originalSlPrice) >= -tol) return hold('equivalent_protection_requires_readback');
        const n = c.normalization;
        if (!cal.restoreEligible || !n || !isSpreadNormalized(n.snapshot, c.nowMs, n.baseSpreadPrice, n.pipSize)) return hold('restore_evidence_missing');
        if (!n.snapshot || Math.abs(n.snapshot.bid - q.bid) > tol || Math.abs(n.snapshot.ask - q.ask) > tol
            || n.snapshot.ts !== Math.min(q.bidTimestampMs, q.askTimestampMs)) return hold('restore_quote_mismatch');
        if (dir * (executable - p.originalSlPrice) <= tol) return propose('FORCE_CLOSE_BREACHED_ORIG_SL', 'original_stop_breached');
        if (dir * (executable - p.originalSlPrice) + tol < Math.max(c.tickSize, c.minStopDistancePrice)) return hold('restore_min_distance');
        const tick = p.originalSlPrice / c.tickSize;
        if (Math.abs(tick - Math.round(tick)) > tol / c.tickSize) return hold('original_stop_off_tick');
        return propose('RESTORE_ORIGINAL_SL', 'restore_durable_pending', p.originalSlPrice);
    }
    if (!cal.protectionWindow || !cal.periodKey) return hold('outside_window');
    if (!c.peakSpread || !positive(c.peakSpread.price) || !Number.isFinite(c.peakSpread.availableAtMs) || c.peakSpread.availableAtMs > c.nowMs) return hold('peak_unknown');
    const floating = dir * (executable - c.entryPrice);
    const floatR = floating / c.initialRiskPrice;
    if (floating >= cfg.greenPeakMultiple * c.peakSpread.price && floatR >= cfg.greenMinR) {
        const costs = c.costs;
        if (!costs || !Number.isFinite(costs.remainingCostsCash) || costs.remainingCostsCash < 0 || !positive(costs.remainingValuePerPriceUnit)) return hold('remaining_costs_unknown');
        const netBe = c.entryPrice + dir * costs.remainingCostsCash / costs.remainingValuePerPriceUnit;
        // Round INTO protection to cover costs even for a non-tick entry.
        const sl = (dir === 1 ? Math.ceil(netBe / c.tickSize) : Math.floor(netBe / c.tickSize)) * c.tickSize;
        const distance = dir * (executable - sl);
        if (!positive(sl) || distance <= cfg.beMinDistancePeakMultiple * c.peakSpread.price + tol
            || distance + tol < Math.max(c.tickSize, c.minStopDistancePrice)) return hold('net_be_distance_insufficient');
        if (dir * (sl - c.currentSlPrice) <= tol) return hold('already_better_protected');
        return propose('MOVE_TO_NET_BE', 'green_net_remaining_costs', sl);
    }
    if (floatR <= cfg.severeLossR) return propose('CLOSE_PROACTIVE_MARKET', 'severe_loss');
    const structuralDistance = dir * (executable - c.initialSlPrice);
    if (structuralDistance > cfg.structuralPeakMultiple * c.peakSpread.price + tol) return hold('structural_distance_sufficient');
    if (floating >= 0 || (c.partial?.tp1Confirmed === true && Number.isFinite(c.partial.realizedNetCash))) return propose('CLOSE_PROACTIVE_MARKET', 'critical_marginal_or_confirmed_tp1');
    if (!cal.widenWindow) return hold('outside_widen_window');
    // The calendar excludes weekly gaps; explicitly reject Friday/weekend in the
    // broker's own timezone too (some instruments have Friday intraday pauses).
    let weekdayFormatter = weekdayFormatters.get(cal.scheduleTimeZone!);
    if (!weekdayFormatter) {
        weekdayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: cal.scheduleTimeZone!, weekday: 'short' });
        weekdayFormatters.set(cal.scheduleTimeZone!, weekdayFormatter);
    }
    const weekday = weekdayFormatter.format(c.nowMs);
    if (['Fri','Sat','Sun'].includes(weekday)) return hold('weekly_close_risk');
    if (c.widenReference || dir * (c.currentSlPrice - c.initialSlPrice) < -tol) return hold('widen_budget_already_used_or_unknown');
    if (c.protectionEarned !== false || dir * (c.currentSlPrice - c.entryPrice) >= -tol) return hold('protected_stop');
    if (!c.partial || c.partial.tp1Confirmed !== false || !Number.isFinite(c.partial.realizedNetCash)) return hold('partial_execution_unknown');
    if (!c.htf || c.htf.aligned !== true || !Number.isFinite(c.htf.availableAtMs) || c.htf.availableAtMs > c.nowMs) return hold('htf_unknown_or_opposed');
    if (floatR >= 0 || floatR <= cfg.severeLossR) return hold('not_moderate_loss');
    const target = c.currentSlPrice - dir * cfg.maxExtraRiskR * c.initialRiskPrice;
    // Round toward protection, never beyond the nominal aggregate budget.
    const sl = (dir === 1 ? Math.ceil((target - tol) / c.tickSize) : Math.floor((target + tol) / c.tickSize)) * c.tickSize;
    if (!positive(sl) || dir * (executable - sl) + tol < Math.max(c.tickSize, c.minStopDistancePrice)
        || dir * (c.currentSlPrice - sl) <= tol) return hold('stop_not_executable');
    const extraRiskR = dir * (c.currentSlPrice - sl) / c.initialRiskPrice;
    if (extraRiskR > cfg.maxExtraRiskR + tol / c.initialRiskPrice) return hold('budget_exceeded');
    return propose('WIDEN_BOUNDED_SL', 'moderate_loss_aligned', sl, {
        tradeId: c.tradeId, periodKey: cal.periodKey, originalSlPrice: c.currentSlPrice,
        widenedSlPrice: sl, initialRiskPrice: c.initialRiskPrice, extraRiskR, status: 'INTENT'
    });
}
