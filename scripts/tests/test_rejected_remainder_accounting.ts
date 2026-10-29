import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { CTraderTrading, PayloadType } from 'ctrader-ts';
import * as safety from '../../src/engine/OrderSafety.js';
import * as risk from '../../src/engine/TradeRisk.js';

// Only extract inert production functions: importing ctrader.ts starts services.
const file = 'src/services/ctrader.ts';
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const names = ['executeMarketOrder', 'confirmOrderFilled', 'verifyPositionProtection'];
const nodes = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? ''));
assert.equal(nodes.length, names.length);
const code = ts.transpileModule(nodes.map(n => n.getText(ast)).join('\n')
    + '\nexports.confirmOrderFilled = confirmOrderFilled;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const quiet = { log() {}, warn() {}, error() {} };
const opening = { dealId: 1, positionId: 42, symbolId: 1, tradeSide: 1, dealStatus: 3,
    volume: 900, filledVolume: 100, executionPrice: 101, executionTimestamp: 1000, commission: -1, moneyDigits: 2 };
const rejected = { dealId: 2, positionId: 42, symbolId: 1, tradeSide: 1, dealStatus: 5,
    volume: 800, filledVolume: 0, executionPrice: 0, executionTimestamp: 1100, commission: 0, moneyDigits: 2 };
const closing = { dealId: 3, positionId: 42, symbolId: 1, tradeSide: 2, dealStatus: 2,
    volume: 100, filledVolume: 100, executionPrice: 90, executionTimestamp: 2000, moneyDigits: 2,
    closePositionDetail: { closedVolume: 100, grossProfit: -1100, commission: -2, swap: -1,
        moneyDigits: 2, balance: 998897, balanceVersion: 2, closeTriggerBase: 'STOP_LOSS' } };

function harness(protectedFill = true) {
    const sent: any[] = [], closed: string[] = [], historyReads: number[] = [];
    let now = 1792582131848;
    class Clock extends Date { static now() { return now; } }
    let position: any;
    let history: any[] = [opening, rejected];
    let orders: any[] = [];
    const info = { safetyFetchedAtMs: now, symbolId: 1, lotSize: 10000, minVolume: 100,
        stepVolume: 100, maxVolume: 10000000, digits: 2, pipPosition: 2, baseAssetId: 1, quoteAssetId: 2 };
    const params = { ticker: 'TEST', direction: 'BUY', entryPrice: 100, slPrice: 90,
        tp1Price: 120, tp2Price: 130, riskPercent: 1, tradeId: 'OFFLINE', rolloverEntryBlock: false };
    const ctx: any = { ...safety, ...risk, CTraderTrading, PayloadType, exports: {}, console: quiet,
        Date: Clock, Number, Math, Promise, setTimeout: (f: () => void, ms: number) => { now += ms; f(); return 0; },
        config: { CTRADER_ACCOUNT_ID: '1', CTRADER_RISK_PERCENT: 1, CTRADER_MAX_POSITIONS: 10,
            CTRADER_MARKET_RANGE: true, CTRADER_MAX_SLIPPAGE_PIPS: 1 },
        db: null, isCTraderReady: () => true, getAccountInfo: async () => ({ equity: 10000, currency: 'USD' }),
        accountCurrency: 'USD', executionAccountCurrencyVerified: true,
        executionSymbolMetadata: new Map([['TEST', info]]), executionAssetNames: new Map([[1, 'BASE'], [2, 'USD']]),
        getSymbolInfo: async () => info, mapToCTraderSymbol: (s: string) => s, lastBidAsk: new Map(),
        getLastBidAsk: () => ({ bid: 100, ask: 101, ts: now }),
        tickFlow: { getStructuralSpread: () => 0, getSpread: () => 0 }, notifyRolloverVerifiedFill: async () => {},
        closePosition: async (id: string) => { closed.push(id); position = undefined; return true; },
    };
    ctx.ctClient = {
        getDealsByPosition: async (id: number) => { historyReads.push(id); return history; },
        getState: async () => ({ positions: position ? [position] : [], orders }),
        connection: { inFlightRequests: 0, requestQueue: [], lastRequestSentAt: 0,
            send(type: number, payload: any) {
                sent.push({ type, payload });
                if (type === PayloadType.CANCEL_ORDER_REQ) { orders = []; return {}; }
                position = { positionId: 42, price: 101, ...(protectedFill ? { stopLoss: payload.stopLoss, takeProfit: payload.takeProfit } : {}),
                    tradeData: { label: 'OFFLINE', symbolId: 1, tradeSide: 1, volume: 100 } };
                return { executionType: 7, position, deal: rejected };
            },
            request(type: number, payload: any) { return this.send(type, payload); },
        },
    };
    vm.runInNewContext(code, ctx);
    return { sent, closed, historyReads, run: () => ctx.exports.executeMarketOrder(params),
        confirm: () => ctx.exports.confirmOrderFilled(42, 1000),
        setHistory: (ds: any[]) => { history = ds; },
        setOrders: (os: any[]) => { orders = os; },
        setPosition: (p: any) => { position = p; } };
}

const cases: [string, () => Promise<void>][] = [];
function test(name: string, run: () => Promise<void>) { cases.push([name, run]); }

test('protected partial + rejected remainder completes real confirmation and VERIFIED full-history accounting', async () => {
    const h = harness();
    const result = await h.run();
    assert.equal(h.historyReads.length, 1, 'must execute production confirmation, not a successful stub');
    assert.equal(result.success, true, result.error);
    assert.equal(h.closed.length, 0, 'a terminal rejection of the remainder must not emergency-close a protected fill');
    assert.equal(h.sent.length, 1, 'never submit a second entry');
    assert.equal(result.positionId, '42');
    assert.equal(result.filledVolumeCents, 100);
    assert.equal(result.riskSnapshot.filledVolumeCents, 100);
    const trade = { ticker: 'TEST', direction: 'BUY', symbolId: 1, ctraderPositionId: result.positionId,
        accountCurrency: 'USD', riskSnapshot: result.riskSnapshot };
    const fullHistory = [closing, rejected, opening, opening, rejected, closing];
    const accounting = risk.resolveTradeCloseAccounting('42', trade, fullHistory, 'USD');
    assert.ok(accounting, 'complete history with an explicit zero-fill rejection must finalize');
    assert.equal(accounting.riskAccountingStatus, 'VERIFIED');
    assert.equal(accounting.riskAccountingProvenance, 'broker_fill');
    assert.equal(accounting.filledVolumeCents, 100);
    assert.equal(accounting.entryPrice, 101);
    assert.equal(accounting.pnl, -11.03, 'close commission and swap counted exactly once');
    assert.equal(accounting.rMultiple, risk.computeTradeRiskR(-11.03, result.riskSnapshot));
    assert.equal(accounting.closedAt, new Date(2000).toISOString());
    assert.equal(accounting.balanceAfterUsd, 9988.97);
    assert.equal(accounting.slHit, true);
});

const snapshot = risk.createTradeRiskSnapshot({ ticker: 'TEST', direction: 'BUY', currency: 'USD',
    entryPrice: 101, initialSlPrice: 90, filledVolumeCents: 100, quoteToAccountRate: 1, capturedAtMs: 1000 })!;
const trade = { ticker: 'TEST', direction: 'BUY', ctraderPositionId: '42', symbolId: 1,
    accountCurrency: 'USD', riskSnapshot: snapshot };
const resolve = (ds: any[]) => risk.resolveTradeCloseAccounting('42', trade, ds, 'USD');

test('unprotected partial still emergency-closes through production confirmation and protection readback', async () => {
    const h = harness(false);
    const result = await h.run();
    assert.equal(result.success, false);
    assert.equal(result.positionId, '42');
    assert.equal(h.closed.length, 1);
    assert.equal(h.sent.length, 1);
    assert.equal(h.historyReads.length, 1);
    assert.match(result.error, /SL\/TP no verificados/);
});

test('protected partial cancels and reconciles an outstanding remainder without duplicate entry', async () => {
    const h = harness();
    h.setOrders([{ orderId: 9, positionId: 42, tradeData: { label: 'OFFLINE', symbolId: 1 } }]);
    const result = await h.run();
    assert.equal(result.success, true, result.error);
    assert.equal(h.closed.length, 0);
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1].type, PayloadType.CANCEL_ORDER_REQ);
    assert.equal(h.sent[1].payload.orderId, 9);
    assert.equal(result.filledVolumeCents, 100);
});

test('confirmation uses explicit positive fills independent of deal order, not requested volume or last status', async () => {
    for (const ds of [[opening, rejected], [rejected, opening]]) {
        const h = harness(); h.setHistory(ds);
        const confirmation = await h.confirm();
        assert.equal(confirmation.rejected, false);
        assert.equal(confirmation.deal.dealId, opening.dealId);
    }
    const h = harness(); h.setHistory([rejected]);
    const confirmation = await h.confirm();
    assert.equal(confirmation.rejected, true, 'a rejected attempt alone does not prove execution');
    assert.equal(confirmation.dealStatusName, 'INTERNALLY_REJECTED');
    assert.equal(resolve([rejected]), null);
});

test('ambiguous or mismatched confirmation evidence remains unconfirmed', async () => {
    for (const ambiguous of [
        { ...rejected, dealStatus: 1 }, { ...rejected, dealStatus: 2 },
        { ...rejected, filledVolume: undefined }, { ...rejected, filledVolume: null },
        { ...opening, filledVolume: 0 }, { ...opening, filledVolume: undefined },
        { ...opening, positionId: 99 },
    ]) {
        const h = harness(); h.setHistory([ambiguous]);
        const confirmation = await h.confirm();
        assert.equal(confirmation.rejected, false);
        assert.equal(confirmation.dealStatusName, 'UNCONFIRMED');
        assert.equal(confirmation.deal, undefined, JSON.stringify(ambiguous));
    }
});

test('only explicit zero-fill terminal rejections are omitted from executed accounting', async () => {
    for (const dealStatus of [4, 5, 6, 7]) {
        assert.equal(resolve([opening, { ...rejected, dealStatus }, closing])?.riskAccountingStatus, 'VERIFIED');
    }
    for (const ambiguous of [
        { ...rejected, dealStatus: 0 }, { ...rejected, dealStatus: 1 }, { ...rejected, dealStatus: 2 },
        { ...rejected, dealStatus: 3 }, { ...rejected, dealStatus: 8 }, { ...rejected, dealStatus: undefined },
        { ...rejected, filledVolume: undefined }, { ...rejected, filledVolume: null },
        { ...rejected, filledVolume: '0' }, { ...rejected, filledVolume: 100 },
        { ...rejected, executionPrice: 101 }, { ...rejected, closePositionDetail: { closedVolume: 0 } },
        ...['commission', 'swap', 'grossProfit', 'pnl'].flatMap(field => [-1, 1, NaN, null, '0'].map(value => ({ ...rejected, [field]: value }))),
    ]) assert.equal(resolve([opening, ambiguous, closing]), null, JSON.stringify(ambiguous));
});

test('deduplication and identity validation include rejected attempts before exclusion', async () => {
    assert.equal(resolve([rejected, opening, closing, rejected, opening, closing])?.pnl, -11.03);
    for (const invalid of [
        { ...rejected, positionId: 99 }, { ...rejected, symbolId: 99 }, { ...rejected, dealId: undefined },
    ]) assert.equal(resolve([opening, invalid, closing]), null, JSON.stringify(invalid));
    assert.equal(resolve([opening, rejected, { ...rejected, executionTimestamp: 1101 }, closing]), null);
    assert.equal(resolve([opening, rejected, { ...closing, executionTimestamp: 2001 }, closing]), null);
    assert.equal(resolve([opening, rejected]), null, 'no final close means accounting remains held');
});

test('requested deal volume is never substituted for missing executed filledVolume', async () => {
    for (const dealStatus of [2, 3, undefined]) {
        const noFillEvidence = { ...opening, volume: 100, filledVolume: undefined, dealStatus };
        assert.equal(resolve([noFillEvidence, rejected, closing]), null, 'opening needs explicit executed volume');
        const noCloseEvidence = { ...closing, filledVolume: undefined, dealStatus };
        assert.equal(resolve([opening, rejected, noCloseEvidence]), null, 'closing needs explicit executed volume');
    }
});

let failures = 0, ran = 0;
for (const [name, run] of cases) {
    if (process.env.CASE && !name.includes(process.env.CASE)) continue;
    ran++;
    try { await run(); console.log('PASS', name); }
    catch (error) { failures++; console.error('FAIL', name, error); }
}
console.log(`REJECTED_REMAINDER_ACCOUNTING: ${ran} cases run; ${failures} failures`);
assert.equal(failures, 0);
