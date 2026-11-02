import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { registerRolloverSchedule } from '../src/engine/RolloverSpreadGate.js';

const policyUrl = new URL('../src/engine/RolloverTriagePolicy.js', import.meta.url);
async function policy() {
    assert.ok(fs.existsSync(new URL('../src/engine/RolloverTriagePolicy.ts', import.meta.url)), 'experimental triage policy must exist');
    return import(policyUrl.href);
}
registerRolloverSchedule('EURUSD', { scheduleTimeZone: 'America/New_York', schedule: Array.from({ length: 5 }, (_, i) => ({ startSecond: 61205 + i * 86400, endSecond: 145795 + i * 86400 })) });
export const fixture = () => {
    const nowMs = Date.parse('2026-07-13T20:26:00Z');
    return {
        profile: 'rollover_triage_v1', ticker: 'EURUSD', tradeId: 't1', direction: 'BUY', nowMs,
        entryPrice: 100, initialSlPrice: 90, initialRiskPrice: 10, currentSlPrice: 90,
        quote: { bid: 98, ask: 98.1, bidTimestampMs: nowMs, askTimestampMs: nowMs },
        tickSize: 0.1, minStopDistancePrice: 0.2, protectionEarned: false,
        costs: { remainingCostsCash: 2, remainingValuePerPriceUnit: 1 },
        partial: { tp1Confirmed: false, realizedNetCash: 0 },
        htf: { aligned: true, availableAtMs: nowMs - 1000 },
        peakSpread: { price: 8, availableAtMs: nowMs - 1000 },
        config: { maxExtraRiskR: 0.30, greenPeakMultiple: 1.25, greenMinR: 0.85, structuralPeakMultiple: 1.35, beMinDistancePeakMultiple: 1.15, severeLossR: -0.8, maxQuoteAgeMs: 10000 },
        normalization: { snapshot: { bid: 98, ask: 98.1, ts: nowMs, ageMs: 0, samples: 100, spread: 0.1, baselineSpread: 0.1 }, baseSpreadPrice: 0.1, pipSize: 0.1 }
    } as any;
};

test('widen is a pure stable proposal, aggregate budget never compounds', async () => {
    const { evaluateRolloverTriage } = await policy();
    const ctx = fixture();
    const before = JSON.stringify(ctx);
    const first = evaluateRolloverTriage(ctx);
    assert.equal(first.action, 'WIDEN_BOUNDED_SL');
    assert.equal(first.stopLossPrice, 87);
    assert.equal(first.pendingIntent.extraRiskR, 0.3);
    assert.deepEqual(evaluateRolloverTriage(ctx), first, 'same unconfirmed request is idempotent');
    assert.equal(JSON.stringify(ctx), before, 'proposal cannot mutate input/pending/stats');
    const applied = { ...ctx, currentSlPrice: first.stopLossPrice, pending: { ...first.pendingIntent, status: 'CONFIRMED' } };
    assert.equal(evaluateRolloverTriage(applied).action, 'HOLD', 'no second widening');
});

test('durable pending restores overnight; executable breach closes; unknown retains pending', async () => {
    const { evaluateRolloverTriage } = await policy();
    const base = fixture();
    const p = evaluateRolloverTriage(base).pendingIntent;
    const nowMs = Date.parse('2026-07-14T10:00:00Z');
    const c = { ...base, nowMs, currentSlPrice: 87, pending: { ...p, status: 'CONFIRMED' },
        quote: { bid: 98, ask: 98.1, bidTimestampMs: nowMs, askTimestampMs: nowMs },
        normalization: { ...base.normalization, snapshot: { ...base.normalization.snapshot, ts: nowMs } } };
    const before = JSON.stringify(c);
    const restore = evaluateRolloverTriage(c);
    assert.equal(restore.action, 'RESTORE_ORIGINAL_SL');
    assert.equal(restore.stopLossPrice, 90);
    assert.equal(JSON.stringify(c), before);
    assert.equal(evaluateRolloverTriage({ ...c, quote: { ...c.quote, bid: 89.9, ask: 90 }, normalization: { ...c.normalization, snapshot: { ...c.normalization.snapshot, bid: 89.9, ask: 90 } } }).action, 'FORCE_CLOSE_BREACHED_ORIG_SL');
    assert.equal(evaluateRolloverTriage({ ...c, quote: null }).action, 'HOLD');
    assert.equal(evaluateRolloverTriage({ ...c, normalization: { ...c.normalization, snapshot: null } }).action, 'HOLD');
    assert.equal(evaluateRolloverTriage({ ...c, currentSlPrice: 92 }).action, 'HOLD', 'executor confirms equivalent/better protection before removing pending');
    assert.equal(evaluateRolloverTriage({ ...c, pending: { ...c.pending, status: 'INTENT' } }).action, 'HOLD');
});

test('green BE covers remaining costs and real executable distance; critical closes never widen profit', async () => {
    const { evaluateRolloverTriage } = await policy();
    const c = fixture();
    const green = { ...c, quote: { ...c.quote, bid: 120, ask: 120.1 } };
    const be = evaluateRolloverTriage(green);
    assert.equal(be.action, 'MOVE_TO_NET_BE');
    assert.equal(be.stopLossPrice, 102);
    assert.ok(green.quote.bid - be.stopLossPrice > c.peakSpread.price * c.config.beMinDistancePeakMultiple);
    assert.equal(evaluateRolloverTriage({ ...green, costs: { ...c.costs, remainingCostsCash: 15 } }).action, 'HOLD');
    assert.equal(evaluateRolloverTriage({ ...green, costs: null }).action, 'HOLD');
    assert.equal(evaluateRolloverTriage({ ...c, quote: { ...c.quote, bid: 100.1, ask: 100.2 } }).action, 'CLOSE_PROACTIVE_MARKET');
    assert.equal(evaluateRolloverTriage({ ...c, quote: { ...c.quote, bid: 91.9, ask: 92 } }).action, 'CLOSE_PROACTIVE_MARKET');
    assert.equal(evaluateRolloverTriage({ ...c, partial: { tp1Confirmed: true, realizedNetCash: 4 } }).action, 'CLOSE_PROACTIVE_MARKET');
    assert.equal(evaluateRolloverTriage({ ...c, peakSpread: { ...c.peakSpread, price: 1 } }).action, 'HOLD', 'structural buffer sufficient');
});

test('bounded guards preserve protection, lifetime latch, broker-local Friday and SELL Ask', async () => {
    const { evaluateRolloverTriage } = await policy();
    const c = fixture();
    for (const override of [
        { profile: undefined }, { quote: null }, { quote: { ...c.quote, askTimestampMs: c.nowMs - 10001 } },
        { currentSlPrice: 101 }, { currentSlPrice: 89 }, { protectionEarned: true }, { htf: null },
        { htf: { aligned: false, availableAtMs: c.nowMs } }, { initialRiskPrice: 11 },
        { widenReference: { tradeId: 't1', periodKey: 'old' } }, { config: { ...c.config, maxExtraRiskR: 0.31 } }
    ]) assert.equal(evaluateRolloverTriage({ ...c, ...override }).action, 'HOLD', JSON.stringify(override));
    const sell = { ...c, direction: 'SELL', initialSlPrice: 110, currentSlPrice: 110,
        quote: { ...c.quote, bid: 101.9, ask: 102 } };
    const p = evaluateRolloverTriage(sell);
    assert.equal(p.action, 'WIDEN_BOUNDED_SL');
    assert.equal(p.stopLossPrice, 113);
    assert.ok((p.stopLossPrice - 110) / 10 <= 0.30);
    const be = evaluateRolloverTriage({ ...sell, quote: { ...sell.quote, bid: 79.9, ask: 80 } });
    assert.equal(be.action, 'MOVE_TO_NET_BE');
    assert.equal(be.stopLossPrice, 98);
    registerRolloverSchedule('FRIDAY', { scheduleTimeZone: 'America/New_York', schedule: Array.from({ length: 7 }, (_, i) => ({ startSecond: i * 86400 + 5, endSecond: i * 86400 + 86395 })) });
    const friday = Date.parse('2026-07-17T03:56:00Z'); // Thursday local; interval crosses midnight UTC.
    const fridayLocal = Date.parse('2026-07-18T03:56:00Z');
    assert.equal(evaluateRolloverTriage({ ...c, ticker: 'FRIDAY', nowMs: fridayLocal, quote: { ...c.quote, bidTimestampMs: fridayLocal, askTimestampMs: fridayLocal } }).action, 'HOLD');
    assert.equal(evaluateRolloverTriage({ ...c, ticker: 'FRIDAY', nowMs: friday, quote: { ...c.quote, bidTimestampMs: friday, askTimestampMs: friday } }).action, 'WIDEN_BOUNDED_SL');
});

test('missing partial/config evidence cannot authorize widening; executable BE distance includes broker minimum', async () => {
    const { evaluateRolloverTriage } = await policy();
    const c = fixture();
    assert.equal(evaluateRolloverTriage({ ...c, partial: null }).action, 'HOLD');
    const config = { ...c.config };
    delete config.structuralPeakMultiple;
    assert.equal(evaluateRolloverTriage({ ...c, config }).action, 'HOLD');
    assert.equal(evaluateRolloverTriage({ ...c, quote: { ...c.quote, bid: 120, ask: 120.1 }, minStopDistancePrice: 19 }).action, 'HOLD');
    const sell = { ...c, direction: 'SELL', initialSlPrice: 110, currentSlPrice: 113,
        quote: { ...c.quote, bid: 109.95, ask: 110.05 },
        pending: { tradeId: 't1', periodKey: 'old', initialRiskPrice: 10, originalSlPrice: 110, widenedSlPrice: 113, extraRiskR: 0.3, status: 'CONFIRMED' } };
    const nowMs = Date.parse('2026-07-14T10:00:00Z');
    sell.nowMs = nowMs;
    sell.quote = { ...sell.quote, bidTimestampMs: nowMs, askTimestampMs: nowMs };
    sell.normalization = { ...sell.normalization, snapshot: { ...sell.normalization.snapshot, ts: nowMs, bid: sell.quote.bid, ask: sell.quote.ask } };
    assert.equal(evaluateRolloverTriage(sell).action, 'FORCE_CLOSE_BREACHED_ORIG_SL', 'SELL uses Ask not Bid');
});

test('restoration normalization must describe the same bilateral executable quote', async () => {
    const { evaluateRolloverTriage } = await policy();
    const c = fixture();
    const p = evaluateRolloverTriage(c).pendingIntent;
    const nowMs = Date.parse('2026-07-14T10:00:00Z');
    const pending = { ...p, status: 'CONFIRMED' };
    const mismatched = { ...c, nowMs, currentSlPrice: 87, pending,
        quote: { ...c.quote, ask: 106, bidTimestampMs: nowMs, askTimestampMs: nowMs },
        normalization: { ...c.normalization, snapshot: { ...c.normalization.snapshot, ts: nowMs } } };
    assert.equal(evaluateRolloverTriage(mismatched).action, 'HOLD', 'narrow independent snapshot cannot certify wide execution quote');
});
