/** Broker volume is cents of base units, NOT lots or cents of account money. */
export interface TradeRiskSnapshot {
    readonly schema: 1;
    readonly ticker: string;
    readonly direction: 'BUY' | 'SELL';
    readonly currency: string;
    readonly entryPrice: number;
    readonly initialSlPrice: number;
    readonly filledVolumeCents: number;
    readonly quoteToAccountRate: number;
    readonly riskAmountAccount: number;
    readonly capturedAtMs: number;
    readonly source: 'broker_fill';
}
export type TradeRiskInput = Omit<TradeRiskSnapshot, 'schema' | 'source' | 'riskAmountAccount'>;

export function createTradeRiskSnapshot(input: TradeRiskInput): TradeRiskSnapshot | null {
    if (!input || typeof input.ticker !== 'string' || !/^[A-Z0-9][A-Z0-9._/-]*$/.test(input.ticker)
        || typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)
        || (input.direction !== 'BUY' && input.direction !== 'SELL')
        || ![input.entryPrice, input.initialSlPrice, input.quoteToAccountRate].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)
        || !Number.isSafeInteger(input.filledVolumeCents) || input.filledVolumeCents <= 0
        || !Number.isSafeInteger(input.capturedAtMs) || input.capturedAtMs <= 0
        || (input.direction === 'BUY' ? input.initialSlPrice >= input.entryPrice : input.initialSlPrice <= input.entryPrice)) return null;
    const riskAmountAccount = Math.abs(input.entryPrice - input.initialSlPrice) * (input.filledVolumeCents / 100) * input.quoteToAccountRate;
    if (!Number.isFinite(riskAmountAccount) || riskAmountAccount <= 0) return null;
    return Object.freeze({ schema: 1 as const, source: 'broker_fill' as const,
        ticker: input.ticker, direction: input.direction, currency: input.currency,
        entryPrice: input.entryPrice, initialSlPrice: input.initialSlPrice, filledVolumeCents: input.filledVolumeCents,
        quoteToAccountRate: input.quoteToAccountRate, capturedAtMs: input.capturedAtMs, riskAmountAccount });
}

export type RiskAccountingStatus = 'VERIFIED' | 'UNVERIFIED' | 'INVALID';

export interface ClosedTradeAccounting {
    result: 'WIN' | 'LOSS' | 'BREAKEVEN';
    pnl: number;
    rMultiple: number | null;
    slHit: boolean;
    /** Legacy field name: the value is in accountCurrency, NOT necessarily USD. */
    balanceAfterUsd: number | null;
    accountCurrency: string | null;
    riskAmountAccount: number | null;
    riskAccountingStatus: RiskAccountingStatus;
    riskAccountingProvenance: 'broker_fill' | 'missing_fill_snapshot' | 'snapshot_mismatch' | 'unverified_account_currency';
    closedAt: string | null;
    closedAtSource: 'broker_execution' | 'unknown';
    entryPrice: number;
    filledVolumeCents: number;
}

/** Pure actual-accounting boundary. No quote lookup, lot classification, or theoretical R fallback. */
export function resolveTradeCloseAccounting(positionId: string, trade: any, deals: readonly any[], accountCurrency: string | null): ClosedTradeAccounting | null {
    if (!positionId || !Array.isArray(deals) || !trade || (trade.ctraderPositionId != null && String(trade.ctraderPositionId) !== positionId)) return null;
    const unique = new Map<string, any>();
    for (const d of deals) {
        if (!d || d.dealId == null || String(d.positionId) !== positionId) return null;
        const key = String(d.dealId);
        if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(d)) return null;
        unique.set(key, d);
    }
    const history = [...unique.values()];
    // Identity is checked across the complete history, including unfilled attempts.
    if (new Set(history.map(d => d.symbolId).filter(v => v != null)).size > 1
        || (trade.symbolId != null && history.some(d => d.symbolId != null && Number(d.symbolId) !== Number(trade.symbolId)))) return null;
    // Rejected attempts are not executions only when the broker explicitly reports
    // zero filled volume and no financial/execution evidence. Ambiguity stays held.
    const all = history.filter(d => !(d.filledVolume === 0 && [4, 5, 6, 7].includes(Number(d.dealStatus))
        && !d.closePositionDetail && (d.executionPrice === undefined || d.executionPrice === 0)
        && [d.commission, d.swap, d.grossProfit, d.pnl].every(v => v === undefined || v === 0)));
    const openings = all.filter(d => !d.closePositionDetail);
    const closings = all.filter(d => d.closePositionDetail);
    if (!openings.length || !closings.length) return null;
    const volume = (d: any) => d.filledVolume; // Requested volume is never executed-volume evidence.
    if (all.some(d => !Number.isSafeInteger(volume(d)) || volume(d) <= 0 || (d.dealStatus != null && ![2, 3].includes(Number(d.dealStatus))))) return null;
    const opened = openings.reduce((sum, d) => sum + volume(d), 0);
    const closed = closings.reduce((sum, d) => sum + Number(d.closePositionDetail.closedVolume), 0);
    if (!Number.isSafeInteger(opened) || closed !== opened || closings.some(d => !Number.isSafeInteger(Number(d.closePositionDetail.closedVolume)) || Number(d.closePositionDetail.closedVolume) <= 0 || Number(d.closePositionDetail.closedVolume) !== volume(d))) return null;
    if (computeTradeRiskR(0, trade.riskSnapshot) !== null && trade.riskSnapshot.filledVolumeCents !== opened) return null;
    if (openings.some(d => !Number.isFinite(Number(d.executionPrice)) || Number(d.executionPrice) <= 0)) return null;
    const side = trade.direction === 'BUY' ? 1 : trade.direction === 'SELL' ? 2 : 0;
    if (!side || openings.some(d => Number(d.tradeSide) !== side)
        || closings.some(d => Number(d.tradeSide) !== (side === 1 ? 2 : 1))) return null;
    const entryPrice = openings.reduce((sum, d) => sum + Number(d.executionPrice) * volume(d), 0) / opened;
    let pnl = 0, precision = 0;
    for (const d of closings) {
        const cp = d.closePositionDetail;
        const digits = Number(cp.moneyDigits ?? d.moneyDigits);
        if (!Number.isInteger(digits) || digits < 0 || digits > 8 || ![cp.grossProfit, cp.commission, cp.swap ?? 0].every(v => typeof v === 'number' && Number.isSafeInteger(v))) return null;
        precision = Math.max(precision, digits);
        // Opening commission is informative for this broker account; close details already include it.
        pnl += (cp.grossProfit + cp.commission + (cp.swap ?? 0)) / 10 ** digits;
    }
    if (!Number.isFinite(pnl)) return null;
    pnl = Number(pnl.toFixed(precision));
    const finalDeal = closings.reduce((best, d) => Number(d.closePositionDetail.balanceVersion ?? 0) > Number(best.closePositionDetail.balanceVersion ?? 0)
        || (Number(d.closePositionDetail.balanceVersion ?? 0) === Number(best.closePositionDetail.balanceVersion ?? 0) && Number(d.executionTimestamp ?? 0) > Number(best.executionTimestamp ?? 0)) ? d : best);
    const cp = finalDeal.closePositionDetail;
    const balanceAfterUsd = typeof cp.balance === 'number' && Number.isFinite(cp.balance) ? cp.balance / 10 ** Number(cp.moneyDigits ?? finalDeal.moneyDigits) : null;
    const closedAtMs = Math.max(...closings.map(d => Number(d.executionTimestamp)));
    const closedAt = Number.isSafeInteger(closedAtMs) && closedAtMs > 0 && closedAtMs <= 8640000000000000 ? new Date(closedAtMs).toISOString() : null;
    const currency = typeof accountCurrency === 'string' && /^[A-Z]{3}$/.test(accountCurrency) ? accountCurrency : null;
    const s = trade.riskSnapshot;
    const checkedR = computeTradeRiskR(pnl, s);
    const matches = checkedR !== null && currency !== null && s.currency === currency && (trade.accountCurrency == null || trade.accountCurrency === currency)
        && s.ticker === trade.ticker && s.direction === trade.direction && s.filledVolumeCents === opened
        && Math.abs(s.entryPrice - entryPrice) <= Math.max(1, entryPrice) * 1e-12;
    return { result: pnl > 0.1 ? 'WIN' : pnl < -0.1 ? 'LOSS' : 'BREAKEVEN', pnl, slHit: all.some(d => d.stopTriggerBase === 'STOP_LOSS' || d.closePositionDetail?.closeTriggerBase === 'STOP_LOSS'),
        balanceAfterUsd, accountCurrency: currency, rMultiple: matches ? checkedR : null, riskAmountAccount: matches ? s.riskAmountAccount : null,
        riskAccountingStatus: matches ? 'VERIFIED' : !currency ? 'UNVERIFIED' : s ? 'INVALID' : 'UNVERIFIED',
        riskAccountingProvenance: matches ? 'broker_fill' : !currency ? 'unverified_account_currency' : s ? 'snapshot_mismatch' : 'missing_fill_snapshot',
        closedAt, closedAtSource: closedAt ? 'broker_execution' : 'unknown', entryPrice, filledVolumeCents: opened };
}
/** Re-freeze persisted evidence on hydration; never let a second fill argument replace the initial denominator. */
export function freezeTradeRiskForTrade(trade: any, incoming?: TradeRiskSnapshot | null): boolean {
    const candidate = trade?.riskSnapshot ?? incoming;
    if (!trade) return false;
    if (!candidate) { trade.riskAccountingStatus = 'UNVERIFIED'; return false; }
    const frozen = createTradeRiskSnapshot(candidate);
    if (!frozen || computeTradeRiskR(0, candidate) === null || frozen.ticker !== trade.ticker || frozen.direction !== trade.direction
        || (trade.accountCurrency != null && trade.accountCurrency !== frozen.currency)) {
        trade.riskAccountingStatus = 'INVALID';
        return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(trade, 'riskSnapshot');
    if (descriptor?.configurable !== false) {
        Object.defineProperty(trade, 'riskSnapshot', { value: frozen, enumerable: true, writable: false, configurable: false });
    } else if (!Object.isFrozen(trade.riskSnapshot)) {
        trade.riskAccountingStatus = 'INVALID';
        return false;
    }
    trade.accountCurrency = frozen.currency;
    trade.riskAccountingStatus = 'VERIFIED';
    return true;
}

export function computeTradeRiskR(pnlAccount: number, snapshot: TradeRiskSnapshot | null | undefined): number | null {
    if (!Number.isFinite(pnlAccount) || snapshot?.schema !== 1 || snapshot.source !== 'broker_fill') return null;
    const checked = createTradeRiskSnapshot(snapshot);
    if (!checked || checked.riskAmountAccount !== snapshot.riskAmountAccount) return null;
    const r = pnlAccount / checked.riskAmountAccount;
    return Number.isFinite(r) ? r : null;
}
