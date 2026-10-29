import { evaluateRolloverTriage } from './RolloverTriagePolicy.js';
import type { RolloverPendingReference, RolloverTriageContext, RolloverTriageProposal } from './RolloverTriagePolicy.js';

/** positionKey identifies a broker position incarnation, NOT just its symbol. */
export interface RolloverExecutionIdentity { ticker: string; tradeId: string; positionKey: string }
export interface RolloverExecutionState {
    pending: RolloverPendingReference | null;
    /** Lifetime latch: must survive restoration and ambiguous intent recovery. */
    widenReference: RolloverPendingReference | null;
}
export type RolloverProtectionReadback =
    | { status: 'OPEN'; identity: RolloverExecutionIdentity; stopLossPrice: number }
    | { status: 'CLOSED'; identity: RolloverExecutionIdentity }
    | { status: 'UNAVAILABLE' };
export type RolloverVerifiedProtection = Exclude<RolloverProtectionReadback, { status: 'UNAVAILABLE' }>;
export interface RolloverExecutionWrite {
    identity: RolloverExecutionIdentity;
    state: RolloverExecutionState;
    proposal?: RolloverTriageProposal;
    expectedSlPrice?: number;
    protection?: RolloverVerifiedProtection;
}
export interface RolloverMutationRequest {
    identity: RolloverExecutionIdentity;
    proposalId: string;
    action: RolloverTriageProposal['action'];
}
export type RolloverMutationAcknowledgement = 'ACKNOWLEDGED' | 'REJECTED' | 'UNKNOWN';
export interface RolloverTriageExecutionDependencies {
    identity: RolloverExecutionIdentity;
    /** Authoritative entry snapshot, also returned intact if context is unavailable. */
    state: RolloverExecutionState;
    nowMs(): number;
    /** SYNCHRONOUS fresh usable context. nowMs must be the supplied wall clock.
     * Include current actual SL, immutable fill risk, quotes and durable references. */
    getContext(nowMs: number): { positionKey: string; context: RolloverTriageContext } | null;
    readProtection(identity: RolloverExecutionIdentity): Promise<RolloverProtectionReadback>;
    /** Resolve only after BOTH active state and independent journal ack/readback. */
    persistIntent(write: RolloverExecutionWrite): Promise<void>;
    persistConfirmed(write: RolloverExecutionWrite): Promise<void>;
    /** Atomically persist state.pending=null AND retain supplied widenReference. */
    clearPending(write: RolloverExecutionWrite): Promise<void>;
    /** Adapter calls authorize exactly once immediately before send, AFTER its
     * own awaits; false means DO NOT SEND. No await between authorize and send. */
    amendStopLoss(request: RolloverMutationRequest & { stopLossPrice: number }, authorize: () => boolean): Promise<RolloverMutationAcknowledgement>;
    closePosition(request: RolloverMutationRequest, authorize: () => boolean): Promise<RolloverMutationAcknowledgement>;
}
type ResultBase = { reason: string; state: RolloverExecutionState; proposal?: RolloverTriageProposal };
export type RolloverTriageExecutionResult = ResultBase & (
    | { status: 'HOLD' | 'IN_FLIGHT' | 'ABORTED' | 'UNCERTAIN' }
    | { status: 'CONFIRMED' | 'RECONCILED'; protection: RolloverVerifiedProtection }
);
// Contains only live invocations; no unbounded completed-trade dedupe cache.
const inFlight = new Set<string>();
const sameIdentity = (a: RolloverExecutionIdentity, b: RolloverExecutionIdentity) =>
    !!a && !!b && a.ticker === b.ticker && a.tradeId === b.tradeId && a.positionKey === b.positionKey;
const samePrice = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b)
    && Math.abs(a - b) <= 16 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
const sameRef = (a?: RolloverPendingReference | null, b?: RolloverPendingReference | null) =>
    !a && !b || !!a && !!b && a.tradeId === b.tradeId && a.periodKey === b.periodKey && a.status === b.status
    && a.originalSlPrice === b.originalSlPrice && a.widenedSlPrice === b.widenedSlPrice
    && a.initialRiskPrice === b.initialRiskPrice && a.extraRiskR === b.extraRiskR;
const sameState = (c: RolloverTriageContext, s: RolloverExecutionState) => sameRef(c.pending, s.pending) && sameRef(c.widenReference, s.widenReference);
const sameProposal = (a: RolloverTriageProposal, b: RolloverTriageProposal) => a.action === b.action
    && a.proposalId === b.proposalId && a.stopLossPrice === b.stopLossPrice && sameRef(a.pendingIntent, b.pendingIntent);

/** Experimental executor only. No service imports, timers, PnL or statistics.
 * Existing owner lock must ALSO cover other risk managers and applying returned
 * state. This local guard protects simultaneous calls to THIS executor. */
export async function runRolloverTriageExecution(d: RolloverTriageExecutionDependencies): Promise<RolloverTriageExecutionResult> {
    const identity = structuredClone(d.identity);
    let state = structuredClone(d.state);
    let proposal: RolloverTriageProposal | undefined;
    const result = (status: 'HOLD' | 'IN_FLIGHT' | 'ABORTED' | 'UNCERTAIN', reason: string): RolloverTriageExecutionResult =>
        ({ status, reason, state: structuredClone(state), ...(proposal ? { proposal: structuredClone(proposal) } : {}) });
    const key = JSON.stringify([identity.ticker, identity.tradeId]);
    if (inFlight.has(key)) return result('IN_FLIGHT', 'trade_execution_in_flight');
    inFlight.add(key);
    try {
        const fresh = (): RolloverTriageContext | null => {
            const now = d.nowMs();
            if (!Number.isFinite(now)) return null;
            const snapshot = d.getContext(now);
            const c = snapshot?.context;
            if (!c || snapshot.positionKey !== identity.positionKey || c.ticker !== identity.ticker || c.tradeId !== identity.tradeId || c.nowMs !== now) return null;
            return structuredClone(c);
        };
        const first = fresh();
        if (!first) return result('UNCERTAIN', 'context_unavailable_or_identity_changed');
        if (first.profile !== 'rollover_triage_v1') return result('HOLD', 'legacy_profile');
        if (!sameState(first, state)) return result('UNCERTAIN', 'entry_reference_mismatch');
        const samePosition = (c: RolloverTriageContext) => c.profile === first.profile && c.direction === first.direction
            && c.entryPrice === first.entryPrice && c.initialSlPrice === first.initialSlPrice && c.initialRiskPrice === first.initialRiskPrice;
        const read = async (): Promise<RolloverProtectionReadback> => {
            try {
                const r = await d.readProtection(structuredClone(identity));
                if (!r || r.status === 'UNAVAILABLE' || !sameIdentity(r.identity, identity)) return { status: 'UNAVAILABLE' };
                if (r.status === 'OPEN' && (!Number.isFinite(r.stopLossPrice) || r.stopLossPrice <= 0)) return { status: 'UNAVAILABLE' };
                return r.status === 'OPEN' || r.status === 'CLOSED' ? structuredClone(r) : { status: 'UNAVAILABLE' };
            } catch { return { status: 'UNAVAILABLE' }; }
        };
        const write = (s: RolloverExecutionState, protection?: RolloverVerifiedProtection): RolloverExecutionWrite => ({
            identity: structuredClone(identity), state: structuredClone(s),
            ...(proposal ? { proposal: structuredClone(proposal) } : {}), ...(protection ? { protection: structuredClone(protection) } : {})
        });
        const before = await read();
        if (before.status === 'UNAVAILABLE') return result('UNCERTAIN', 'protection_unavailable');
        // A verified closed incarnation may disappear from the live context. It
        // is not the same as a missing/unavailable protection response.
        if (before.status === 'CLOSED') {
            if (state.pending) {
                const next = { pending: null, widenReference: state.widenReference ?? state.pending };
                await d.clearPending(write(next, before));
                state = next;
            }
            return { status: 'RECONCILED', reason: 'verified_closed', state, protection: before };
        }
        const current = fresh();
        if (!current || !samePosition(current) || !sameState(current, state)) return result('UNCERTAIN', 'context_changed_after_read');
        const dir = current.direction === 'BUY' ? 1 : -1;
        // A timed-out send can land AFTER an original-equivalent read cleared
        // pending. The lifetime latch also preserves the restoration obligation.
        const resurrected = !state.pending && !!state.widenReference
            && dir * (before.stopLossPrice - state.widenReference.originalSlPrice) < 0;
        const p = state.pending ?? (resurrected ? state.widenReference : null);
        // INTENT recovery is deliberately separate: the policy only accepts CONFIRMED.
        if (p) {
            const extra = dir * (p.originalSlPrice - p.widenedSlPrice) / current.initialRiskPrice;
            if (p.tradeId !== identity.tradeId || !p.periodKey || !['INTENT', 'CONFIRMED'].includes(p.status)
                || ![p.originalSlPrice, p.widenedSlPrice, p.initialRiskPrice, current.initialRiskPrice].every(n => Number.isFinite(n) && n > 0)
                || !samePrice(p.initialRiskPrice, current.initialRiskPrice) || !Number.isFinite(extra)
                || extra <= 0 || extra > 0.30 + 16 * Number.EPSILON || !samePrice(extra, p.extraRiskR)) return result('UNCERTAIN', 'invalid_pending_reference');
            if (resurrected) state = { ...state, pending: p };
            if (dir * (before.stopLossPrice - p.originalSlPrice) >= 0) {
                // Even an apparently unsent INTENT may previously have executed and
                // been restored: preserve a conservative lifetime latch forever.
                const next = { pending: null, widenReference: state.widenReference ?? { ...p } };
                await d.clearPending(write(next, before));
                state = next;
                return { status: 'RECONCILED', reason: 'verified_equivalent_protection', state, protection: before };
            }
            if (p.status === 'INTENT' || resurrected) {
                if (!samePrice(before.stopLossPrice, p.widenedSlPrice)) return result('UNCERTAIN', 'intent_actual_protection_ambiguous');
                const confirmed: RolloverPendingReference = { ...p, status: 'CONFIRMED' };
                const reference = !state.widenReference || sameRef({ ...state.widenReference, status: 'CONFIRMED' }, confirmed)
                    ? confirmed : state.widenReference;
                const next = { pending: confirmed, widenReference: reference };
                await d.persistConfirmed(write(next, before));
                state = next;
                return { status: 'RECONCILED', reason: 'intent_widen_verified_without_resend', state, protection: before };
            }
        }
        if (!samePrice(current.currentSlPrice, before.stopLossPrice)) return result('UNCERTAIN', 'context_sl_disagrees_with_readback');
        proposal = evaluateRolloverTriage(current);
        if (proposal.action === 'HOLD') return result('HOLD', proposal.reason);
        if (!proposal.proposalId) return result('ABORTED', 'proposal_id_missing');
        const originalProposal = structuredClone(proposal);
        const priorState = structuredClone(state);
        if (proposal.action === 'WIDEN_BOUNDED_SL') {
            if (!proposal.pendingIntent) return result('ABORTED', 'pending_intent_missing');
            state = { ...state, pending: structuredClone(proposal.pendingIntent) };
        }
        // Write-ahead for every operation. A failed write NEVER sends to broker.
        await d.persistIntent({ ...write(state), expectedSlPrice: before.stopLossPrice });
        const latest = await read();
        if (latest.status !== 'OPEN') return result('UNCERTAIN', 'protection_changed_after_intent');
        const revalidate = (): boolean => {
            const c = fresh();
            if (!c || !samePosition(c) || !samePrice(c.currentSlPrice, latest.stopLossPrice)
                || !samePrice(c.currentSlPrice, before.stopLossPrice)) return false;
            // Accept our own newly persisted INTENT, not an unrelated pending/latch.
            if (!sameState(c, state) && !sameState(c, priorState)) return false;
            const check = evaluateRolloverTriage({ ...c, pending: priorState.pending, widenReference: priorState.widenReference });
            return sameProposal(originalProposal, check);
        };
        // Check after persistence/read awaits AND again inside the actual send
        // callback (which may have its own awaited queue/rate limiter).
        if (!revalidate()) return result('ABORTED', 'proposal_changed_after_intent');
        let authorized = false;
        let authorizationUsed = false;
        let authorizationOpen = true;
        const authorize = (): boolean => {
            if (!authorizationOpen || authorizationUsed) return false;
            authorizationUsed = true;
            authorized = revalidate();
            return authorized;
        };
        const request: RolloverMutationRequest = { identity: structuredClone(identity), proposalId: proposal.proposalId, action: proposal.action };
        let ack: RolloverMutationAcknowledgement = 'UNKNOWN';
        try {
            ack = proposal.stopLossPrice !== undefined
                ? await d.amendStopLoss({ ...request, stopLossPrice: proposal.stopLossPrice }, authorize)
                : await d.closePosition(request, authorize);
        } catch { /* Unknown transport outcome: always read, never blindly resend. */ }
        finally { authorizationOpen = false; }
        if (!authorizationUsed || !authorized) return result('UNCERTAIN', 'adapter_not_authorized');
        const after = await read();
        if (after.status === 'UNAVAILABLE') return result('UNCERTAIN', 'post_execution_readback_unavailable');
        if (proposal.stopLossPrice === undefined) {
            if (after.status !== 'CLOSED') return result('UNCERTAIN', `closure_unconfirmed:${ack}`);
            const next: RolloverExecutionState = { pending: null, widenReference: state.widenReference ?? state.pending };
            if (state.pending) await d.clearPending(write(next, after));
            else await d.persistConfirmed(write(next, after));
            state = next;
            return { status: 'CONFIRMED', reason: 'closure_verified', state, proposal, protection: after };
        }
        if (after.status === 'CLOSED') {
            const next: RolloverExecutionState = { pending: null, widenReference: state.widenReference ?? state.pending };
            await d.clearPending(write(next, after));
            state = next;
            return { status: 'RECONCILED', reason: 'verified_closed_after_amend', state, proposal, protection: after };
        }
        const matches = proposal.action === 'WIDEN_BOUNDED_SL'
            ? samePrice(after.stopLossPrice, proposal.stopLossPrice)
            : dir * (after.stopLossPrice - proposal.stopLossPrice) >= 0;
        if (!matches) return result('UNCERTAIN', `amendment_unconfirmed:${ack}`);
        if (proposal.action === 'RESTORE_ORIGINAL_SL') {
            const next: RolloverExecutionState = { pending: null, widenReference: state.widenReference ?? state.pending };
            await d.clearPending(write(next, after));
            state = next;
        } else {
            const confirmed = state.pending ? { ...state.pending, status: 'CONFIRMED' as const } : null;
            const next: RolloverExecutionState = { pending: confirmed, widenReference: state.widenReference ?? confirmed };
            await d.persistConfirmed(write(next, after));
            state = next;
        }
        return { status: 'CONFIRMED', reason: 'amendment_verified', state, proposal, protection: after };
    } catch {
        return result('UNCERTAIN', 'dependency_failure_pending_retained');
    } finally {
        inFlight.delete(key);
    }
}
