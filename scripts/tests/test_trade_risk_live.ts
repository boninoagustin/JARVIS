import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as risk from '../../src/engine/TradeRisk.js';
import * as friction from '../../src/engine/FrictionModel.js';
import { commitTradeCloseAccounting } from '../../src/engine/TradeAccountingPersistence.js';
import { hasPendingExecutionIncident, invalidateRiskCache } from '../../src/engine/PortfolioModel.js';

const source = fs.readFileSync(process.env.TRADE_RISK_TRADING_SOURCE ?? 'src/db/trading.ts', 'utf8');
const ast = ts.createSourceFile('trading.ts', source, ts.ScriptTarget.Latest, true);
const names = ['resolveClosedFromDeals', 'finalizeClosedPositionFromDeals', 'updateTradePositionId', 'computeRMultipleFromRealPnl', 'retainExecutionIncident', 'hasUnresolvedExecutionIncidents'];
const nodes = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? ''));
assert.ok(nodes.length >= 3);
const exports: any = {};
const writes: any[] = [];
const trades = new Map<string, any>();
let deals: any[] = [];
let verifiedCurrency: string | null = 'EUR';
const broker = { getDealsByPosition: async () => deals, getLotSizeCents: () => 10000, getAccountCurrency: () => 'EUR', getVerifiedAccountCurrency: () => verifiedCurrency };
const documents = new Map<string, any>();
let writeGate: Promise<void> | undefined;
const persist = async (name: string, id: string, value: any) => {
    await writeGate;
    documents.set(`${name}/${id}`, { ...documents.get(`${name}/${id}`), ...value });
    writes.push({ name, id, value });
};
const db = { collection: (name: string) => ({ doc: (id: string) => ({
    update: (value: any) => persist(name, id, value), set: (value: any) => persist(name, id, value),
}) }) };
const body = nodes.map(n => n.getText(ast)).join('\n') + '\nexports.resolveClosedFromDeals = resolveClosedFromDeals;';
vm.runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, console, ...risk, ...friction, hasPendingExecutionIncident, invalidateRiskCache, Object, db, globalState: { activeTrades: trades }, getLastBidAsk: () => undefined,
      require: (id: string) => id.includes('ctrader') ? broker : id.includes('memory') ? { db } : (() => { throw new Error(`Unexpected import ${id}`); })(), setTimeout });
const opening = { dealId: 1, positionId: 'p1', tradeSide: 1, filledVolume: 5000, executionPrice: 99.9, executionTimestamp: 1000, moneyDigits: 2, commission: -18 };
const closing = { dealId: 2, positionId: 'p1', tradeSide: 2, filledVolume: 5000, executionTimestamp: 2000, moneyDigits: 2, closePositionDetail: { closedVolume: 5000, grossProfit: -4630, commission: -36, swap: 0, moneyDigits: 2, balance: 334800, balanceVersion: 370 } };
deals = [opening, closing, closing];
const snapshot = risk.createTradeRiskSnapshot({ ticker: 'USOIL', direction: 'BUY', currency: 'EUR', entryPrice: 99.9, initialSlPrice: 99.12123, filledVolumeCents: 5000, quoteToAccountRate: .89, capturedAtMs: 1000 })!;
const trade: any = { tradeId: 'T1', ticker: 'USOIL', direction: 'BUY', entryPrice: 99.9, initialSlPrice: 99.12123, slPrice: 101, ctraderLots: .5, ctraderPositionId: 'p1', riskSnapshot: snapshot };
const resolved = await exports.resolveClosedFromDeals('p1', trade);
assert.equal(resolved.pnl, -46.66, 'actual trading resolver deduplicates real close money, never double-charge opening commission');
assert.equal(resolved.rMultiple, risk.computeTradeRiskR(-46.66, snapshot));
assert.equal(resolved.closedAt, new Date(2000).toISOString());
assert.equal(resolved.riskAccountingStatus, 'VERIFIED');
assert.equal((await exports.finalizeClosedPositionFromDeals('p1', trade)).closedAt, resolved.closedAt);
verifiedCurrency = null;
assert.equal((await exports.resolveClosedFromDeals('p1', trade)).rMultiple, null, 'default USD/EUR fallback is not verified deposit currency');
verifiedCurrency = 'EUR';
const historical = { ...trade }; delete historical.riskSnapshot;
assert.equal((await exports.resolveClosedFromDeals('p1', historical)).rMultiple, null);
deals = [opening, { ...closing, closePositionDetail: { ...closing.closePositionDetail, closedVolume: 2500 } }];
assert.equal(await exports.resolveClosedFromDeals('p1', trade), null, 'partial close cannot finalize');
console.log('PASS actual AST-extracted trading resolver/finalizer: no service startup or external writes');

trades.set('T1', { tradeId: 'T1', ticker: 'USOIL', direction: 'BUY', entryPrice: 100, slPrice: 99 });
await exports.updateTradePositionId('T1', 'p1', snapshot);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(trades.get('T1').riskSnapshot?.riskAmountAccount, snapshot.riskAmountAccount);
assert.equal(Object.isFrozen(trades.get('T1').riskSnapshot), true);
assert.ok(writes.some(w => w.value.riskSnapshot?.riskAmountAccount === snapshot.riskAmountAccount));
assert.equal(trades.get('T1').riskAccountingStatus, 'VERIFIED');
await exports.updateTradePositionId('T1', 'p1', { ...snapshot, quoteToAccountRate: .7 });
assert.equal(trades.get('T1').riskSnapshot.quoteToAccountRate, .89, 'never overwrite existing immutable denominator');
await assert.rejects(exports.updateTradePositionId('T1', 'other-position', snapshot), /position identity mismatch/);
assert.equal(trades.get('T1').ctraderPositionId, 'p1');
trades.set('T2', { ticker: 'XPTUSD', direction: 'BUY' });
await exports.updateTradePositionId('T2', 'p2', snapshot);
assert.equal(trades.get('T2').riskSnapshot, undefined, 'reject identity mismatch');
trades.set('T3', { ticker: 'USOIL', direction: 'BUY' });
await exports.updateTradePositionId('T3', 'p3');
assert.equal(trades.get('T3').ctraderPositionId, 'p3', 'legacy two-argument callers keep working');
console.log('PASS shared fill boundary: RAM freeze, persisted snapshot, identity guard, old 2arg API');

assert.match(source, /await updateTradePositionId\(oteData.tradeId, result.positionId, result.riskSnapshot\)/, 'auto fills persist broker denominator before management');
assert.doesNotMatch(source, /closedAt: new Date\(\)\.toISOString\(\)/, 'actual close persistence preserves broker execution time rather than reconciler time');
assert.doesNotMatch(source, /Sin deal de cierre[^\n]*BREAKEVEN/, 'missing/incomplete deals must not fabricate breakeven or remove the active trade');
// Exercise actual close write expressions, whether inline or delegated to the canonical
// boundary. Writer count/line layout is not a contract; every discovered writer's payload is.
const closeWrites: ts.CallExpression[] = [];
function collectCloseWrites(n: ts.Node): void {
    if (ts.isCallExpression(n) && (n.expression.getText(ast) === 'commitTradeCloseAccounting'
        || (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'set'
            && n.arguments[0]?.getText(ast).includes('ctrader_real_pnl: fin.pnl')))) closeWrites.push(n);
    ts.forEachChild(n, collectCloseWrites);
}
collectCloseWrites(ast);
assert.ok(closeWrites.length > 0, 'actual broker close writers must be exercised');
for (const call of closeWrites) {
    const persisted: any[] = [];
    const closeApi: any = {};
    const closeDb = { collection: (name: string) => ({ doc: (id: string) => ({ set: async (value: any, options: any) => {
        await Promise.resolve(); persisted.push({ name, id, value, options });
    } }) }) };
    const writer = `export async function writeClose() { await ${call.getText(ast)}; }`;
    vm.runInNewContext(ts.transpileModule(writer, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { exports: closeApi, commitTradeCloseAccounting, db: closeDb, jid: 'JCLOSE', fin: resolved, resolved, extra: {},
          trade: { tradeId: 'TCLOSE', journalId: 'JCLOSE' }, sarPendingClose: { tradeId: 'TCLOSE', journalId: 'JCLOSE' } });
    await closeApi.writeClose();
    assert.equal(persisted.length, 1);
    const written = persisted[0];
    assert.equal(written.name, 'trade_journal');
    assert.equal(written.id, 'JCLOSE');
    assert.equal(written.options.merge, true);
    for (const [field, value] of Object.entries({ result: resolved.result, rMultiple: resolved.rMultiple,
        ctrader_real_pnl: resolved.pnl, riskAmountAccount: snapshot.riskAmountAccount,
        riskAccountingStatus: 'VERIFIED', riskAccountingProvenance: 'broker_fill', accountCurrency: 'EUR',
        closedAt: resolved.closedAt, closedAtSource: 'broker_execution' })) assert.equal(written.value[field], value, field);
}
// Real canonical helper must await the durable store, not merely schedule it.
let releaseCommit!: () => void;
const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
let commitFinished = false;
const delayedDb = { collection: () => ({ doc: () => ({ set: async () => { await commitGate; } }) }) };
const committing = commitTradeCloseAccounting(delayedDb, 'JCLOSE', resolved).then(() => { commitFinished = true; });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(commitFinished, false);
releaseCommit(); await committing;
assert.equal(commitFinished, true);
await assert.rejects(commitTradeCloseAccounting({ collection: () => ({ doc: () => ({ set: async () => { throw new Error('offline close commit'); } }) }) }, 'JCLOSE', resolved), /offline close commit/);
console.log('PASS actual broker close writers: PnL, frozen risk, currency and broker time preserved; canonical commit awaits durability and propagates failure');

// Extract the real success branch structurally; optional result access is not a missing branch.
const dispatch = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'dispatchOteSignal');
assert.ok(dispatch, 'actual auto dispatch function must exist');
let autoSuccess: ts.IfStatement | undefined;
function findAutoSuccess(n: ts.Node): void {
    if (ts.isIfStatement(n) && /result\??\.success\s*&&\s*result\.positionId/.test(n.expression.getText(ast))) autoSuccess = n;
    ts.forEachChild(n, findAutoSuccess);
}
findAutoSuccess(dispatch);
assert.ok(autoSuccess, 'actual auto success branch must exist');
const auto = autoSuccess.thenStatement.getText(ast);
assert.ok(auto.includes('riskSnapshot:') && auto.includes('riskAccountingStatus:'), 'auto path must persist accounting fields into journal before management');
assert.ok(auto.indexOf('riskAccountingStatus:') < auto.indexOf('freezeExecutionFill(exTrade'), 'journal denominator persistence precedes optional risk management');
assert.ok(auto.indexOf('await updateTradePositionId') < auto.indexOf('if (sarPendingClose)'), 'new fill risk is persisted before potentially slow reversal finalization');
console.log('PASS auto fill accounting is durable before management or reversal finalization');
assert.ok(!auto.includes("recordResult(jid, 'REVERSAL')"), 'SAR without complete broker history must remain pending, not acquire a fabricated reconciliation close time');
assert.ok(auto.includes('if (sarAccountingReady)'), 'SAR deletes active state only after complete broker close accounting');

const actualJournal = JSON.parse(fs.readFileSync('scratch/review_20261021/firestore.json', 'utf8')).journal.filter((j: any) => j.ctraderPositionId);
const brokerEvidence = JSON.parse(fs.readFileSync('scratch/review_20261021/broker.json', 'utf8')).deals.deals;
const independentlyVerified = JSON.parse(fs.readFileSync('scratch/review_20261021/verified.json', 'utf8'));
let replayed = 0;
for (const j of actualJournal) {
    deals = brokerEvidence.filter((d: any) => String(d.positionId) === j.ctraderPositionId);
    const a = await exports.resolveClosedFromDeals(j.ctraderPositionId, j);
    const expected = independentlyVerified.find((v: any) => v.id === j.id);
    assert.ok(a && expected, j.id);
    assert.equal(a.pnl, expected.net, j.id);
    assert.equal(a.closedAt, new Date(expected.close).toISOString(), j.id);
    assert.equal(a.rMultiple, null, 'historical opening conversion cannot be recovered from close details');
    assert.equal(a.riskAmountAccount, null);
    assert.equal(a.riskAccountingStatus, 'UNVERIFIED');
    assert.equal(a.riskAccountingProvenance, 'missing_fill_snapshot');
    assert.equal(j.riskSnapshot, undefined, 'real historical evidence must never be synthetically certified');
    replayed++;
}
assert.equal(replayed, 15);
console.log('PASS 15/15 real broker histories through actual AST trading resolver: PnL + final execution timestamps verified');

let persistenceTry: ts.TryStatement | undefined;
function visit(node: ts.Node): void {
    if (ts.isTryStatement(node) && node.tryBlock.getText(ast).includes('await updateTradePositionId(oteData.tradeId, result.positionId, result.riskSnapshot)')) persistenceTry = node;
    ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(persistenceTry);
const autoExports: any = {};
const notices: string[] = [];
const oldWriteCount = writes.length;
const autoBody = `export async function persistAutoFill() { ${persistenceTry!.getText(ast)} }`;
const autoContext: any = { exports: autoExports, console, updateTradePositionId: exports.updateTradePositionId,
    retainExecutionIncident: exports.retainExecutionIncident,
    store: { activeTrades: trades }, db, result: { success: true, positionId: 'p1', executedPrice: 99.9, lots: .5, riskSnapshot: snapshot },
    oteData: { tradeId: 'T1' }, globalConfig: { CTRADER_DEMO: true }, journalId: 'J1', isBacktest: false,
    ticker: 'USOIL', sendTelegramAlert: async (text: string) => { notices.push(text); } };
vm.runInNewContext(ts.transpileModule(autoBody, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, autoContext);
let releaseFill!: () => void;
writeGate = new Promise<void>(resolve => { releaseFill = resolve; });
let fillPersisted = false;
const persistingFill = autoExports.persistAutoFill().then(() => { fillPersisted = true; });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(fillPersisted, false, 'actual auto branch must await active fill persistence');
assert.equal(writes.length, oldWriteCount, 'journal must not get ahead of blocked active fill write');
releaseFill(); await persistingFill; writeGate = undefined;
const fillWrites = writes.slice(oldWriteCount);
assert.equal(fillWrites[0].name, 'active_trades');
assert.equal(fillWrites[1].name, 'trade_journal');
assert.equal(fillWrites[1].value.riskSnapshot.riskAmountAccount, snapshot.riskAmountAccount);
assert.equal(fillWrites[1].value.ctraderStatus, 'EXECUTED');
assert.equal(fillWrites[1].value.accountCurrency, 'EUR');
assert.equal(notices.length, 0);
assert.deepEqual(documents.get('active_trades/T1').riskSnapshot, snapshot);
assert.deepEqual(documents.get('trade_journal/J1').riskSnapshot, snapshot);
trades.set('BAD', { ticker: 'USOIL', direction: 'BUY', riskSnapshot: { ...snapshot, riskAmountAccount: 1 } });
autoContext.oteData = { tradeId: 'BAD' };
await autoExports.persistAutoFill();
const rejectedWrite = writes.filter(w => w.name === 'trade_journal').at(-1)!;
assert.equal(rejectedWrite.value.riskAccountingStatus, 'INVALID', 'truthy malformed stored snapshot never becomes VERIFIED');
assert.equal(rejectedWrite.value.riskSnapshot, undefined);
autoContext.oteData = { tradeId: 'T1' };
autoContext.db = { collection: () => ({ doc: () => ({ update: async () => { throw new Error('offline persistence failure'); } }) }) };
await autoExports.persistAutoFill();
assert.equal(notices.length, 1);
assert.match(notices[0], /persistencia de riesgo pendiente/);
assert.equal(trades.get('T1').ctraderPositionId, 'p1');
assert.equal(trades.get('T1').executionIncidentPending, true, 'real incident handler retains filled position in RAM');
assert.equal(exports.hasUnresolvedExecutionIncidents(), true);
assert.equal(documents.get('trade_journal/J1').ctraderStatus, 'EXECUTION_PENDING_RECONCILIATION');
assert.equal(documents.get('trade_journal/J1').rMultiple, null, 'persistence failure cannot manufacture a realized result');
console.log('PASS actual AST auto-fill persistence: snapshot saved before management; awaited DB; failure retains real pending RAM+journal incident, never aborted');
