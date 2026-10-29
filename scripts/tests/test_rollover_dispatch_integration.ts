import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { CTraderConnection, PayloadType } from 'ctrader-ts';
import { decodeMessage, encodeMessage } from '../../node_modules/ctrader-ts/dist/src/protocol/codec.js';
import { authorizedBrokerRequest } from '../../src/engine/OrderSafety.js';
import { runRolloverTriageExecution } from '../../src/engine/RolloverTriageExecutor.js';
import { registerRolloverSchedule } from '../../src/engine/RolloverSpreadGate.js';
import type { RolloverTriageContext } from '../../src/engine/RolloverTriagePolicy.js';
import type { RolloverExecutionState } from '../../src/engine/RolloverTriageExecutor.js';

// Explicit artificial prices. Real executor, production adapters/caller arrows,
// installed SDK queue and protobuf; only broker socket and persistence are fake.
registerRolloverSchedule('EURUSD', { scheduleTimeZone: 'America/New_York', schedule: Array.from({ length: 5 }, (_, i) => ({ startSecond: 61205 + i * 86400, endSecond: 145795 + i * 86400 })) });
function harness(side: 'BUY' | 'SELL' = 'BUY', reject = false) {
    let clock = Date.parse('2026-07-13T20:26:00Z');
    const c: RolloverTriageContext = {
        profile: 'rollover_triage_v1', ticker: 'EURUSD', tradeId: 'dispatch-integration', direction: side, nowMs: clock,
        entryPrice: 100, initialSlPrice: side === 'BUY' ? 90 : 110, initialRiskPrice: 10,
        currentSlPrice: side === 'BUY' ? 90 : 110,
        quote: { bid: side === 'BUY' ? 98 : 101.9, ask: side === 'BUY' ? 98.1 : 102, bidTimestampMs: clock, askTimestampMs: clock },
        tickSize: .1, minStopDistancePrice: .2, protectionEarned: false,
        costs: { remainingCostsCash: 2, remainingValuePerPriceUnit: 1 }, partial: { tp1Confirmed: false, realizedNetCash: 0 },
        htf: { aligned: true, availableAtMs: clock - 1000 }, peakSpread: { price: 8, availableAtMs: clock - 1000 },
        config: { maxExtraRiskR: .3, greenPeakMultiple: 1.25, greenMinR: .85, structuralPeakMultiple: 1.35, beMinDistancePeakMultiple: 1.15, severeLossR: -.8, maxQuoteAgeMs: 10000 },
        normalization: { snapshot: { bid: 98, ask: 98.1, ts: clock, ageMs: 0, samples: 100, spread: .1, baselineSpread: .1 }, baseSpreadPrice: .1, pipSize: .1 }
    };
    const identity = { ticker: c.ticker, tradeId: c.tradeId, positionKey: 'offline-position-42' };
    let position: any = { positionId: 42, stopLoss: c.currentSlPrice, takeProfit: side === 'BUY' ? 140 : 60, tradeData: { symbolId: 1, volume: 100 } };
    let state: RolloverExecutionState = { pending: null, widenReference: null };
    const writes: any[] = [], events: string[] = [];
    const connection: any = new CTraderConnection({ host: 'OFFLINE.invalid', requestTimeoutMs: 2000 });
    connection.socket = { destroyed: false, write(frame: Buffer) {
        const message = decodeMessage(frame.subarray(4)); writes.push(message); events.push('send');
        if (!reject) {
            if (message.payloadType === PayloadType.AMEND_POSITION_SLTP_REQ) {
                position.stopLoss = (message.payload as any).stopLoss; c.currentSlPrice = position.stopLoss;
            } else if (message.payloadType === PayloadType.CLOSE_POSITION_REQ) position = null;
        }
        queueMicrotask(() => connection.handleData(encodeMessage(reject ? PayloadType.OA_ERROR_RES : PayloadType.APP_AUTH_RES,
            reject ? { ctidTraderAccountId: 1, errorCode: 'REQUEST_FREQUENCY_EXCEEDED', description: 'offline fixture' } : { ctidTraderAccountId: 1 }, message.clientMsgId)));
        return true;
    }};
    const quiet = { log() {}, warn() {}, error() {} };
    const ctx: any = { exports: {}, console: quiet, config: { CTRADER_ACCOUNT_ID: '1' }, PayloadType, authorizedBrokerRequest,
        ctClient: { connection, getState: async () => ({ positions: position ? [structuredClone(position)] : [] }) },
        isCTraderReady: () => true, connectCTrader: async () => { throw new Error('no network permitted'); },
        symbolToTicker: new Map([[1, 'EURUSD']]), getSymbolDigits: async () => 1,
        verifyPositionProtection: async (_id: number, expected: any) => position?.stopLoss === expected.stopLoss,
        readPositionProtection: async () => ({ exists: !!position, stopLoss: position?.stopLoss ?? null }), setTimeout
    };
    const service = fs.readFileSync('src/services/ctrader.ts', 'utf8');
    const ast = ts.createSourceFile('ctrader.ts', service, ts.ScriptTarget.Latest, true);
    const names = new Set(['amendSltpChecked', 'modifyStopLoss', 'closePosition']);
    const selected = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text ?? ''));
    assert.equal(selected.length, 3);
    vm.runInNewContext(ts.transpileModule(selected.map(n => n.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, ctx);
    // Use the exact production dependency arrows, not lookalike recording stubs.
    const trading = ts.createSourceFile('trading.ts', fs.readFileSync('src/db/trading.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    let arrows: ts.ObjectLiteralExpression | undefined;
    const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && n.expression.getText(trading) === 'runRolloverTriageExecution'
            && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) arrows = n.arguments[0];
        ts.forEachChild(n, visit);
    };
    visit(trading); assert.ok(arrows);
    const properties = arrows.properties.filter(p => p.name && ['amendStopLoss', 'closePosition'].includes(p.name.getText(trading)));
    assert.equal(properties.length, 2);
    const caller: any = { rolloverBroker: ctx.exports, fill: { positionId: '42' },
        acceptPosition: (p: any) => !!p && String(p.positionId) === '42' && p.tradeData.volume === 100 };
    const code = `globalThis.adapters = ({${properties.map(p => p.getText(trading)).join(',')}});`;
    vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, caller);
    const persist = async (write: any) => {
        events.push('persist:' + (write.state.pending?.status ?? 'clear'));
        state = structuredClone(write.state); c.pending = state.pending; c.widenReference = state.widenReference;
    };
    const deps = { identity, get state() { return structuredClone(state); }, nowMs: () => clock,
        getContext: (now: number) => ({ positionKey: identity.positionKey, context: { ...c, nowMs: now } }),
        readProtection: async (): Promise<any> => position ? { status: 'OPEN', identity, stopLossPrice: position.stopLoss } : { status: 'CLOSED', identity },
        persistIntent: persist, persistConfirmed: persist, clearPending: persist, ...caller.adapters };
    const run = async () => { connection.lastRequestSentAt = 0; return runRolloverTriageExecution(deps); };
    return { c, connection, writes, events, run,
        advance: (ms: number) => { clock += ms; },
        postRollover: (bid: number, ask: number) => {
            clock = Date.parse('2026-07-14T10:00:00Z'); c.quote = { bid, ask, bidTimestampMs: clock, askTimestampMs: clock };
            c.normalization.snapshot = { ...c.normalization.snapshot!, bid, ask, ts: clock, spread: ask - bid };
        }
    };
}

test('real caller, adapters and SDK dispatch BUY/SELL widening exactly once and restore the original SL', async () => {
    for (const side of ['BUY', 'SELL'] as const) {
        const h = harness(side);
        const widened = await h.run();
        assert.equal(widened.status, 'CONFIRMED', 'a valid single-use authorization must reach the socket');
        assert.equal(h.writes.length, 1);
        assert.equal(widened.proposal?.action, 'WIDEN_BOUNDED_SL');
        assert.ok(h.events.findIndex(e => e.startsWith('persist:')) < h.events.indexOf('send'));
        h.postRollover(side === 'BUY' ? 98 : 101.9, side === 'BUY' ? 98.1 : 102);
        const restored = await h.run();
        assert.equal(restored.status, 'CONFIRMED'); assert.equal(restored.proposal?.action, 'RESTORE_ORIGINAL_SL');
        assert.equal(h.writes.length, 2); assert.equal(restored.state.pending, null); assert.ok(restored.state.widenReference);
    }
});

test('real caller and SDK dispatch BUY/SELL net BE, proactive close and forced restoration close', async () => {
    for (const side of ['BUY', 'SELL'] as const) {
        const be = harness(side); be.c.quote!.bid = side === 'BUY' ? 120 : 79.9; be.c.quote!.ask = side === 'BUY' ? 120.1 : 80;
        const moved = await be.run(); assert.equal(moved.status, 'CONFIRMED'); assert.equal(moved.proposal?.action, 'MOVE_TO_NET_BE'); assert.equal(be.writes.length, 1);
        const close = harness(side); close.c.costs = null; close.c.quote!.bid = side === 'BUY' ? 91 : 108.9; close.c.quote!.ask = side === 'BUY' ? 91.1 : 109;
        const closed = await close.run(); assert.equal(closed.status, 'CONFIRMED'); assert.equal(closed.proposal?.action, 'CLOSE_PROACTIVE_MARKET'); assert.equal(close.writes.length, 1);
        const forced = harness(side); assert.equal((await forced.run()).status, 'CONFIRMED');
        forced.postRollover(side === 'BUY' ? 89 : 110.9, side === 'BUY' ? 89.1 : 111); forced.c.costs = null;
        const restored = await forced.run(); assert.equal(restored.status, 'CONFIRMED'); assert.equal(restored.proposal?.action, 'FORCE_CLOSE_BREACHED_ORIG_SL'); assert.equal(forced.writes.length, 2);
    }
});

test('SDK queued protection authorizes at dispatch and denies a quote that becomes stale in the queue', async () => {
    for (const stale of [false, true]) {
        const h = harness(); h.connection.inFlightRequests = 5;
        const pending = h.run();
        for (let i = 0; i < 100 && h.connection.requestQueue.length === 0; i++) await new Promise<void>(r => setImmediate(r));
        assert.equal(h.connection.requestQueue.length, 1); assert.equal(h.writes.length, 0);
        if (stale) h.advance(10001);
        h.connection.inFlightRequests = 0; h.connection.lastRequestSentAt = 0; h.connection.drainQueue();
        const result = await pending;
        assert.equal(result.status, stale ? 'UNCERTAIN' : 'CONFIRMED'); assert.equal(h.writes.length, stale ? 0 : 1);
        if (stale) assert.equal(result.state.pending?.status, 'INTENT');
    }
});

test('SDK authoritative rejection does not retry the single-use rollover mutation', async () => {
    const h = harness('BUY', true); const result = await h.run();
    assert.equal(result.status, 'UNCERTAIN'); assert.equal(h.writes.length, 1); assert.equal(result.state.pending?.status, 'INTENT');
});
