import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { registerRolloverSchedule } from '../../src/engine/RolloverSpreadGate.js';
import { evaluateRolloverTriage } from '../../src/engine/RolloverTriagePolicy.js';
import type { RolloverTriageContext } from '../../src/engine/RolloverTriagePolicy.js';
import type { RolloverTriageExecutionDependencies, RolloverExecutionState, RolloverProtectionReadback } from '../../src/engine/RolloverTriageExecutor.js';

async function executor() {
    assert.ok(fs.existsSync(new URL('../../src/engine/RolloverTriageExecutor.ts', import.meta.url)), 'transactional executor must exist');
    return import('../../src/engine/RolloverTriageExecutor.js');
}
registerRolloverSchedule('EURUSD', { scheduleTimeZone: 'America/New_York', schedule: Array.from({ length: 5 }, (_, i) => ({ startSecond: 61205 + i * 86400, endSecond: 145795 + i * 86400 })) });
function fixture(direction: 'BUY' | 'SELL' = 'BUY'): RolloverTriageContext {
    const nowMs = Date.parse('2026-07-13T20:26:00Z');
    const bid = direction === 'BUY' ? 98 : 101.9;
    const ask = direction === 'BUY' ? 98.1 : 102;
    return {
        profile: 'rollover_triage_v1', ticker: 'EURUSD', tradeId: 't1', direction, nowMs,
        entryPrice: 100, initialSlPrice: direction === 'BUY' ? 90 : 110, initialRiskPrice: 10,
        currentSlPrice: direction === 'BUY' ? 90 : 110,
        quote: { bid, ask, bidTimestampMs: nowMs, askTimestampMs: nowMs },
        tickSize: 0.1, minStopDistancePrice: 0.2, protectionEarned: false,
        costs: { remainingCostsCash: 2, remainingValuePerPriceUnit: 1 }, partial: { tp1Confirmed: false, realizedNetCash: 0 },
        htf: { aligned: true, availableAtMs: nowMs - 1000 }, peakSpread: { price: 8, availableAtMs: nowMs - 1000 },
        config: { maxExtraRiskR: 0.30, greenPeakMultiple: 1.25, greenMinR: 0.85, structuralPeakMultiple: 1.35, beMinDistancePeakMultiple: 1.15, severeLossR: -0.8, maxQuoteAgeMs: 10000 },
        normalization: { snapshot: { bid, ask, ts: nowMs, ageMs: 0, samples: 100, spread: 0.1, baselineSpread: 0.1 }, baseSpreadPrice: 0.1, pipSize: 0.1 }
    };
}
function harness(direction: 'BUY' | 'SELL' = 'BUY') {
    const c = fixture(direction);
    const identity = { ticker: c.ticker, tradeId: c.tradeId, positionKey: 'broker-position-incarnation-1' };
    const events: string[] = [];
    let clock = c.nowMs;
    let protection: RolloverProtectionReadback = { status: 'OPEN', identity, stopLossPrice: c.currentSlPrice };
    let durable: RolloverExecutionState = { pending: null, widenReference: null };
    const deps: RolloverTriageExecutionDependencies = {
        identity, get state() { return { pending: c.pending ?? null, widenReference: c.widenReference ?? null }; }, nowMs: () => clock,
        getContext: nowMs => { events.push(`context:${nowMs}`); return { positionKey: identity.positionKey, context: { ...c, nowMs } }; },
        readProtection: async () => { events.push('read'); return structuredClone(protection); },
        persistIntent: async payload => { events.push('intent'); durable = structuredClone(payload.state); c.pending = durable.pending; c.widenReference = durable.widenReference; },
        persistConfirmed: async payload => { events.push('confirmed'); durable = structuredClone(payload.state); c.pending = durable.pending; c.widenReference = durable.widenReference; },
        clearPending: async payload => { events.push('clear'); durable = structuredClone(payload.state); c.pending = durable.pending; c.widenReference = durable.widenReference; },
        amendStopLoss: async (request, authorize) => {
            if (!authorize()) { events.push('denied'); return 'REJECTED'; }
            events.push(`amend:${request.stopLossPrice}`);
            c.currentSlPrice = request.stopLossPrice;
            protection = { status: 'OPEN', identity, stopLossPrice: request.stopLossPrice };
            return 'ACKNOWLEDGED';
        },
        closePosition: async (_request, authorize) => {
            if (!authorize()) { events.push('denied'); return 'REJECTED'; }
            events.push('close'); protection = { status: 'CLOSED', identity }; return 'ACKNOWLEDGED';
        }
    };
    return { c, deps, events, identity, get durable() { return durable; }, set protection(p: RolloverProtectionReadback) { protection = p; }, advance(ms: number) { clock += ms; }, setClock(ms: number) { clock = ms; } };
}

test('BUY widening persists durable intent before broker, confirms readback and lifetime latch', async () => {
    const { runRolloverTriageExecution } = await executor();
    const h = harness();
    const result = await runRolloverTriageExecution(h.deps);
    assert.equal(result.status, 'CONFIRMED');
    assert.equal(result.state.pending?.status, 'CONFIRMED');
    assert.equal(result.state.widenReference?.widenedSlPrice, 87);
    assert.equal(h.durable.pending?.status, 'CONFIRMED');
    assert.ok(h.events.indexOf('intent') < h.events.indexOf('amend:87'));
    assert.ok(h.events.lastIndexOf('read') < h.events.indexOf('confirmed'));
    assert.equal(h.events.filter(e => e.startsWith('amend:')).length, 1);
    assert.equal('pnl' in result, false);
    assert.equal('stats' in result, false);
});

function postRollover(h: ReturnType<typeof harness>, bid: number, ask: number) {
    const now = Date.parse('2026-07-14T10:00:00Z');
    h.setClock(now);
    h.c.nowMs = now;
    h.c.quote = { bid, ask, bidTimestampMs: now, askTimestampMs: now };
    h.c.normalization.snapshot = { ...h.c.normalization.snapshot!, bid, ask, ts: now, spread: ask - bid };
}

test('BUY/SELL restore only after actual readback, preserving lifetime latch', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    for (const side of ['BUY', 'SELL'] as const) {
        const h = harness(side);
        assert.equal((await run(h.deps)).status, 'CONFIRMED');
        const latch = structuredClone(h.durable.widenReference);
        postRollover(h, side === 'BUY' ? 98 : 101.9, side === 'BUY' ? 98.1 : 102);
        const restored = await run(h.deps);
        assert.equal(restored.status, 'CONFIRMED');
        assert.equal(restored.proposal?.action, 'RESTORE_ORIGINAL_SL');
        assert.equal(restored.state.pending, null);
        assert.deepEqual(restored.state.widenReference, latch);
        assert.equal(h.c.currentSlPrice, side === 'BUY' ? 90 : 110);
        // Back to a future widening period: lifetime latch must still block it.
        const next = Date.parse('2026-07-14T20:26:00Z');
        h.setClock(next); h.c.quote!.bidTimestampMs = next; h.c.quote!.askTimestampMs = next;
        assert.equal((await run(h.deps)).status, 'HOLD');
        assert.equal(h.events.filter(e => e.startsWith('amend:')).length, 2);
    }
});

test('BUY/SELL net-cost BE requires monotonic readback; proactive close does not require costs or invent PnL', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    for (const side of ['BUY', 'SELL'] as const) {
        const h = harness(side);
        h.c.quote!.bid = side === 'BUY' ? 120 : 79.9; h.c.quote!.ask = side === 'BUY' ? 120.1 : 80;
        const result = await run(h.deps);
        assert.equal(result.status, 'CONFIRMED');
        assert.equal(result.proposal?.action, 'MOVE_TO_NET_BE');
        assert.equal(h.c.currentSlPrice, side === 'BUY' ? 102 : 98);
        assert.equal(result.state.pending, null);
        const close = harness(side);
        close.c.costs = null;
        close.c.quote!.bid = side === 'BUY' ? 91 : 108.9; close.c.quote!.ask = side === 'BUY' ? 91.1 : 109;
        const closed = await run(close.deps);
        assert.equal(closed.status, 'CONFIRMED');
        assert.equal(closed.proposal?.action, 'CLOSE_PROACTIVE_MARKET');
        assert.equal('pnl' in closed, false);
        assert.equal(close.events.filter(e => e === 'close').length, 1);
    }
});

test('fresh wall clock revalidation denies stale quote after adapter await and retains intent', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    const h = harness();
    const actualAmend = h.deps.amendStopLoss;
    h.deps.amendStopLoss = async (r, authorize) => {
        await Promise.resolve(); h.advance(10001);
        return actualAmend(r, authorize);
    };
    const r = await run(h.deps);
    assert.equal(r.status, 'UNCERTAIN');
    assert.equal(r.state.pending?.status, 'INTENT');
    assert.equal(h.events.filter(e => e.startsWith('amend:')).length, 0);
    assert.ok(h.events.includes(`context:${h.c.nowMs + 10001}`));
});

test('restart INTENT actual wide reconciles without second AMEND; original-equivalent retains conservative latch', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    for (const side of ['BUY', 'SELL'] as const) {
        for (const wasApplied of [true, false]) {
            const h = harness(side);
            const p = evaluateRolloverTriage(h.c).pendingIntent!;
            h.c.pending = p;
            if (wasApplied) h.c.currentSlPrice = p.widenedSlPrice;
            h.protection = { status: 'OPEN', identity: h.identity, stopLossPrice: h.c.currentSlPrice };
            const r = await run(h.deps);
            assert.equal(r.status, 'RECONCILED');
            assert.equal(r.state.pending?.status ?? null, wasApplied ? 'CONFIRMED' : null);
            assert.ok(r.state.widenReference, 'never re-arm after ambiguous INTENT');
            assert.equal(h.events.filter(e => e.startsWith('amend:')).length, 0);
            assert.equal(h.durable.widenReference?.tradeId, h.c.tradeId);
        }
    }
});

test('verified closure clears pending even when closed position disappears from fresh context', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    const h = harness();
    const p = evaluateRolloverTriage(h.c).pendingIntent!;
    h.c.pending = { ...p, status: 'CONFIRMED' };
    h.c.widenReference = h.c.pending;
    let disappeared = false;
    const get = h.deps.getContext;
    h.deps.getContext = now => disappeared ? null : get(now);
    h.deps.readProtection = async () => { disappeared = true; return { status: 'CLOSED', identity: h.identity }; };
    const r = await run(h.deps);
    assert.equal(r.status, 'RECONCILED');
    assert.equal(r.state.pending, null);
    assert.deepEqual(r.state.widenReference, h.c.widenReference);
    assert.ok(h.events.includes('clear'));
});

test('persistence/readback/AMEND failures never confirm, retain recoverable INTENT and retry by reconciliation', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    for (const failure of ['intent', 'confirmed', 'readback', 'amend_throw', 'amend_reject'] as const) {
        const h = harness();
        const persistConfirmed = h.deps.persistConfirmed;
        if (failure === 'intent') h.deps.persistIntent = async () => { h.events.push('intent_failed'); throw new Error('disk'); };
        if (failure === 'confirmed') h.deps.persistConfirmed = async () => { throw new Error('journal readback'); };
        if (failure === 'readback') {
            const read = h.deps.readProtection; let n = 0;
            h.deps.readProtection = async id => ++n === 3 ? { status: 'UNAVAILABLE' } : read(id);
        }
        if (failure === 'amend_throw' || failure === 'amend_reject') h.deps.amendStopLoss = async (_r, authorize) => {
            assert.ok(authorize());
            if (failure === 'amend_throw') throw new Error('transport');
            return 'REJECTED';
        };
        const r = await run(h.deps);
        assert.equal(r.status, 'UNCERTAIN', failure);
        assert.equal(r.state.pending?.status, 'INTENT', failure);
        assert.equal(r.state.widenReference, null, failure);
        assert.equal(h.events.includes('clear'), false);
        if (failure === 'intent') assert.equal(h.events.some(e => e.startsWith('amend:')), false);
        // Parent retains result state even when persistence failed; retry never
        // blindly resends the original widening proposal.
        h.c.pending = r.state.pending;
        h.c.widenReference = r.state.widenReference;
        h.deps.persistConfirmed = persistConfirmed;
        const amendments = h.events.filter(e => e.startsWith('amend:')).length;
        const recovered = await run(h.deps);
        assert.equal(recovered.status, 'RECONCILED', failure);
        assert.equal(h.events.filter(e => e.startsWith('amend:')).length, amendments, failure);
        assert.ok(recovered.state.widenReference, failure);
    }
});

test('force close breached original: failure/unknown closure retain pending without attempt expiry, verified closure clears', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    for (const side of ['BUY', 'SELL'] as const) {
        const h = harness(side);
        await run(h.deps);
        postRollover(h, side === 'BUY' ? 89 : 110.9, side === 'BUY' ? 89.1 : 111);
        h.c.costs = null; // emergency restoration close does not depend on BE costs
        const pending = structuredClone(h.c.pending);
        h.deps.closePosition = async (_r, authorize) => { assert.ok(authorize()); h.events.push('close_rejected'); return 'REJECTED'; };
        for (let attempt = 0; attempt < 4; attempt++) {
            const rejected = await run(h.deps);
            assert.equal(rejected.proposal?.action, 'FORCE_CLOSE_BREACHED_ORIG_SL');
            assert.equal(rejected.status, 'UNCERTAIN');
            assert.deepEqual(rejected.state.pending, pending);
        }
        const read = h.deps.readProtection; let n = 0;
        h.deps.readProtection = async id => ++n === 3 ? null as unknown as RolloverProtectionReadback : read(id);
        h.deps.closePosition = async (_r, authorize) => { assert.ok(authorize()); return 'ACKNOWLEDGED'; };
        const unknown = await run(h.deps);
        assert.equal(unknown.status, 'UNCERTAIN', 'null is unavailable, NEVER closure');
        assert.deepEqual(unknown.state.pending, pending);
        h.deps.readProtection = read;
        h.deps.closePosition = async (_r, authorize) => { assert.ok(authorize()); h.protection = { status: 'CLOSED', identity: h.identity }; return 'ACKNOWLEDGED'; };
        const closed = await run(h.deps);
        assert.equal(closed.status, 'CONFIRMED');
        assert.equal(closed.state.pending, null);
        assert.ok(closed.state.widenReference);
    }
});

test('failed durable clear retains pending; subsequent retry reconciles verified restored/closed without another broker send', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    for (const closed of [false, true]) {
        const h = harness(); await run(h.deps);
        postRollover(h, closed ? 89 : 98, closed ? 89.1 : 98.1);
        const clear = h.deps.clearPending;
        h.deps.clearPending = async () => { throw new Error('clear durable failure'); };
        const before = structuredClone(h.c.pending);
        const r = await run(h.deps);
        assert.equal(r.status, 'UNCERTAIN');
        assert.deepEqual(r.state.pending, before);
        assert.ok(r.state.widenReference);
        h.deps.clearPending = clear;
        const mutations = h.events.filter(e => e.startsWith('amend:') || e === 'close').length;
        const retry = await run(h.deps);
        assert.equal(retry.status, 'RECONCILED');
        assert.equal(retry.state.pending, null);
        assert.ok(retry.state.widenReference);
        assert.equal(h.events.filter(e => e.startsWith('amend:') || e === 'close').length, mutations);
    }
});

test('post-persistence revalidation rejects changed target, risk, quote, phase, protection and position identity', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    const changes: Array<(h: ReturnType<typeof harness>) => void> = [
        h => { h.c.config.maxExtraRiskR = 0.2; },
        h => { h.c.initialRiskPrice = 11; },
        h => { h.c.entryPrice = 101; },
        h => { h.c.direction = 'SELL'; },
        h => { h.c.currentSlPrice = 91; },
        h => { h.c.quote = null; },
        h => { h.c.protectionEarned = true; },
        h => { h.c.tickSize = 0.7; },
        h => { h.c.minStopDistancePrice = 100; },
        h => { h.advance(120000); h.c.quote!.bidTimestampMs += 120000; h.c.quote!.askTimestampMs += 120000; },
        h => { const get = h.deps.getContext; h.deps.getContext = n => ({ ...get(n)!, positionKey: 'different-position' }); }
    ];
    for (const change of changes) {
        const h = harness(); const persist = h.deps.persistIntent;
        h.deps.persistIntent = async p => { await persist(p); await Promise.resolve(); change(h); };
        const r = await run(h.deps);
        assert.ok(r.status === 'ABORTED' || r.status === 'UNCERTAIN');
        assert.equal(r.state.pending?.status, 'INTENT');
        assert.equal(h.events.some(e => e.startsWith('amend:')), false);
    }
});

test('BE changed costs/protection after adapter await and unconfirmed worse readback never claim success', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    for (const side of ['BUY', 'SELL'] as const) {
        for (const change of ['cost', 'earned', 'worse_readback'] as const) {
            const h = harness(side);
            h.c.quote!.bid = side === 'BUY' ? 120 : 79.9; h.c.quote!.ask = side === 'BUY' ? 120.1 : 80;
            const amend = h.deps.amendStopLoss;
            h.deps.amendStopLoss = async (r, auth) => {
                await Promise.resolve();
                if (change === 'cost') h.c.costs!.remainingCostsCash = 3;
                if (change === 'earned') h.c.currentSlPrice = side === 'BUY' ? 105 : 95;
                if (change === 'worse_readback') { assert.ok(auth()); return 'ACKNOWLEDGED'; }
                return amend(r, auth);
            };
            const r = await run(h.deps);
            assert.equal(r.status, 'UNCERTAIN');
            assert.equal(h.events.includes('confirmed'), false);
            assert.equal(h.events.some(e => e.startsWith('amend:')), false);
        }
    }
});

test('concurrent calls serialize per trade, release on completion/error and never duplicate AMEND', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    const h = harness();
    let release!: () => void; let entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const persist = h.deps.persistIntent;
    h.deps.persistIntent = async p => { entered(); await paused; await persist(p); };
    const first = run(h.deps); await ready;
    const competing = await run(h.deps);
    assert.equal(competing.status, 'IN_FLIGHT');
    assert.equal(h.events.some(e => e.startsWith('amend:')), false);
    release(); assert.equal((await first).status, 'CONFIRMED');
    assert.equal((await run(h.deps)).status, 'HOLD');
    assert.equal(h.events.filter(e => e.startsWith('amend:')).length, 1);
    const error = harness(); error.deps.getContext = () => { throw new Error('snapshot'); };
    assert.equal((await run(error.deps)).status, 'UNCERTAIN');
    assert.equal((await run(error.deps)).status, 'UNCERTAIN', 'finally removes failed in-flight key');
});

test('unknown/mismatched actual position never clears INTENT or sends; default profile performs no I/O', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    for (const protection of ['unknown', 'different', 'ambiguous'] as const) {
        const h = harness(); h.c.pending = evaluateRolloverTriage(h.c).pendingIntent!;
        if (protection === 'unknown') h.protection = { status: 'UNAVAILABLE' };
        if (protection === 'different') h.protection = { status: 'CLOSED', identity: { ...h.identity, positionKey: 'wrong' } };
        if (protection === 'ambiguous') h.protection = { status: 'OPEN', identity: h.identity, stopLossPrice: 88 };
        const r = await run(h.deps);
        assert.equal(r.status, 'UNCERTAIN');
        assert.deepEqual(r.state.pending, h.c.pending);
        assert.equal(h.events.includes('clear'), false);
        assert.equal(h.events.some(e => e.startsWith('amend:')), false);
    }
    const legacy = harness(); legacy.c.profile = undefined;
    assert.equal((await run(legacy.deps)).status, 'HOLD');
    assert.deepEqual(legacy.events.filter(e => !e.startsWith('context:')), []);
});

test('authorization capability expires when adapter settles and is single-use during active send', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    const h = harness();
    let saved!: () => boolean;
    h.deps.amendStopLoss = async (_r, authorize) => { saved = authorize; return 'UNKNOWN'; };
    assert.equal((await run(h.deps)).status, 'UNCERTAIN');
    assert.equal(saved(), false, 'late queued send after executor completion must be denied');
    const single = harness();
    single.deps.amendStopLoss = async (_r, authorize) => {
        assert.equal(authorize(), true);
        assert.equal(authorize(), false, 'one callback cannot authorize two sends');
        return 'REJECTED';
    };
    assert.equal((await run(single.deps)).status, 'UNCERTAIN');
});

test('AMEND accepted then transport throws is confirmed ONLY from verified actual SL', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    const h = harness(); const amend = h.deps.amendStopLoss;
    h.deps.amendStopLoss = async (r, a) => { await amend(r, a); throw new Error('timeout after send'); };
    const r = await run(h.deps);
    assert.equal(r.status, 'CONFIRMED');
    assert.equal(r.state.pending?.status, 'CONFIRMED');
    assert.equal(h.events.filter(e => e.startsWith('amend:')).length, 1);
    assert.equal((await run(h.deps)).status, 'HOLD');
    assert.equal(h.events.filter(e => e.startsWith('amend:')).length, 1);
});

test('missing restoration quote or late-failed quote keeps confirmed pending and lifetime latch unchanged', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    for (const failedAfterPersistence of [false, true]) {
        const h = harness(); await run(h.deps); postRollover(h, 98, 98.1);
        const pending = structuredClone(h.c.pending); const latch = structuredClone(h.c.widenReference);
        if (failedAfterPersistence) {
            const persist = h.deps.persistIntent;
            h.deps.persistIntent = async w => { await persist(w); h.c.quote = null; };
        } else h.c.quote = null;
        const before = h.events.filter(e => e.startsWith('amend:')).length;
        const r = await run(h.deps);
        assert.equal(r.status, failedAfterPersistence ? 'ABORTED' : 'HOLD');
        assert.deepEqual(r.state.pending, pending); assert.deepEqual(r.state.widenReference, latch);
        assert.equal(h.events.filter(e => e.startsWith('amend:')).length, before);
        assert.equal(h.events.includes('clear'), false);
    }
});

test('late successful widening after original-equivalent recovery resurrects restoration obligation from lifetime latch', async () => {
    const { runRolloverTriageExecution: run } = await executor();
    const h = harness(); const intent = evaluateRolloverTriage(h.c).pendingIntent!;
    h.c.pending = intent;
    assert.equal((await run(h.deps)).status, 'RECONCILED');
    assert.equal(h.c.pending, null);
    assert.equal(h.c.widenReference?.status, 'INTENT');
    // A previously timed-out broker request arrives after the original-SL read.
    h.c.currentSlPrice = intent.widenedSlPrice;
    h.protection = { status: 'OPEN', identity: h.identity, stopLossPrice: intent.widenedSlPrice };
    postRollover(h, 98, 98.1);
    const recovered = await run(h.deps);
    assert.equal(recovered.status, 'RECONCILED');
    assert.equal(recovered.state.pending?.status, 'CONFIRMED');
    assert.equal(h.events.some(e => e.startsWith('amend:')), false);
    const restored = await run(h.deps);
    assert.equal(restored.status, 'CONFIRMED');
    assert.equal(restored.proposal?.action, 'RESTORE_ORIGINAL_SL');
    assert.equal(restored.state.pending, null);
    assert.ok(restored.state.widenReference);
});

test('AST import graph is pure, bounded to executor/policy/calendar and reuses real policy', () => {
    const graph: Record<string, string[]> = {
        RolloverTriageExecutor: ['./RolloverTriagePolicy.js'],
        RolloverTriagePolicy: ['./RolloverSpreadGate.js'],
        RolloverSpreadGate: []
    };
    for (const [name, expected] of Object.entries(graph)) {
        const path = new URL(`../../src/engine/${name}.ts`, import.meta.url);
        const source = ts.createSourceFile(path.pathname, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
        const imports = source.statements.filter(ts.isImportDeclaration).filter(n => !n.importClause?.isTypeOnly)
            .map(n => (n.moduleSpecifier as ts.StringLiteral).text);
        assert.deepEqual(imports, expected);
        const calls: string[] = [];
        const visit = (node: ts.Node) => { if (ts.isCallExpression(node)) calls.push(node.expression.getText(source)); ts.forEachChild(node, visit); };
        visit(source);
        for (const forbidden of ['setInterval', 'setTimeout', 'fetch', 'require', 'import']) assert.equal(calls.includes(forbidden), false, `${name}: no ${forbidden}`);
        if (name === 'RolloverTriageExecutor') assert.ok(calls.includes('evaluateRolloverTriage'));
    }
});
