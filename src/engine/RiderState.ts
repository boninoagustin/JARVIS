/** RIDER decisions are causal and opt-in; Pivot/currentTrend are not reversal events. */
export interface RiderReversal {
    direction: 'Bullish' | 'Bearish';
    confirmed: true;
    observedAt: number;
    availableAt: number;
}
export interface RiderPolicy { enabled: boolean; tf: 'H1' | 'H4' | 'D1' }
export interface RiderTransition {
    schema: 1;
    phase: 'PENDING' | 'ACTIVE';
    positionId: string;
    direction: 'BUY' | 'SELL';
    entryPrice: number;
    minimumSl: number;
    tf: RiderPolicy['tf'];
    requestedAt: number;
    originalTp2: number;
    openedAtMs?: number;
    verifiedSl?: number;
    activatedAt?: number;
}
/** Existing configuration contract: current root/session, not trigger mgmtOverrides.
 * A frozen override may veto, but cannot enable a currently disabled asset. */
export function resolveRiderPolicy(config: any, session: string, overrides?: any): RiderPolicy {
    const local = config?.sessions?.[session] ?? config?.sessions?.ALL;
    const tf = local?.riderTf ?? config?.riderTf ?? 'H1';
    const enabled = !!config && config.enabled !== false && config.sessionEnabled !== false
        && config.riderEnabled !== false && local?.enabled !== false && overrides?.riderEnabled !== false
        && (local?.riderEnabled ?? config.riderEnabled) === true && ['H1', 'H4', 'D1'].includes(tf);
    return { enabled, tf };
}
export function isRiderExit(direction: 'BUY' | 'SELL', positionStartedAt: number, now: number, event?: RiderReversal): boolean {
    return !!event && event.confirmed === true
        && [positionStartedAt, now, event.observedAt, event.availableAt].every(Number.isFinite)
        && positionStartedAt > 0 && event.observedAt > positionStartedAt
        && event.availableAt >= event.observedAt && event.availableAt <= now
        && event.direction === (direction === 'BUY' ? 'Bearish' : 'Bullish');
}
