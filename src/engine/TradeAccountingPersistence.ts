import type { ClosedTradeAccounting } from './TradeRisk.js';
import { invalidateRiskCache } from './PortfolioModel.js';

/** Commit a complete broker closure before callers remove management state.
 * Legacy monetary field names remain compatible; values are deposit currency.
 * No result/price estimation belongs at this persistence boundary.
 */
export async function commitTradeCloseAccounting(
    db: any, journalId: string, accounting: ClosedTradeAccounting,
    extra: Record<string, unknown> = {},
): Promise<void> {
    if (!db || typeof journalId !== 'string' || !journalId || ['ERR','N/A'].includes(journalId)) {
        throw new Error('CLOSE_ACCOUNTING_PENDING: database or journal identity unavailable');
    }
    if (!accounting || !Number.isFinite(accounting.pnl) || !accounting.closedAt ||
        accounting.closedAtSource !== 'broker_execution' || !Number.isFinite(Date.parse(accounting.closedAt))) {
        throw new Error('CLOSE_ACCOUNTING_PENDING: complete broker close evidence unavailable');
    }
    const fields = {
        ...extra,
        result: accounting.result, rMultiple: accounting.rMultiple,
        ctrader_real_pnl: accounting.pnl, balanceAfterUsd: accounting.balanceAfterUsd,
        accountCurrency: accounting.accountCurrency, riskAmountAccount: accounting.riskAmountAccount,
        riskAccountingStatus: accounting.riskAccountingStatus,
        riskAccountingProvenance: accounting.riskAccountingProvenance,
        slHit: accounting.slHit, closedAt: accounting.closedAt, closedAtSource: accounting.closedAtSource,
        ctraderStatus: 'EXECUTED', reconciled: true,
        executionIncidentPending: false, executionUncertain: false,
        closeAccountingPending: false, executionFillUnverified: false,
    };
    // Invalidate both an existing decision and a read started during the write.
    // Failure must not leave the pre-close permission alive either.
    invalidateRiskCache();
    try {
        await db.collection('trade_journal').doc(journalId).set(fields, { merge: true });
    } finally {
        invalidateRiskCache();
    }
}
