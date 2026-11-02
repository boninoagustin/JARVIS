import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as risk from '../../src/engine/TradeRisk.js';
import * as portfolio from '../../src/engine/PortfolioModel.js';
import { commitTradeCloseAccounting } from '../../src/engine/TradeAccountingPersistence.js';

const source = fs.readFileSync('src/db/trading.ts', 'utf8');
const ast = ts.createSourceFile('trading.ts', source, ts.ScriptTarget.Latest, true);
function nodes(predicate: (n: ts.Node) => boolean): ts.Node[] {
    const found: ts.Node[] = []; (function visit(n: ts.Node) { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); })(ast); return found;
}
function fn(name: string): string {
    const n = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name); assert.ok(n, name); return n.getText(ast);
}
const now = Date.parse('2026-10-22T15:00:00Z');
const snapshot = risk.createTradeRiskSnapshot({ ticker: 'EURUSD', direction: 'BUY', currency: 'EUR', entryPrice: 1.1,
    initialSlPrice: 1.09, filledVolumeCents: 10000, quoteToAccountRate: .9, capturedAtMs: now - 900000 })!;
const entry = { dealId: 'D1', positionId: 'P1', tradeSide: 1, filledVolume: 10000, executionPrice: 1.1, executionTimestamp: now - 900000, moneyDigits: 2 };
const exit = { dealId: 'D2', positionId: 'P1', tradeSide: 2, filledVolume: 10000, executionPrice: 1.099, executionTimestamp: now - 1000, moneyDigits: 2,
    closePositionDetail: { closedVolume: 10000, grossProfit: -900, commission: -50, swap: 0, moneyDigits: 2, balance: 100000, balanceVersion: 2 } };
function trade() { return { tradeId: 'T1', journalId: 'J1', ticker: 'EURUSD', direction: 'BUY', timestamp: now - 900000,
    ctraderPositionId: 'P1', entryPrice: 1.1, slPrice: 1.09, tp1Price: 1.11, tp2Price: 1.12, result: null,
    riskSnapshot: snapshot, riskAccountingStatus: 'VERIFIED', riskAccountingProvenance: 'broker_fill', riskAmountAccount: snapshot.riskAmountAccount, accountCurrency: 'EUR' }; }
function harness(body: string, collections = new Map<string, Map<string, any>>()) {
    const trades = new Map<string, any>(), writes: any[] = [];
    let failClose = false;
    const db: any = { collection: (name: string) => {
        const rows = collections.get(name) ?? new Map(); collections.set(name, rows);
        const doc = (id: string): any => ({ id, get: async () => ({ exists: rows.has(id), data: () => structuredClone(rows.get(id)) }),
            set: async (fields: any) => { if (failClose && name === 'trade_journal' && fields.result) throw Error('offline close commit failed');
                writes.push({ name, id, fields: structuredClone(fields) }); rows.set(id, { ...rows.get(id), ...structuredClone(fields) }); },
            update: async (fields: any) => doc(id).set(fields), delete: async () => { rows.delete(id); } });
        const query = (filters: any[] = []): any => ({ doc, where: (k: string, _op: string, v: any) => query([...filters, [k, v]]), limit: () => query(filters),
            get: async () => { const docs = [...rows].filter(([, row]) => filters.every(([k, v]) => row[k] === v)).map(([id, row]) => ({ id, data: () => structuredClone(row), ref: doc(id) })); return { empty: !docs.length, docs }; } });
        return query();
    }, runTransaction: async (work: any) => { const pending: any[] = []; await work({ get: (ref: any) => ref.get(), set: (...args: any[]) => pending.push(args) }); for (const [ref, fields, options] of pending) await ref.set(fields, options); } };
    const broker: any = { isCTraderReady: () => true, getOpenPositions: async () => [], getDealsByPosition: async () => [entry, exit], getVerifiedAccountCurrency: () => 'EUR', closePosition: async () => true };
    const state: any = { activeTrades: trades };
    const context: any = { exports: {}, console: { log() {}, warn() {}, error() {} }, ...risk, ...portfolio, commitTradeCloseAccounting,
        Date: class extends Date { static now() { return now; } }, db, globalState: state, store: state, lastReconcileTs: 0,
        rolloverDWideMap: new Map(), rolloverTriageRecords: new Map(), loadRolloverJournalPending: async () => true, rehydrateRolloverPending() {},
        capTp2Price: (_t: any, _d: any, _e: any, _s: any, p: any) => p, validateExecutionInstrument: () => false,
        setTimeout: (cb: any) => { cb(); return 1; }, sendTelegramAlert: async () => {},
        ticker: 'EURUSD', isBacktest: false, nowMs: now, nowTrade: now, currentPrice: 1.2, currentPnlPct: 1, effectiveROI: .001,
        roiLabel: '30min', tradeAgeMs: 900000, lastChoch: { direction: 'Bearish' }, inverseDir: 'Bearish', isDuplicate: () => false };
    context.require = (id: string) => { if (id.includes('ctrader')) return broker; if (id.includes('memory')) return { db }; throw Error('Unexpected offline import ' + id); };
    vm.runInNewContext(ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
    return { api: context.exports, context, trades, collections, writes, broker, db, fail: (v: boolean) => { failClose = v; } };
}
const closeFunctions = () => ['resolveClosedFromDeals', 'finalizeClosedPositionFromDeals', 'completeLiveTradeClose', 'hasUnresolvedExecutionIncidents'].map(fn).join('\n');
const tests: Record<string, () => Promise<void>> = {};
tests.recovery = async () => {
    const body = closeFunctions() + '\n' + fn('reconcileCTraderPositions');
    const h = harness(body); h.collections.set('trade_journal', new Map([['J1', { ...trade(), executionIncidentPending: true }]]));
    h.fail(true); await h.api.reconcileCTraderPositions();
    assert.equal(h.trades.has('T1'), true, 'failed journal-only close retains RAM');
    const retained = h.collections.get('active_trades')!.get('T1'); assert.ok(retained, 'actual durable retry record exists');
    // Simulate restart by hydrating only the record actually persisted, never the original fixture.
    const restarted = harness(body, h.collections); restarted.trades.set('T1', structuredClone(retained));
    await restarted.api.reconcileCTraderPositions();
    assert.equal(restarted.trades.size, 0, 'restart reload from persisted active identity must finish reconciliation once DB recovers');
    assert.equal(h.collections.get('active_trades')!.has('T1'), false);
    const row = h.collections.get('trade_journal')!.get('J1');
    assert.equal(row.ctrader_real_pnl, -9.5); assert.equal(row.rMultiple, risk.computeTradeRiskR(-9.5, snapshot));
    assert.equal(row.closeAccountingPending, false); assert.equal(row.executionIncidentPending, false);
    for (const key of ['tradeId', 'journalId', 'ticker', 'direction', 'timestamp', 'ctraderPositionId', 'riskSnapshot', 'riskAmountAccount', 'accountCurrency'])
        assert.deepEqual(retained[key], trade()[key as keyof ReturnType<typeof trade>], `recovery evidence ${key} durable`);
};

tests.recoveryConflict = async () => {
    for (const conflict of [{ ctraderPositionId: 'OTHER' }, { journalId: 'OTHER' }, { ticker: 'GBPUSD' },
        { direction: 'SELL' }, { tradeId: 'OTHER' }, { riskSnapshot: { ...snapshot, initialSlPrice: 1.08 } }]) {
        const h = harness(closeFunctions() + '\nexports.finish=completeLiveTradeClose;');
        const existing = { ...trade(), ...conflict }; h.collections.set('active_trades', new Map([['T1', structuredClone(existing)]]));
        h.fail(true); h.trades.set('T1', trade()); await h.api.finish(h.trades.get('T1'), h.context.store);
        assert.deepEqual(h.collections.get('active_trades')!.get('T1'), existing, 'retained recovery must not overwrite conflicting durable identity/evidence');
        assert.equal(h.trades.has('T1'), true, 'conflict retains RAM hold');
    }
};

for (const kind of ['ROI', 'RIDER'] as const) tests[kind] = async () => {
    const loop = nodes(n => ts.isForOfStatement(n) && n.initializer.getText(ast) === 'const [tradeId, trade]' && n.expression.getText(ast) === 'store.activeTrades')[0] as ts.ForOfStatement;
    const statements = (loop.statement as ts.Block).statements;
    const cutoff = statements.findIndex(n => ts.isVariableStatement(n) && n.getText(ast).includes('const nowTrade'));
    assert.ok(cutoff >= 0);
    const prefix = statements.slice(0, cutoff).map(n => n.getText(ast)).join('\n');
    const expression = kind === 'ROI' ? 'currentPnlPct >= effectiveROI * 100' : '(lastChoch as any).direction === inverseDir';
    const branch = nodes(n => ts.isIfStatement(n) && n.expression.getText(ast) === expression)[0]; assert.ok(branch);
    const h = harness(closeFunctions() + `\nexports.run=async()=>{for(const [tradeId,trade] of store.activeTrades){${prefix}${branch.getText(ast)}}};`);
    const retained: any = { ...trade(), closeAccountingPending: true, executionIncidentPending: true, riderTf: 'H1' };
    h.trades.set('T1', retained);
    let brokerOpen = true, confirmed = false, closes = 0;
    h.broker.getOpenPositions = async () => brokerOpen ? [{ positionId: 'P1' }] : [];
    h.broker.getDealsByPosition = async () => brokerOpen ? [entry] : [entry, exit];
    h.broker.closePosition = async () => { closes++; return confirmed; };
    await h.api.run();
    assert.equal(closes, 1, `${kind}: entry-only incident must not suppress ordinary exit on broker-open position`);
    assert.equal(h.trades.has('T1'), true); assert.equal(h.api.hasUnresolvedExecutionIncidents(), true);
    await h.api.run(); assert.equal(closes, 2, `${kind}: unconfirmed close retries while broker remains OPEN`);
    confirmed = true; await h.api.run();
    assert.equal(closes, 3, `${kind}: opening-only history is not proof of completed close`);
    assert.equal(h.trades.has('T1'), true, 'no fabricated accounting from opening-only deals');
    brokerOpen = false; h.fail(true); await h.api.run(); await h.api.run();
    assert.equal(closes, 3, `${kind}: broker-closed accounting retries cannot submit duplicate close`);
    assert.equal(h.trades.has('T1'), true, 'failed durable commit retains hold after broker close');
    h.fail(false); await h.api.run();
    assert.equal(closes, 3); assert.equal(h.trades.has('T1'), false);
    assert.equal(h.collections.get('trade_journal')!.get('J1').ctrader_real_pnl, -9.5);
};

tests.duplicates = async () => {
    const canonical = { ...trade(), result: 'LOSS', rMultiple: risk.computeTradeRiskR(-.09, snapshot), ctrader_real_pnl: -.09,
        closedAt: now - 1000, closedAtSource: 'broker_execution' };
    const duplicate: any = { tradeId: 'TDUP', ticker: 'EURUSD', direction: 'BUY', ctraderPositionId: 'P1', ctraderStatus: 'EXECUTED', result: null, duplicateOf: 'J1' };
    const evaluate = async (rows: Map<string, any>, held: boolean, label: string) => {
        const h = harness(''); h.collections.set('trade_journal', rows); portfolio.invalidateRiskCache();
        const global = await portfolio.evaluateGlobalRisk(now, { enabled: true, maxDailyLossR: 2 } as any, 0, 'NY', h.db);
        const asset = await portfolio.evaluateAssetRisk(h.db, 'EURUSD', now, { maxDailyLossR: 2 });
        for (const [scope, result] of [['global', global], ['asset', asset]] as const) {
            assert.equal(result.isKilled, held, `${scope}: ${label}`);
            if (held) assert.equal(result.riskDataStatus, 'held', `${scope}: unresolved duplicate stays entry-only hold`);
        }
    };
    await evaluate(new Map([['J1', canonical], ['JDUP', duplicate]]), false, 'same-position duplicate of fully verified closed canonical must not hold entries forever');
    for (const patch of [{ duplicateOf: 'MISSING' }, { duplicateOf: 'JDUP' }, { ctraderPositionId: 'P2' }, { ticker: 'GBPUSD' },
        { direction: 'SELL' }, { accountCurrency: 'USD' }, { riskSnapshot: { ...snapshot, initialSlPrice: 1.08 } },
        { executionUncertain: true }, { executionIncidentPending: true }, { closeAccountingPending: true }, { executionFillUnverified: true },
        { ctraderStatus: 'EXECUTION_PENDING_RECONCILIATION' }]) {
        await evaluate(new Map([['J1', canonical], ['JDUP', { ...duplicate, ...patch }]]), true, `invalid or independent duplicate incident ${JSON.stringify(patch)}`);
    }
    for (const patch of [{ result: null }, { riskAccountingStatus: 'UNVERIFIED' }, { executionIncidentPending: true },
        { duplicateOf: 'JDUP' }, { ctraderPositionId: 'P2' }, { ticker: 'GBPUSD' }, { direction: 'SELL' },
        { closedAt: null }, { closedAt: now + 1000 }, { closedAtSource: 'estimated' }, { ctrader_real_pnl: -999 }, { accountCurrency: 'USD' }]) {
        await evaluate(new Map([['J1', { ...canonical, ...patch }], ['JDUP', duplicate]]), true, `unproven canonical ${JSON.stringify(patch)}`);
    }
    const h = harness(''); h.collections.set('trade_journal', new Map([['J1', { ...canonical, rMultiple: -3, ctrader_real_pnl: -3 * snapshot.riskAmountAccount }], ['JDUP', duplicate]]));
    portfolio.invalidateRiskCache();
    for (const r of [await portfolio.evaluateGlobalRisk(now, { enabled: true, maxDailyLossR: 2 } as any, 0, 'NY', h.db),
        await portfolio.evaluateAssetRisk(h.db, 'EURUSD', now, { maxDailyLossR: 2 })]) {
        assert.equal(r.isKilled, true); assert.match(r.killReason!, /Max Daily Loss/); assert.notEqual(r.riskDataStatus, 'held', 'dedupe never erases canonical risk');
    }
};

let count = 0, failed = 0;
for (const [name, test] of Object.entries(tests).filter(([n]) => !process.env.REVIEW_CASE || process.env.REVIEW_CASE === n)) {
    count++; try { await test(); console.log(`PASS review lifecycle ${name}`); } catch (error) { failed++; console.error(`FAIL review lifecycle ${name}`, error); }
}
assert.ok(count); console.log(`${count - failed}/${count} review lifecycle regressions PASS (offline production AST, real PortfolioModel/shared commit)`);
if (failed) process.exitCode = 1;
