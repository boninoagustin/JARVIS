import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as risk from '../../src/engine/TradeRisk.js';
import { hasPendingExecutionIncident, invalidateRiskCache } from '../../src/engine/PortfolioModel.js';

// Real approval + RAM/persistence boundary, isolated only from external services.
const path = 'src/services/ctrader_confirmation.ts';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleTradeCallback');
assert.ok(node);
const tradingAst = ts.createSourceFile('trading.ts', fs.readFileSync('src/db/trading.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const sharedNames = ['updateTradePositionId', 'hasUnresolvedExecutionIncidents', 'retainExecutionIncident'];
const shared = tradingAst.statements.filter(n => ts.isFunctionDeclaration(n) && sharedNames.includes(n.name?.text ?? ''));
assert.equal(shared.length, sharedNames.length, 'use actual production linkage and incident functions, never substitutes');
// Deterministic synthetic fill, not reconstructed historical broker evidence.
const snapshot = risk.createTradeRiskSnapshot({ ticker: 'XPTUSD', direction: 'BUY', currency: 'EUR', entryPrice: 1643.37, initialSlPrice: 1623.25698, filledVolumeCents: 400, quoteToAccountRate: .89, capturedAtMs: 1792575603530 })!;
assert.ok(snapshot);
assert.equal(Object.isFrozen(snapshot), true);
const pending = { tradeId: 'T1', journalId: 'J1', ticker: 'XPTUSD', direction: 'BUY', entryPrice: 1632.435, slPrice: 1623.25698, tp1Price: 1645, tp2Price: 1650, timestamp: snapshot.capturedAtMs - 1000 };
const result = { success: true, positionId: 'P1', executedPrice: snapshot.entryPrice, lots: .04, riskSnapshot: snapshot };
const writes: Array<{ collection: string; id: string; fields: any }> = [];
const documents = new Map<string, any>();
const trades = new Map<string, any>([['T1', { ...pending }]]);
let completedWrites = 0;
let announcedBeforePersistence = false;
let orderCalls = 0;
const api: any = {};
const persist = async (collection: string, id: string, fields: any) => {
  await Promise.resolve();
  documents.set(`${collection}/${id}`, { ...documents.get(`${collection}/${id}`), ...fields });
  writes.push({ collection, id, fields });
  completedWrites++;
};
const db = { collection: (collection: string) => ({ doc: (id: string) => ({
  update: (fields: any) => persist(collection, id, fields),
  set: (fields: any) => persist(collection, id, fields),
}) }) };
const messages: string[] = [];
const body = shared.map(n => n.getText(tradingAst)).join('\n') + '\n' + node.getFullText(ast);
vm.runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: api, ...risk, hasPendingExecutionIncident, invalidateRiskCache, Object,
  console: { log() {}, warn() {}, error() {} }, pendingConfirmations: new Map([['T1', pending]]), db,
  globalState: { activeTrades: trades }, config: { CTRADER_RISK_PERCENT: 1, CTRADER_DEMO: true },
  // This harness isolates the safe approval path; actual gate behavior has its own replay test.
  recheckLiveExecutionRisk: async () => null,
  executeMarketOrder: async () => { orderCalls++; return result; },
  require: (id: string) => {
    if (id.includes('memory')) return { db };
    if (id.includes('trading')) return { globalState: { activeTrades: trades } };
    throw new Error(`Unexpected service import ${id}`);
  },
  bot: { api: { editMessageReplyMarkup: async () => {}, sendMessage: async (_: number, text: string) => {
    messages.push(text);
    if (text.includes('EJECUTADO EN CTRADER') && completedWrites < 3) announcedBeforePersistence = true;
  } } },
});
await api.handleTradeCallback('ctrader_execute_T1', 1, 2, 3);
const journal = documents.get('trade_journal/J1');
const active = documents.get('active_trades/T1');
const ram = trades.get('T1');
assert.ok(journal && active);
assert.deepEqual(journal.riskSnapshot, snapshot, 'semi-auto journal must persist broker-frozen risk, not theoretical entry risk');
assert.deepEqual(active.riskSnapshot, snapshot, 'semi-auto active trade must preserve the same frozen denominator');
assert.deepEqual(ram.riskSnapshot, snapshot, 'actual RAM linkage must preserve broker-frozen evidence');
assert.equal(Object.isFrozen(ram.riskSnapshot), true);
assert.equal(journal.entryPrice, snapshot.entryPrice, 'semi-auto journal must use actual fill');
assert.equal(active.initialSlPrice, snapshot.initialSlPrice, 'initial stop must use verified broker fill evidence');
assert.equal(ram.entryPrice, snapshot.entryPrice);
assert.equal(ram.initialSlPrice, snapshot.initialSlPrice);
assert.equal(journal.accountCurrency, 'EUR');
assert.equal(journal.riskAccountingStatus, 'VERIFIED');
assert.equal(active.riskAmountAccount, snapshot.riskAmountAccount);
assert.equal(journal.ctraderStatus, 'EXECUTED');
assert.ok(messages.some(text => text.includes('EJECUTADO EN CTRADER')), 'success path must actually complete, not silently catch a harness ReferenceError');
assert.equal(announcedBeforePersistence, false, 'do not announce successful accounting before persistence completes');
assert.ok(writes.length >= 3, 'real awaited RAM fill write plus journal and active normalization must complete');
await api.handleTradeCallback('ctrader_execute_T1', 1, 2, 3);
assert.equal(orderCalls, 1, 'already-processed approval must not resubmit a broker order');
console.log('PASS semi-auto actual approval+linkage: journal+active+frozen RAM share broker risk; actual fill and verified SL; durable writes before success; no duplicate submit');
