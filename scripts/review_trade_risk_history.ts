#!/usr/bin/env -S npx tsx
/** Strictly offline. Proposal-only: this module never imports Firebase, broker services or application startup. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveTradeCloseAccounting } from '../src/engine/TradeRisk.js';

function main(): void {
    const args = process.argv.slice(2);
    const opts: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
        if (!['--snapshot', '--broker', '--since', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || opts[args[i]]) throw new Error(`Unsupported argument or missing/duplicate value: ${args[i]}`);
        opts[args[i]] = args[i + 1];
    }
    for (const key of ['--snapshot', '--broker', '--since', '--out']) if (!opts[key]) throw new Error(`Required: ${key}`);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(opts['--since']) || !Number.isFinite(Date.parse(opts['--since']))) throw new Error('--since must be an ISO timestamp with explicit timezone');
    const inputPaths = [opts['--snapshot'], opts['--broker']].map(p => fs.realpathSync(p));
    const outputPath = path.resolve(opts['--out']);
    if (inputPaths.includes(outputPath) || (fs.existsSync(outputPath) && inputPaths.includes(fs.realpathSync(outputPath)))) throw new Error('--out must not overwrite input evidence');
    const snapshotText = fs.readFileSync(inputPaths[0], 'utf8');
    const brokerText = fs.readFileSync(inputPaths[1], 'utf8');
    const snapshot = JSON.parse(snapshotText), broker = JSON.parse(brokerText);
    const since = Date.parse(opts['--since']);
    if (!Array.isArray(snapshot.journal) || !Array.isArray(broker.deals?.deals) || !Array.isArray(broker.symbols)) throw new Error('Expected offline Firestore journal and broker deals/symbols snapshot');
    const currency = snapshot.system?.find((r: any) => r.id === 'account_state')?.currency ?? broker.state?.currency ?? null;
    const issues: string[] = [];
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) issues.push('Verified account currency absent from input evidence');
    if (broker.deals.hasMore !== false) issues.push('Broker deal pagination is not proven complete');
    const byId = new Map<string, any>();
    for (const d of broker.deals.deals) {
        if (d.dealId == null) { issues.push('Deal without identity'); continue; }
        const id = String(d.dealId);
        if (byId.has(id) && JSON.stringify(byId.get(id)) !== JSON.stringify(d)) issues.push(`Conflicting duplicate deal ${id}`);
        byId.set(id, d);
    }
    const deals = [...byId.values()];
    const byPosition = new Map<string, any[]>();
    for (const d of deals) { const pid = String(d.positionId); byPosition.set(pid, [...(byPosition.get(pid) ?? []), d]); }
    const journal = snapshot.journal.filter((j: any) => j.ctraderPositionId && j.mode !== 'backtesting'
        && (Number(j.timestamp) >= since || (byPosition.get(String(j.ctraderPositionId)) ?? []).some(d => d.closePositionDetail && Number(d.executionTimestamp) >= since)));
    const selected = new Set<string>(journal.map((j: any) => String(j.ctraderPositionId)));
    if (selected.size !== journal.length) issues.push('Multiple selected journals map to one position; no automatic deduplication of journal evidence');
    const brokerPositions = new Set<string>(deals.filter(d => d.closePositionDetail && Number(d.executionTimestamp) >= since).map(d => String(d.positionId)));
    const countsMatch = selected.size === brokerPositions.size && [...selected].every(p => brokerPositions.has(p));
    if (!countsMatch) issues.push('Journal/broker position coverage differs');
    const assetCurrencies = new Map<number, string>();
    for (const s of broker.symbols) {
        if (s.symbolCategoryId !== 1 || !/^[A-Z]{6}$/.test(s.symbolName)) continue;
        for (const [id, code] of [[s.baseAssetId, s.symbolName.slice(0, 3)], [s.quoteAssetId, s.symbolName.slice(3)]] as [number, string][]) {
            if (assetCurrencies.has(id) && assetCurrencies.get(id) !== code) issues.push(`Conflicting asset currency metadata ${id}`);
            assetCurrencies.set(id, code);
        }
    }
    const trades = journal.map((j: any) => {
        const pid = String(j.ctraderPositionId), ds = byPosition.get(pid) ?? [];
        const accounting = resolveTradeCloseAccounting(pid, j, ds, currency);
        if (!accounting) issues.push(`Incomplete or invalid deal history ${j.id}/${pid}`);
        const closeDeals = ds.filter(d => d.closePositionDetail).sort((a, b) => Number(a.executionTimestamp) - Number(b.executionTimestamp));
        const finalDeal = closeDeals.at(-1);
        const symbol = broker.symbols.find((s: any) => Number(s.symbolId) === Number(ds[0]?.symbolId));
        const quoteCurrency = assetCurrencies.get(symbol?.quoteAssetId) ?? null;
        const identityConversion = quoteCurrency !== null && quoteCurrency === currency;
        const rate = identityConversion ? 1 : finalDeal?.closePositionDetail?.quoteToDepositConversionRate;
        const initialSl = Number(j.initialSlPrice ?? j.originalSlPrice);
        const entry = accounting?.entryPrice;
        const sideValid = entry != null && (j.direction === 'BUY' ? initialSl < entry : initialSl > entry);
        const risk = sideValid && Number.isFinite(rate) && rate > 0 && initialSl > 0 && accounting
            ? Math.abs(accounting.entryPrice - initialSl) * (accounting.filledVolumeCents / 100) * rate : null;
        // A reconstruction is evidence for review, NEVER a forged broker_fill snapshot or exact opening rate.
        const reconstruction = risk && Number.isFinite(risk) ? {
            provenance: 'historical_reconstruction_NOT_broker_fill', initialSlSource: j.initialSlPrice != null ? 'journal.initialSlPrice' : 'journal.originalSlPrice',
            entrySource: 'weighted_broker_opening_fills', filledVolumeCents: accounting!.filledVolumeCents, quoteCurrency,
            quoteToAccountRate: rate, rateSource: identityConversion ? 'quote_equals_account_currency' : 'close_deal_NOT_opening_rate',
            riskAmountAccount: risk, rMultiple: accounting!.pnl / risk,
            exactOpeningRisk: false,
            limitations: identityConversion ? ['Initial SL comes from journal, not independently verified broker fill protection']
                : ['Opening quote conversion unavailable; closing rate is NOT the opening rate', 'Initial SL comes from journal, not independently verified broker fill protection'],
        } : null;
        return { id: j.id, ticker: j.ticker, positionId: pid,
            original: { result: j.result ?? null, ctrader_real_pnl: j.ctrader_real_pnl ?? null, rMultiple: j.rMultiple ?? null, closedAt: j.closedAt ?? null },
            broker: accounting, reconstruction,
            patch: accounting ? { rMultiple: accounting.rMultiple, riskAmountAccount: accounting.riskAmountAccount,
                accountCurrency: accounting.accountCurrency, riskAccountingStatus: accounting.riskAccountingStatus,
                riskAccountingProvenance: accounting.riskAccountingProvenance, closedAt: accounting.closedAt, closedAtSource: accounting.closedAtSource } : null,
            pnlPreserved: true, resultPreserved: true,
            pnlMatchesJournal: accounting && typeof j.ctrader_real_pnl === 'number' ? Math.abs(j.ctrader_real_pnl - accounting.pnl) < 1e-8 : null,
            resultMatchesJournal: accounting ? j.result === accounting.result : null,
            evidence: { dealIds: ds.map(d => String(d.dealId)), symbolId: symbol?.symbolId ?? null },
        };
    }).sort((a: any, b: any) => String(a.broker?.closedAt ?? '').localeCompare(String(b.broker?.closedAt ?? '')) || a.id.localeCompare(b.id));
    const closeChain = deals.filter(d => d.closePositionDetail).sort((a, b) => Number(a.closePositionDetail.balanceVersion) - Number(b.closePositionDetail.balanceVersion));
    const money = (d: any, name: string) => Number(d.closePositionDetail[name] ?? 0) / 10 ** Number(d.closePositionDetail.moneyDigits ?? d.moneyDigits);
    const periodCloses = closeChain.filter(d => Number(d.executionTimestamp) >= since);
    const predecessor = closeChain.filter(d => Number(d.executionTimestamp) < since).at(-1);
    let previous = predecessor;
    const balanceSteps = periodCloses.map(d => {
        const net = money(d, 'grossProfit') + money(d, 'commission') + money(d, 'swap');
        const actual = money(d, 'balance');
        const before = previous ? money(previous, 'balance') : null;
        const residual = before === null ? null : actual - before - net;
        const versionContiguous = previous != null && Number(d.closePositionDetail.balanceVersion) === Number(previous.closePositionDetail.balanceVersion) + 1;
        previous = d;
        return { dealId: String(d.dealId), net, before, after: actual, residual, versionContiguous, matches: residual !== null && Number.isFinite(residual) && Math.abs(residual) < 1e-7 && versionContiguous };
    });
    const finalBalance = periodCloses.length ? money(periodCloses.at(-1), 'balance') : null;
    const accountBalance = broker.state?.balance;
    const balanceReconciled = balanceSteps.length > 0 && balanceSteps.every(s => s.matches) && typeof accountBalance === 'number' && finalBalance !== null && Math.abs(finalBalance - accountBalance) < 1e-7;
    if (!balanceReconciled) issues.push('Independent before/after broker balance chain does not reconcile');
    const resolved = trades.filter((t: any) => t.broker !== null).length;
    const summary = { trades: trades.length, resolved, exactRisk: trades.filter((t: any) => t.broker?.riskAccountingStatus === 'VERIFIED').length,
        unknownRisk: trades.filter((t: any) => t.broker?.riskAccountingStatus !== 'VERIFIED').length,
        accountCurrency: currency, netPnlAccount: Number(trades.reduce((sum: number, t: any) => sum + (t.broker?.pnl ?? 0), 0).toFixed(8)),
        beforeBalance: predecessor ? money(predecessor, 'balance') : null, finalBalance };
    const proposal = { schema: 1, mode: 'OFFLINE_PROPOSAL_ONLY', since: opts['--since'], eligibleForReview: issues.length === 0,
        inputs: inputPaths.map((p, i) => ({ path: p, sha256: createHash('sha256').update(i === 0 ? snapshotText : brokerText).digest('hex') })),
        safeguards: ['No apply mode', 'No broker or database imports', 'Preserve original result and monetary PnL', 'No historical broker_fill snapshots', 'Unknown exact R remains null'],
        summary, checks: { countsMatch, balanceReconciled, journalPositions: selected.size, brokerClosedPositions: brokerPositions.size, closeDeals: periodCloses.length, balanceSteps }, issues, trades };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ out: outputPath, ...summary, countsMatch, balanceReconciled, issues }));
    if (issues.length) process.exitCode = 2;
}
try { main(); } catch (error: any) { console.error(error.message); process.exitCode = 1; }
