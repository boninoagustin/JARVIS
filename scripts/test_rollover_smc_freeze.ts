import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SMCEngine } from '../src/engine/smc/SMCEngine.js';

const t0 = Date.parse('2026-07-13T20:00:00Z');
const candle = (timestamp: number, center = 100) => ({ timestamp, open: center, high: center + 1, low: center - 1, close: center + 0.5, volume: 100 });
const preset: any = { name: 'isolated', risk_level: 3, asset_type: 'forex', override_choch: true, require_displacement: false, require_fvg_after_ob: false, strict_breaker: false, strict_sweep: false, confirm_close: true, min_score: 0, choch_require_sweep: false, choch_require_momentum: false, valid_bos_displacement: false };
const freeze = { profile: 'rollover_freeze_v1', ticker: 'EURUSD', metadataAvailable: true, intervals: [{ startMs: t0 + 20 * 60000, endMs: t0 + 30 * 60000 }] } as any;
function modelSnapshot(e: any) {
    return structuredClone(Object.fromEntries(Object.entries(e).filter(([key]) => key !== 'rolloverRawObservation')));
}

test('actual engine excludes whole overlapping bars BEFORE structure/liquidity/math mutate; clean bars resume', () => {
    const e: any = new SMCEngine(preset, 'M5');
    for (let i = 0; i < 4; i++) e.nextCandle(candle(t0 + i * 5 * 60000), freeze);
    const before = modelSnapshot(e);
    assert.deepEqual(e.nextCandle(candle(t0 + 20 * 60000, 1000), freeze), []);
    assert.deepEqual(modelSnapshot(e), before, 'no pivots/ATR/CRT/pending/cooldown/levels/extremes may advance');
    assert.equal(e.getLastRolloverObservation().excluded, true);
    assert.equal(e.getLastRolloverObservation().candle.high, 1001);
    assert.equal(e.lastProcessedTs, t0 + 15 * 60000);
    assert.deepEqual(e.nextCandle(candle(t0 + 20 * 60000, 1000), freeze), [], 'excluded input never replays');
    assert.deepEqual(modelSnapshot(e), before);
    e.nextCandle(candle(t0 + 30 * 60000, 101), freeze);
    assert.notDeepEqual(modelSnapshot(e), before, 'not a blanket no-op after thaw');
    assert.equal(e.lastProcessedTs, t0 + 30 * 60000);
    assert.equal(e.getLastRolloverObservation().excluded, false);
});

test('HTF overlap excludes the entire bar and contaminated HTF context; missing evidence freezes only opt-in', () => {
    const e: any = new SMCEngine(preset, 'H1');
    const before = modelSnapshot(e);
    e.nextCandle(candle(t0, 1000), freeze); // Opened before freeze, ends after it.
    assert.deepEqual(modelSnapshot(e), before);
    e.setHTFContext('Bullish', 'Bullish', freeze, { startMs: t0, endMs: t0 + 3600000 });
    assert.deepEqual(modelSnapshot(e), before);
    e.setHTFContext('Bearish', 'Bearish', freeze, { startMs: t0 + 3600000, endMs: t0 + 7200000 });
    assert.equal(e.weeklyBias, 'Bearish');
    const noMetadata: any = new SMCEngine(preset, 'M5');
    noMetadata.nextCandle(candle(t0), { ...freeze, metadataAvailable: false });
    assert.equal(noMetadata.lastProcessedTs, undefined);
    noMetadata.nextCandle(candle(t0 + 5 * 60000));
    assert.equal(noMetadata.lastProcessedTs, t0 + 5 * 60000, 'legacy default never freezes');
});
