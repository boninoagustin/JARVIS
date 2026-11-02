import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { buildExecutionNotice } from '../../src/engine/ExecutionNotice.js';
import * as portfolio from '../../src/engine/PortfolioModel.js';
import { createTradeRiskSnapshot } from '../../src/engine/TradeRisk.js';

// Only pure functions are imported. Startup/service imports never execute.
const source = fs.readFileSync('src/db/trading.ts', 'utf8');
const ast = ts.createSourceFile('trading.ts', source, ts.ScriptTarget.Latest, true);
function fn(name: string) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name); return node.getText(ast);
}
const confirmation = fs.readFileSync('src/services/ctrader_confirmation.ts', 'utf8');
const ca = ts.createSourceFile('confirmation.ts', confirmation, ts.ScriptTarget.Latest, true);
const callback = ca.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleTradeCallback')!;
let auto: ts.VariableDeclaration | undefined;
(function visit(n: ts.Node) { if (ts.isVariableDeclaration(n) && n.name.getText(ast) === 'recheckKillswitchesBeforeExecution') auto = n; ts.forEachChild(n, visit); })(ast);
assert.ok(auto);
const now = Date.parse('2026-10-22T15:00:00Z');
type Change = (h: ReturnType<typeof harness>) => void;
function harness() {
    const rows = new Map<string, any>();
    const config: any = { sessionEnabled: true, rolloverEntryBlock: false, maxDailyLossR: 2 };
    const state: any = { activeTrades: new Map(), globalKillswitches: {}, streakKillswitchUntil: 0,
        vixKillswitchUntil: 0, globalPortfolioKillswitchUntil: 0, globalPortfolioConfig: { enabled: true, maxDailyLossR: 2 } };
    let onRead: (() => void) | undefined, atDispatch: (() => void) | undefined;
    let requests = 0, submissions = 0, reads = 0;
    const messages: string[] = [];
    const query: any = { get: async () => { reads++; onRead?.(); return { empty: !rows.size, docs: [...rows].map(([id, row]) => ({ id, data: () => row })) }; },
        doc: (id: string) => ({ update: async (fields: any) => rows.set(id, { ...rows.get(id), ...fields }), delete: async () => rows.delete(id) }) };
    const context: any = { exports: {}, buildExecutionNotice, console: { log() {}, warn() {}, error() {} }, ...portfolio,
        Date: class extends Date { static now() { return now; } }, db: { collection: () => query },
        globalState: state, store: state, getConfigForTicker: () => config, getCurrentSession: () => 'NY',
        assetKillNotified: new Map(), sendTelegramAlert: async () => {},
        tickFlow: { isSpreadAnomalous: () => false }, isRolloverEntryWindow: () => false, logBlockedSignal() {},
        ticker: 'EURUSD', oteData: {}, nowMs: now,
        config: { CTRADER_RISK_PERCENT: 1 },
        pendingConfirmations: new Map([['T1', { tradeId: 'T1', journalId: 'J1', ticker: 'EURUSD', direction: 'BUY', entryPrice: 1.1, slPrice: 1.09, tp1Price: 1.11 }]]),
        retainExecutionIncident: async () => false,
        executeMarketOrder: async (params: any) => {
            requests++; atDispatch?.(); portfolio.invalidateRiskCache();
            const blocked = await params.beforeExecution();
            if (blocked) return { success: false, error: blocked };
            submissions++; return { success: false, error: 'offline authoritative no-fill' };
        },
        bot: { api: { editMessageReplyMarkup: async () => {}, sendMessage: async (_: any, message: string) => messages.push(message) } },
    };
    const body = ['hasUnresolvedExecutionIncidents', 'evaluateGlobalKillswitch', 'evaluateAssetKillswitch', 'recheckLiveExecutionRisk'].map(fn).join('\n') +
        '\n' + callback.getText(ca) + `\nexports.auto = ${auto!.initializer!.getText(ast)};`;
    vm.runInNewContext(ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
    portfolio.invalidateRiskCache();
    return { context, state, config, rows, messages, counts: () => ({ requests, submissions, reads }),
        duringRead: (change: () => void) => { onRead = change; }, duringDispatch: (change: () => void) => { atDispatch = change; },
        manual: () => context.exports.handleTradeCallback('ctrader_execute_T1', 1, 2, 3), auto: () => context.exports.auto() };
}
const guards: Record<string, [Change, string]> = {
    session: [h => { h.config.sessionEnabled = false; }, 'BLOCKED_SESSION'],
    system: [h => { h.state.globalKillswitches.GLOBAL_SYSTEM = true; }, 'BLOCKED_KILLSWITCH'],
    ticker: [h => { h.state.globalKillswitches.EURUSD = true; }, 'BLOCKED_KILLSWITCH'],
    streak: [h => { h.state.streakKillswitchUntil = now + 1000; }, 'BLOCKED_RACHA'],
    vix: [h => { h.state.vixKillswitchUntil = now + 1000; }, 'BLOCKED_VIX'],
    spread: [h => { h.context.tickFlow.isSpreadAnomalous = () => true; }, 'BLOCKED_SPREAD'],
    rollover: [h => { h.config.rolloverEntryBlock = true; h.context.isRolloverEntryWindow = () => true; }, 'BLOCKED_ROLLOVER'],
    incident: [h => { h.state.activeTrades.set('incident', { executionIncidentPending: true }); }, 'BLOCKED_EXECUTION_INCIDENT'],
};
const tests: Record<string, () => Promise<void>> = {};
for (const [name, [change, expected]] of Object.entries(guards)) {
    tests[name] = async () => {
        const h = harness(); change(h); await h.manual();
        assert.equal(h.counts().requests, 0, `${name}: actual manual callback must block before facade`);
        assert.ok(h.messages.some(s => s.includes(name === 'incident' ? 'pendiente de reconciliación' : expected)), `${name}: expected policy reason`);
        assert.equal(await h.auto(), expected, `${name}: actual AUTO closure must share full policy`);
    };
    if (name !== 'incident') tests[`await_${name}`] = async () => {
        const h = harness(); h.duringRead(() => change(h)); await h.manual();
        assert.ok(h.counts().reads > 0, 'latch changes inside real awaited ledger read');
        assert.equal(h.counts().submissions, 0, `${name}: mid-await latch change must block submission`);
        assert.equal(h.counts().requests, 0, `${name}: final synchronous recheck blocks initial approval`);
        assert.ok(h.messages.some(s => s.includes(expected)), `${name}: final recheck reason`);
    };
    tests[`dispatch_${name}`] = async () => {
        const h = harness(); h.duringDispatch(() => change(h)); await h.manual();
        assert.equal(h.counts().requests, 1, 'initial safe approval reaches facade');
        assert.equal(h.counts().submissions, 0, `${name}: actual callback beforeExecution rechecks current policy`);
    };
}
tests.safe = async () => { const h = harness(); await h.manual(); assert.equal(h.counts().submissions, 1); assert.equal(await h.auto(), null); };
for (const scope of ['global', 'asset']) tests[scope] = async () => {
    const h = harness();
    if (scope === 'asset') h.state.globalPortfolioConfig.enabled = false;
    const snapshot = createTradeRiskSnapshot({ ticker: 'EURUSD', direction: 'BUY', currency: 'EUR', entryPrice: 100, initialSlPrice: 99, filledVolumeCents: 100, quoteToAccountRate: 1, capturedAtMs: now - 10000 })!;
    h.rows.set('LOSS', { ticker: 'EURUSD', direction: 'BUY', result: 'LOSS', closedAt: now - 1000, closedAtSource: 'broker_execution',
        riskSnapshot: snapshot, riskAmountAccount: snapshot.riskAmountAccount, accountCurrency: 'EUR', ctrader_real_pnl: -3, rMultiple: -3,
        riskAccountingStatus: 'VERIFIED', riskAccountingProvenance: 'broker_fill' });
    await h.manual(); assert.equal(h.counts().requests, 0); assert.ok(h.messages.some(s => s.includes(scope === 'global' ? 'BLOCKED_GLOBAL' : 'BLOCKED_ASSET')));
};
let failures = 0, count = 0;
for (const [name, test] of Object.entries(tests).filter(([n]) => !process.env.PREFLIGHT_CASE || process.env.PREFLIGHT_CASE === n)) {
    count++; try { await test(); console.log(`PASS full preflight ${name}`); } catch (e) { failures++; console.error(`FAIL full preflight ${name}`, e); }
}
assert.ok(count); console.log(`${count - failures}/${count} full preflight regressions PASS (offline actual callback/shared preflight/PortfolioModel)`);
if (failures) process.exitCode = 1;
