import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateGlobalRisk, evaluateAssetRisk, invalidateRiskCache, getFxDayStartMs,
    countDailySellsForTicker, countDailyBuysForTicker, countConsecutiveLossesForAsset } from '../../src/engine/PortfolioModel.js';
import type { GlobalPortfolioConfig } from '../../src/engine/Types.js';
import { createTradeRiskSnapshot } from '../../src/engine/TradeRisk.js';

const legacy = await import(new URL('../../scratch/execution_risk_fix/baseline/src/engine/PortfolioModel.ts', import.meta.url).href);

// Import only the pure PortfolioModel (its production imports are type-only).
const NOW = Date.parse('2026-10-21T12:40:00Z');
const DAY = getFxDayStartMs(NOW);
type Row = Record<string, any>;
function database(rows: Row[], fail = false) {
    let reads = 0;
    const query = (filters: Array<[string, string, any]> = []): any => ({
        where: (field: string, op: string, value: any) => query([...filters, [field, op, value]]),
        get: async () => {
            reads++;
            if (fail) throw new Error('test database unavailable');
            const selected = rows.filter(row => filters.every(([k, op, v]) => op === '>=' ? row[k] >= v : row[k] === v));
            return { empty: !selected.length, docs: selected.map((row, i) => ({ id: row.id ?? `doc-${i}`, data: () => row })) };
        },
    });
    return { db: { collection: (name: string) => { assert.equal(name, 'trade_journal'); return query(); } } as any,
        reads: () => reads };
}
const config = (extra: Partial<GlobalPortfolioConfig> = {}): GlobalPortfolioConfig => ({ enabled: true,
    maxDailyLossR: 2, dailyProfitTargetR: 0, maxTradesPerDay: 0, maxConsecutiveLosses: 0, trailingDrawdownR: 0, ...extra });
function closed(extra: Row = {}): Row {
    return { ticker: 'USOIL', direction: 'BUY', session: 'LONDON', mode: 'live',
        timestamp: DAY + 1000, closedAt: NOW - 1000, result: 'LOSS', rMultiple: -1, ...extra };
}
// Explicitly synthetic certified ledger rows, NOT recovered historical broker evidence.
// A one-EUR denominator keeps even the finite-overflow fixture internally consistent.
function certifiedClosed(extra: Row = {}): Row {
    const row = closed(extra);
    const riskSnapshot = createTradeRiskSnapshot({ ticker: row.ticker, direction: row.direction,
        currency: 'EUR', entryPrice: 100, initialSlPrice: row.direction === 'BUY' ? 99 : 101,
        filledVolumeCents: 100, quoteToAccountRate: 1, capturedAtMs: DAY + 1 });
    assert.ok(riskSnapshot);
    assert.equal(Object.isFrozen(riskSnapshot), true);
    return { riskSnapshot, accountCurrency: riskSnapshot.currency, riskAmountAccount: riskSnapshot.riskAmountAccount,
        ctrader_real_pnl: Number(row.rMultiple) * riskSnapshot.riskAmountAccount,
        riskAccountingStatus: 'VERIFIED', riskAccountingProvenance: 'broker_fill',
        closedAtSource: 'broker_execution', ...row };
}
async function global(rows: Row[], extra: Partial<GlobalPortfolioConfig> = {}, isBacktest = false) {
    invalidateRiskCache();
    return evaluateGlobalRisk(NOW, config(extra), 0, 'LONDON', database(rows).db, isBacktest, 'test');
}
const tests: Array<[string, () => Promise<void>]> = [];
function test(name: string, run: () => Promise<void>) { tests.push([name, run]); }

test('ISO and numeric closures use close-day, including positions opened more than 48h ago', async () => {
    for (const closedAt of [NOW - 1000, new Date(NOW - 1000).toISOString()]) {
        const rows = [certifiedClosed({ timestamp: DAY - 4 * 86400000, closedAt, rMultiple: -2.25 })];
        const result = await global(rows);
        assert.equal(result.isKilled, true, `must count true close at ${closedAt}`);
        assert.match(result.killReason!, /PnL: -2\.25R/);
        invalidateRiskCache();
        const asset = await evaluateAssetRisk(database(rows).db, 'USOIL', NOW, { maxDailyLossR: 2 });
        assert.equal(asset.isKilled, true);
        assert.match(asset.killReason!, /PnL: -2\.25R/);
    }
});

test('live realized ledger excludes non-trades, duplicates, open partials and future closes; orders ISO causally', async () => {
    const rows = [
        certifiedClosed({ id: 'loss', rMultiple: -1, closedAt: new Date(NOW - 3000).toISOString() }),
        certifiedClosed({ id: 'win', result: 'WIN', rMultiple: 1, closedAt: NOW - 2000 }),
        certifiedClosed({ id: 'loss2', rMultiple: -1, closedAt: new Date(NOW - 1000).toISOString() }),
        closed({ result: 'SKIP', rMultiple: -99 }), closed({ ctraderStatus: 'ABORTED', rMultiple: -99 }),
        closed({ duplicateOf: 'loss', rMultiple: -99 }),
        closed({ result: null, tp1Hit: true, tp1PartialPnlUsd: 100, rMultiple: 99 }),
        closed({ result: 'WIN', rMultiple: 99, closedAt: NOW + 1000 }),
        closed({ mode: 'backtesting', sessionId: 'test', rMultiple: -99 }),
        closed({ closedAt: DAY - 1, rMultiple: -99 }),
    ];
    assert.equal((await global(rows, { maxConsecutiveLosses: 2, maxTradesPerDay: 4 })).isKilled, false);
    invalidateRiskCache();
    assert.equal((await evaluateAssetRisk(database(rows).db, 'USOIL', NOW,
        { maxConsecutiveLosses: 2, maxTradesPerDay: 4, maxDailyLossR: 2 })).isKilled, false);
    // Reverse input order: +1, -1, -1 by actual close time, not entry time or input order.
    const ordered = [certifiedClosed({ closedAt: new Date(NOW - 1000).toISOString() }),
        certifiedClosed({ result: 'WIN', rMultiple: 1, closedAt: new Date(NOW - 3000).toISOString() }),
        certifiedClosed({ closedAt: new Date(NOW - 2000).toISOString() })];
    assert.match((await global(ordered, { maxConsecutiveLosses: 2 })).killReason!, /Consecutive Losses/);
});

test('unverified live R holds new entries without assumed credit or day latch; backtest keeps legacy fallback', async () => {
    for (const rMultiple of [null, undefined, NaN, Infinity, -Infinity, '', ' ', true, {}]) {
        for (const result of ['WIN', 'LOSS', 'BREAKEVEN']) {
            const rows = [closed({ result, rMultiple })];
            const held = await global(rows, { assumedWinR: 10 });
            assert.equal(held.isKilled, true, `${result} ${String(rMultiple)} must hold`);
            assert.match(held.killReason!, /risk-data-unverified.*accounting/);
            assert.equal(rows[0].riskSnapshot, undefined, 'unknown live risk stays unknown');
            assert.equal(held.killUntilMs, undefined, 'a data hold is not a strategy day latch');
            invalidateRiskCache();
            const asset = await evaluateAssetRisk(database(rows).db, 'USOIL', NOW, { maxDailyLossR: 2 });
            assert.equal(asset.isKilled, true);
            assert.match(asset.killReason!, /risk-data-unverified/);
        }
    }
    const bt = closed({ mode: 'backtesting', sessionId: 'test', result: 'WIN', rMultiple: null, closedAt: undefined });
    assert.match((await global([bt], { dailyProfitTargetR: 1 }, true)).killReason!, /Profit Target/);
    assert.equal((await global([bt], { dailyProfitTargetR: 1 })).isKilled, false);
});

test('missing legacy or invalid live close-time holds explicitly, never substitutes entry time', async () => {
    for (const closedAt of [undefined, null, NaN, Infinity, 'not-a-date', '', '2026-02-30T01:00:00Z', '2026-10-21']) {
        for (const result of ['WIN', 'LOSS']) {
            const rows = [closed({ closedAt, result, rMultiple: 3 })];
            const held = await global(rows);
            assert.equal(held.isKilled, true, `unknown close ${String(closedAt)}`);
            assert.match(held.killReason!, /risk-data-unverified.*close-time/);
            assert.equal(held.riskDataStatus, 'held');
            assert.equal(held.killUntilMs, undefined);
            invalidateRiskCache();
            assert.equal((await evaluateAssetRisk(database(rows).db, 'USOIL', NOW, { maxDailyLossR: 2 })).riskDataStatus, 'held');
        }
    }
    assert.match((await global([closed({ closedAt: undefined })])).killReason!, /legacy-closure-time-unknown/);
    assert.equal((await global([closed({ result: null, closedAt: undefined })])).isKilled, false);
});

test('live database failures hold independently of strategy limits, never reuse expired allow, recover on retry', async () => {
    invalidateRiskCache();
    for (const enabled of [true, false]) {
        const held = await evaluateGlobalRisk(NOW, config({ enabled }), 0, 'LONDON', undefined as any);
        assert.equal(held.riskDataStatus, 'held');
        assert.match(held.killReason!, /risk-data-unavailable/);
        assert.equal(held.killUntilMs, undefined);
    }
    assert.equal((await evaluateAssetRisk(undefined as any, 'USOIL', NOW, {})).riskDataStatus, 'held');
    assert.equal((await evaluateGlobalRisk(NOW, config(), 0, 'LONDON', undefined as any, true)).isKilled, false);
    for (const asset of [false, true]) {
        invalidateRiskCache();
        const good = database([]), bad = database([], true);
        const evaluate = (db: any, now: number) => asset
            ? evaluateAssetRisk(db, 'USOIL', now, {})
            : evaluateGlobalRisk(now, config({ enabled: false }), 0, 'LONDON', db);
        assert.equal((await evaluate(good.db, NOW)).isKilled, false);
        // Expected boundary error is captured so ordinary passing runs stay quiet.
        const errors: unknown[] = [], log = console.error;
        let first: any, second: any;
        try {
            console.error = (...args) => { errors.push(args); };
            [first, second] = await Promise.all([evaluate(bad.db, NOW + 31000), evaluate(bad.db, NOW + 31000)]);
        } finally { console.error = log; }
        assert.equal(first.riskDataStatus, 'held');
        assert.equal(second.riskDataStatus, 'held');
        assert.equal(bad.reads(), 1, 'concurrent failures share one read');
        assert.equal(errors.length, 1);
        assert.equal((await evaluate(good.db, NOW + 31001)).isKilled, false, 'failure must not be cached as an unresolved promise');
        assert.equal(good.reads(), 2);
    }
});

test('explicit actual-accounting uncertainty overrides stale finite R, without clamping legitimate large R', async () => {
    for (const fields of [{ riskAccountingStatus: 'UNVERIFIED' }, { riskAccountingStatus: 'INVALID' },
        { riskAccountingStatus: 'VERIFIED', riskAccountingProvenance: 'missing_fill_snapshot' }]) {
        const rows = [certifiedClosed({ result: 'WIN', rMultiple: 4, ...fields })];
        assert.match((await global(rows)).killReason!, /risk-data-unverified.*accounting/);
        invalidateRiskCache();
        assert.equal((await evaluateAssetRisk(database(rows).db, 'USOIL', NOW, {})).riskDataStatus, 'held');
    }
    assert.match((await global([certifiedClosed({ result: 'WIN', rMultiple: 24 })], { dailyProfitTargetR: 20 })).killReason!, /PnL: 24\.00R/);
    assert.match((await global([certifiedClosed({ result: 'BREAKEVEN', rMultiple: -12 })])).killReason!, /PnL: -12\.00R/);
    assert.equal((await global([certifiedClosed({ result: 'WIN', rMultiple: '2.5' })])).isKilled, false);
    const overflow = [certifiedClosed({ result: 'WIN', rMultiple: 1e308 }), certifiedClosed({ result: 'WIN', rMultiple: 1e308 })];
    assert.match((await global(overflow)).killReason!, /risk-data-unverified.*nonfinite-total/);
});

test('direction/day counters remain entry counts (including open partials), excluding rejected and duplicate live entries', async () => {
    for (const direction of ['BUY', 'SELL'] as const) {
        const rows = [closed({ direction, id: 'open', result: null, closedAt: null, tp1Hit: true }),
            closed({ direction, id: 'closed' }),
            closed({ direction, result: 'SKIP' }), closed({ direction, ctraderStatus: 'ABORTED' }),
            closed({ direction, duplicateOf: 'closed' }),
            closed({ direction, timestamp: DAY - 1 }), closed({ direction, timestamp: NOW + 1 }),
            closed({ direction, mode: 'backtesting', sessionId: 'test' }),
            closed({ direction: direction === 'BUY' ? 'SELL' : 'BUY' }), closed({ direction, ticker: 'OTHER' })];
        invalidateRiskCache();
        const counter = direction === 'BUY' ? countDailyBuysForTicker : countDailySellsForTicker;
        assert.equal(await counter(database(rows).db, 'USOIL', NOW), 2);
        invalidateRiskCache();
        assert.equal(await counter(database(rows).db, 'USOIL', NOW, true, 'test'), 1);
        invalidateRiskCache();
        assert.equal(await counter(database([closed({ ticker: 'US100', direction, result: null })]).db, 'NAS100', NOW), 1);
    }
});

test('live directional loss streak uses actual close order, includes prior-day entries and never resets on unknown R', async () => {
    const rows = [closed({ closedAt: NOW - 1000, result: 'WIN', rMultiple: null }),
        certifiedClosed({ timestamp: DAY - 4 * 86400000, closedAt: new Date(NOW - 2000).toISOString() }),
        certifiedClosed({ closedAt: NOW - 3000 }), certifiedClosed({ closedAt: NOW - 4000, result: 'WIN', rMultiple: 1 }),
        closed({ duplicateOf: 'a', rMultiple: 99 }), closed({ result: 'SKIP', rMultiple: 99 }),
        closed({ ctraderStatus: 'ABORTED', rMultiple: 99 }), closed({ result: null, rMultiple: 99 }),
        closed({ rMultiple: 99, closedAt: NOW + 1 }), closed({ rMultiple: 99, closedAt: null }),
        closed({ rMultiple: 99, session: 'ASIA' }), closed({ rMultiple: 99, mode: 'backtesting' })];
    invalidateRiskCache();
    assert.equal(await countConsecutiveLossesForAsset(database(rows).db, 'USOIL', 'LONDON', 'BUY', NOW, config()), 2);
});

test('unmarked copies of the same broker position count once; contradictory copies hold rather than choose credit', async () => {
    const rows = [certifiedClosed({ id: 'one', ctraderPositionId: '123', rMultiple: -1 }),
        certifiedClosed({ id: 'two', ctraderPositionId: '123', rMultiple: -1 })];
    assert.equal((await global(rows, { maxTradesPerDay: 2 })).isKilled, false);
    invalidateRiskCache();
    assert.equal((await evaluateAssetRisk(database(rows).db, 'USOIL', NOW, { maxTradesPerDay: 2 })).isKilled, false);
    invalidateRiskCache();
    assert.equal(await countDailyBuysForTicker(database(rows).db, 'USOIL', NOW), 1);
    invalidateRiskCache();
    assert.equal(await countConsecutiveLossesForAsset(database(rows).db, 'USOIL', 'LONDON', 'BUY', NOW, config()), 1);
    rows[1] = certifiedClosed({ id: 'two', ctraderPositionId: '123', result: 'WIN', rMultiple: 3 });
    assert.match((await global(rows)).killReason!, /risk-data-unverified.*duplicate-conflict/);
});

test('cache cannot carry disabled limits or yesterday decisions into a new live policy/day', async () => {
    const db = database([certifiedClosed({ rMultiple: -2 })]).db;
    invalidateRiskCache();
    assert.equal((await evaluateGlobalRisk(NOW, config({ enabled: false }), 0, 'LONDON', db)).isKilled, false);
    assert.equal((await evaluateGlobalRisk(NOW + 1, config(), 0, 'LONDON', db)).isKilled, true);
    invalidateRiskCache();
    assert.equal((await evaluateAssetRisk(db, 'USOIL', NOW, {})).isKilled, false);
    assert.equal((await evaluateAssetRisk(db, 'USOIL', NOW + 1, { maxDailyLossR: 2 })).isKilled, true);
    const rollover = Date.parse('2026-10-21T21:00:00Z');
    invalidateRiskCache();
    assert.equal((await evaluateGlobalRisk(rollover - 1, config(), 0, 'LONDON', db)).isKilled, true);
    assert.equal((await evaluateGlobalRisk(rollover + 1, config(), 0, 'LONDON', db)).isKilled, false);
});

test('saved history remains unknown to current gate; frozen PRE reproduces causal oil arithmetic without invented fill evidence', async () => {
    const journal = JSON.parse(readFileSync(new URL('../../scratch/review_20261021/firestore.json', import.meta.url), 'utf8')).journal as Row[];
    const deals = JSON.parse(readFileSync(new URL('../../scratch/review_20261021/broker.json', import.meta.url), 'utf8')).deals.deals as Row[];
    const oil = journal.find(t => t.id === 'WLF073')!;
    assert.equal(oil.rMultiple, -0.12);
    const close = deals.find(d => String(d.positionId) === oil.ctraderPositionId && d.closePositionDetail)!;
    assert.ok(close.executionTimestamp < NOW);
    const detail = close.closePositionDetail;
    const pnl = (detail.grossProfit + detail.commission + detail.swap) / 10 ** detail.moneyDigits;
    // Forensic reconstruction ONLY for this saved fixture, not a production legacy-risk backfill:
    // its historical original stop + actual broker volume and conversion prove the unit bug.
    const risk = Math.abs(oil.entryPrice - oil.initialSlPrice) * (detail.closedVolume / 100) * detail.quoteToDepositConversionRate;
    const correctedOilR = Math.round((pnl / risk) * 10000) / 10000;
    assert.equal(correctedOilR, -1.3458);
    const before = JSON.stringify(journal);
    const historical = journal.filter(t => t.ctraderPositionId);
    assert.equal(historical.length, 15);
    assert.ok(historical.every(t => !t.riskSnapshot), 'all original histories lack frozen fill risk');
    const corrected = journal.map(t => t.id === oil.id ? { ...t, rMultiple: correctedOilR } : t);
    for (const rows of [journal, corrected]) {
        const held = await global(rows);
        assert.equal(held.isKilled, true);
        assert.equal(held.riskDataStatus, 'held');
        assert.match(held.killReason!, /risk-data-unverified.*accounting/);
        assert.equal(held.killUntilMs, undefined);
    }
    // PRE has no causal ISO close filter: supply ONLY realized closures known by NOW.
    // Never forge broker_fill snapshots for these 15 historical records.
    const causal = (rows: Row[]) => rows.filter(t => ['WIN', 'LOSS', 'BREAKEVEN'].includes(t.result)
        && Date.parse(t.closedAt) <= NOW);
    assert.ok(!causal(journal).some(t => ['AVJBUF', 'R2V3ZH'].includes(t.id)), 'future closes must not leak into the forensic decision');
    legacy.invalidateRiskCache();
    const baseline = await legacy.evaluateGlobalRisk(NOW, config(), 0, 'LONDON', database(causal(journal)).db);
    assert.equal(baseline.isKilled, false, JSON.stringify(baseline));
    legacy.invalidateRiskCache();
    const decision = await legacy.evaluateGlobalRisk(NOW, config(), 0, 'LONDON', database(causal(corrected)).db);
    assert.equal(decision.isKilled, true);
    assert.match(decision.killReason!, /Max Daily Loss.*PnL: -2\.33R/);
    assert.equal(JSON.stringify(journal), before, 'the replay must never mutate its source');
    console.log(`REPLAY current: both stored/corrected oil R held (15 unknown histories); frozen PRE causal oil -0.12R => allow; oil ${correctedOilR}R => ${decision.killReason}`);
});

test('actual accounting with unknown close-time provenance cannot claim a dated verified closure', async () => {
    const rows = [closed({ result: 'WIN', rMultiple: 3, closedAtSource: 'unknown', riskAccountingStatus: 'VERIFIED' })];
    assert.match((await global(rows)).killReason!, /risk-data-unverified.*close-time.*provenance/);
    invalidateRiskCache();
    assert.equal((await evaluateAssetRisk(database(rows).db, 'USOIL', NOW, {})).riskDataStatus, 'held');
});

test('BACKTEST differential: legacy global/asset limits, entry counts and directional streaks stay unchanged', async () => {
    // Frozen pre-task source, imported directly: only erased type imports, no bot/services/bootstrap.
    const legacy = await import(new URL('../../scratch/execution_risk_fix/baseline/src/engine/PortfolioModel.ts', import.meta.url).href);
    const fixtures = [
        [closed({ mode: 'backtesting', sessionId: 'test', closedAt: undefined, result: 'WIN', rMultiple: null })],
        [closed({ mode: 'backtesting', sessionId: 'test', result: 'BREAKEVEN', rMultiple: -20 })],
        [closed({ mode: 'backtesting', sessionId: 'test', result: 'LOSS', rMultiple: -40, duplicateOf: 'old', ctraderStatus: 'ABORTED' })],
        [closed({ mode: 'backtesting', sessionId: 'test', closedAt: new Date(NOW + 1000).toISOString(), result: 'WIN', rMultiple: 50 }),
            closed({ mode: 'backtesting', sessionId: 'test', closedAt: undefined, rMultiple: null }),
            closed({ mode: 'backtesting', sessionId: 'other', result: 'WIN', rMultiple: 50 }), closed({ rMultiple: -99 })],
    ];
    for (const rows of fixtures) {
        for (const limits of [{ maxDailyLossR: 1 }, { dailyProfitTargetR: 1 }, { maxTradesPerDay: 1 },
            { maxConsecutiveLosses: 1 }, { trailingDrawdownR: 1 }]) {
            invalidateRiskCache(); legacy.invalidateRiskCache();
            const cfg = config(limits), db = database(rows).db;
            assert.deepEqual(await evaluateGlobalRisk(NOW, cfg, 0, 'LONDON', db, true, 'test'),
                await legacy.evaluateGlobalRisk(NOW, cfg, 0, 'LONDON', db, true, 'test'));
            assert.deepEqual(await evaluateAssetRisk(db, 'USOIL', NOW, limits, 1.5, true, 'test'),
                await legacy.evaluateAssetRisk(db, 'USOIL', NOW, limits, 1.5, true, 'test'));
        }
        invalidateRiskCache(); legacy.invalidateRiskCache();
        const db = database(rows).db;
        assert.equal(await countDailyBuysForTicker(db, 'USOIL', NOW, true, 'test'),
            await legacy.countDailyBuysForTicker(db, 'USOIL', NOW, true, 'test'));
        assert.equal(await countConsecutiveLossesForAsset(db, 'USOIL', 'LONDON', 'BUY', NOW, config(), true, 'test'),
            await legacy.countConsecutiveLossesForAsset(db, 'USOIL', 'LONDON', 'BUY', NOW, config(), true, 'test'));
    }
});

let failed = 0;
for (const [name, run] of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
console.log(`${tests.length - failed}/${tests.length} portfolio accounting tests passed`);
if (failed) process.exitCode = 1;
