import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SMCEngine } from '../../src/engine/smc/SMCEngine.js';
import { LiquidityEngine } from '../../src/engine/smc/modules/liquidity.js';
import { ZScoreCalculator } from '../../src/engine/smc/math/zscore.js';
import { getPreset } from '../../src/engine/smc/smc_config.js';
import type { OHLCV, SMCPreset } from '../../src/engine/smc/types.js';

const BASE = 1700000000000, STEP = 300000;
const basePreset = () => ({ ...getPreset('Forex - 3. Balanceado'), pivot_len: 3 });
const experimental = (extra: Record<string, unknown> = {}): SMCPreset => ({ ...basePreset(), signal_profile: 'directional_atr_v1', ...extra } as SMCPreset);
const bar = (i: number, extra: Partial<OHLCV> = {}): OHLCV => ({ timestamp: BASE + i * STEP, open: 100, high: 100.5, low: 99.5, close: 100.1, volume: 10, ...extra });
const serialize = (v: unknown) => JSON.stringify(v, (_k, x) => x instanceof Map ? [...x] : Number.isNaN(x) ? 'NaN' : x);
const log = console.log.bind(console);
console.log = () => {};
let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
    try { fn(); passed++; log(`PASS ${name}`); }
    catch (error) { failed++; log(`FAIL ${name}: ${error instanceof Error ? error.stack : error}`); }
}

test('invalid experimental OHLC rejects before every engine state mutation', () => {
    const engine = new SMCEngine(experimental(), 'M5');
    for (let i = 0; i < 70; i++) engine.nextCandle(bar(i));
    const before = serialize(engine);
    assert.deepEqual(engine.nextCandle(bar(70, { open: 105 })), []);
    assert.equal(serialize(engine), before);
    assert.equal(engine.lastProcessedTs, bar(69).timestamp);
    assert.deepEqual(engine.nextCandle(bar(70, { timestamp: NaN })), []);
    assert.equal(serialize(engine), before);
});

test('same-bar absorption uses the explicit ready snapshot, not constructor VWAP Z', () => {
    const candle = bar(80, { open: 100.8, high: 101.5, low: 99, close: 101, volume: 1 });
    const liquidity: any = new LiquidityEngine(new ZScoreCalculator());
    liquidity.dailyLow = 100;
    const snapshot = { timestamp: candle.timestamp, sampleCount: 50, ready: true, zUp: 1.2, zDn: 0, upSmooth: 1, dnSmooth: 0, atr: 1, atrNormalizedRange: 2.5, volumeRatio: 1, priorVolumeMean: 1 };
    const events = liquidity.processCandle(candle, 1, experimental(), snapshot, { availableAt: candle.timestamp + STEP });
    assert.equal(events.length, 1);
    assert.equal(events[0].direction, 'Bullish');
    assert.equal(events[0].sweepType, 'LIQ_GRAB');
    assert.equal(events[0].timestamp, candle.timestamp);
    assert.equal(events[0].availableAt, candle.timestamp + STEP);
    assert.equal(events[0].signalProfile, 'directional_atr_v1');
    assert.equal(liquidity.pendingSweepBull, null);
    assert.equal(liquidity.barCount, 1);
    assert.equal(liquidity.crtWindow.length, 1);
    assert.equal(liquidity.dailyLow, 100);
});

test('same-bar ablation delays emission but exposes actual nominal availability', () => {
    const liquidity: any = new LiquidityEngine(new ZScoreCalculator());
    liquidity.dailyLow = 100;
    const candle = bar(80, { open: 100.8, high: 101.5, low: 99, close: 101 });
    const snapshot = { timestamp: candle.timestamp, sampleCount: 50, ready: true, zUp: 1.2, zDn: 0, upSmooth: 1, dnSmooth: 0, atr: 1, atrNormalizedRange: 2.5, volumeRatio: 1, priorVolumeMean: 10 };
    const preset = experimental({ signal_ablation: { sameBarSweeps: false } });
    assert.deepEqual(liquidity.processCandle(candle, 1, preset, snapshot, { availableAt: candle.timestamp + STEP }), []);
    const next = bar(81, { open: 101, high: 101.2, low: 100.8, close: 101 });
    const events = liquidity.processCandle(next, 1, preset, null, { availableAt: next.timestamp + STEP });
    assert.equal(events.length, 1);
    assert.equal(events[0].timestamp, candle.timestamp);
    assert.equal(events[0].originTimestamp, candle.timestamp);
    assert.equal(events[0].availableAt, next.timestamp + STEP);
});

test('invalid, stale and unready snapshots never reuse an old sweep impulse', () => {
    for (const patch of [{ timestamp: BASE }, { atr: 2 }, { ready: false }, { zUp: NaN }]) {
        const liquidity: any = new LiquidityEngine(new ZScoreCalculator());
        liquidity.dailyLow = 100;
        const candle = bar(80, { open: 100.8, high: 101.5, low: 99, close: 101 });
        const snapshot = { timestamp: candle.timestamp, sampleCount: 50, ready: true, zUp: 1.2, zDn: 0, upSmooth: 1, dnSmooth: 0, atr: 1, atrNormalizedRange: 2.5, volumeRatio: 1, priorVolumeMean: 10, ...patch };
        assert.deepEqual(liquidity.processCandle(candle, 1, experimental(), snapshot), []);
        assert.equal(liquidity.pendingSweepBull, null);
        assert.equal(liquidity.sweepBullActive, false);
    }
});

test('directional frame advances once on actual ATR14, never on VWAP reanchor', () => {
    const engine: any = new SMCEngine(experimental(), 'M5');
    let updates = 0;
    const originalNext = engine.impulse.nextValue.bind(engine.impulse);
    engine.impulse.nextValue = (candle: OHLCV, atr: number) => { updates++; return originalNext(candle, atr); };
    for (let i = 0; i < 70; i++) {
        engine.nextCandle(bar(i));
        assert.equal(updates, Math.max(0, i - 12), 'only actual ATR14 updates; no warmup fallback');
        const snapshot = engine.getState().directionalImpulse;
        if (i < 13) assert.equal(snapshot, null);
        else {
            assert.equal(snapshot.sampleCount, Math.min(i - 12,50), 'sampleCount is the bounded rolling window, not lifetime count');
            assert.equal(snapshot.atr, 1);
            assert.equal(snapshot.timestamp, bar(i).timestamp);
            assert.equal(snapshot.ready, i >= 62);
        }
    }
    const before = engine.getState().directionalImpulse;
    const updatesBeforeBreak = updates;
    engine.state.pivotsHigh.push({ index: 69, timestamp: bar(69).timestamp, price: 100.4, type: 'High', isBroken: false });
    const candle = bar(70, { open: 100.1, high: 102, low: 100, close: 101.8 });
    const events = engine.nextCandle(candle);
    assert.ok(events.some((event: any) => event.type === 'EVENT_CHOCH'));
    const after = engine.getState().directionalImpulse;
    assert.equal(after.sampleCount, Math.min(before.sampleCount+1,50));
    assert.equal(updates, updatesBeforeBreak+1, 'structural reanchor advances exactly once even when the rolling window is full');
    assert.ok(after.upSmooth > before.upSmooth);
    assert.equal(after.timestamp, candle.timestamp);
    assert.equal(engine.getState().signalPolicy.profile, 'directional_atr_v1');
    const unchanged = serialize(engine);
    assert.deepEqual(engine.nextCandle(candle), []);
    assert.equal(serialize(engine), unchanged);
    assert.equal('zUp' in engine.getState(), false);
    assert.equal('zDn' in engine.getState(), false);
});

test('legacy getState keeps the original shape without directional diagnostics', () => {
    const engine = new SMCEngine(basePreset(), 'M5');
    engine.nextCandle(bar(0));
    assert.equal('directionalImpulse' in engine.getState(), false);
    assert.equal('signalPolicy' in engine.getState(), false);
});

test('effective preset getter returns derived gates and a deep defensive copy', () => {
    const engine: any = new SMCEngine(experimental({ signal_impulse: { window: 50 } }), 'H4');
    const effective = engine.getEffectivePreset();
    assert.equal(effective.choch_require_sweep, true);
    assert.equal(effective.choch_require_momentum, true);
    assert.equal(effective.valid_bos_displacement, true);
    effective.signal_impulse.window = 2;
    effective.choch_require_sweep = false;
    assert.equal(engine.getEffectivePreset().signal_impulse.window, 50);
    assert.equal(engine.getEffectivePreset().choch_require_sweep, true);
});

test('preset switches rebuild experimental memory and rebind the legacy calculator', () => {
    const engine: any = new SMCEngine(basePreset(), 'M5');
    const first = engine.zscore;
    engine.setPreset('Forex - 3. Balanceado');
    assert.notEqual(engine.zscore, first);
    assert.equal(engine.liquidity.zscore, engine.zscore);
    engine.setPreset(experimental());
    for (let i = 0; i < 70; i++) engine.nextCandle(bar(i));
    assert.equal(engine.getState().directionalImpulse.ready, true);
    const calculator = engine.impulse;
    engine.setPreset(experimental({ signal_impulse: { window: 3 } }));
    assert.notEqual(engine.impulse, calculator);
    assert.equal(engine.lastProcessedTs, undefined);
    assert.equal(engine.getState().directionalImpulse, null);
    assert.equal(engine.getState().atr, 0);
    assert.equal(engine.liquidity.zscore, engine.zscore);
    const before = serialize(engine);
    assert.throws(() => engine.setPreset(experimental({ signal_profile: 'typo' })));
    assert.equal(serialize(engine), before);
    engine.setPreset(basePreset());
    assert.equal(engine.impulse, null);
    assert.equal('directionalImpulse' in engine.getState(), false);
});

test('current accepted absorption can approve current CHoCH without an extra bar', () => {
    for (const sameBarSweeps of [true, false]) {
        const engine: any = new SMCEngine(experimental({ choch_require_sweep: true, choch_require_momentum: false, valid_bos_displacement: false, signal_ablation: { sameBarSweeps } }), 'M5');
        for (let i = 0; i < 70; i++) engine.nextCandle(bar(i));
        engine.structure.currentTrend = 'Bearish';
        engine.structure.trendExtreme = 90;
        engine.state.pivotsHigh.push({ index: 69, timestamp: bar(69).timestamp, price: 100.5, type: 'High', isBroken: false });
        engine.liquidity.dailyLow = 100;
        const candle = bar(70, { open: 100.8, high: 101.5, low: 99, close: 101 });
        const events = engine.nextCandle(candle);
        assert.equal(events.some((event: any) => event.type === 'EVENT_CHOCH'), sameBarSweeps);
        assert.equal(events.some((event: any) => event.type === 'EVENT_SWEEP'), sameBarSweeps);
        if (sameBarSweeps) {
            assert.equal(engine.getState().lastSweep.timestamp, candle.timestamp);
            assert.equal(engine.getState().lastSweep.availableAt, candle.timestamp + STEP);
            const choch = events.find((event: any) => event.type === 'EVENT_CHOCH');
            assert.equal(choch.availableAt, candle.timestamp + STEP);
        }
        assert.equal(engine.liquidity.barCount, 71);
    }
});

test('dual sweep flags are direction-aware, and expired sweeps cannot be rescued by ordering', () => {
    for (const expired of [false, true]) {
        const engine: any = new SMCEngine(experimental({ choch_require_sweep: true, choch_require_momentum: false, valid_bos_displacement: false }), 'M5');
        for (let i = 0; i < 70; i++) engine.nextCandle(bar(i));
        engine.structure.currentTrend = 'Bullish';
        engine.structure.trendExtreme = 110;
        engine.state.pivotsLow.push({ index: 69, timestamp: bar(69).timestamp, price: 99.8, type: 'Low', isBroken: false });
        engine.liquidity.lastSweepDirBar = { Bullish: engine.liquidity.barCount, Bearish: engine.liquidity.barCount - (expired ? 7 : 0) };
        const events = engine.nextCandle(bar(70, { open: 100, high: 100.2, low: 99, close: 99.2 }));
        const choch = events.find((event: any) => event.type === 'EVENT_CHOCH');
        assert.equal(Boolean(choch), !expired);
        if (choch) assert.equal(choch.direction, 'Bearish');
    }
});

test('legacy liquidity preserves omitted/null preset optional-access behavior', () => {
    for (const preset of [undefined, null]) {
        const liquidity = new LiquidityEngine(new ZScoreCalculator());
        liquidity.dailyLow = 100;
        const candle = bar(80, { open: 100.8, high: 101.5, low: 99, close: 101 });
        assert.deepEqual(liquidity.processCandle(candle, 1, preset, 3), []);
        const events = liquidity.processCandle(bar(81), 1, preset, 0);
        assert.equal(events.length, 1);
    }
});

test('absorption ablation keeps the legacy numeric Z comparison, including NaN rejection', () => {
    for (const z of [0, NaN, 3]) {
        const liquidity: any = new LiquidityEngine(new ZScoreCalculator());
        liquidity.dailyLow = 100;
        const candle = bar(80, { open: 100.8, high: 101.5, low: 99, close: 101 });
        const events = liquidity.processCandle(candle, 1, experimental({ signal_ablation: { sweepAbsorption: false } }), z);
        assert.equal(events.length, z === 3 ? 1 : 0);
    }
});

test('experimental dual sweeps, zero-range CRT buffer and cooldown advance exactly once', () => {
    const liquidity: any = new LiquidityEngine(new ZScoreCalculator());
    liquidity.dailyLow = 99.9; liquidity.dailyHigh = 100.1;
    const candle = bar(0, { open: 100, high: 101, low: 99, close: 100 });
    const snapshot = { timestamp: candle.timestamp, sampleCount: 50, ready: true, zUp: 1.2, zDn: 1.2, upSmooth: 1, dnSmooth: 1, atr: 1, atrNormalizedRange: 2, volumeRatio: 1, priorVolumeMean: 10 };
    const events = liquidity.processCandle(candle, 1, experimental({ min_sweep_wick_pct: .4 }), snapshot);
    assert.deepEqual(events.map((event: any) => event.direction), ['Bullish', 'Bearish']);
    assert.deepEqual(liquidity.getSweepDirections(), ['Bullish', 'Bearish']);
    assert.deepEqual(liquidity.getSweepDirections(false), []);
    const before = serialize(liquidity);
    assert.deepEqual(liquidity.processCandle(candle, 1, experimental(), snapshot), []);
    assert.equal(serialize(liquidity), before);
    for (let i = 1; i <= 8; i++) {
        liquidity.processCandle(bar(i, { open: 100, high: 100, low: 100, close: 100 }), 1, experimental(), null);
        assert.equal(liquidity.barCount, i + 1);
        assert.equal(liquidity.crtWindow.length, i + 1);
        assert.equal(liquidity.sweepBullActive, i < 8);
        assert.equal(liquidity.sweepBearActive, i < 8);
    }
    assert.deepEqual(liquidity.getSweepDirections(), []);
    const final = serialize(liquidity);
    assert.deepEqual(liquidity.processCandle(bar(9, { open: 105 }), 1, experimental(), null), []);
    assert.equal(serialize(liquidity), final);
});

const baselineRoot = process.env.SMC_BASELINE_ROOT ?? '/tmp/jarvis-smc-verification/before';
const archived = await import(pathToFileURL(path.join(baselineRoot, 'src/engine/smc/SMCEngine.ts')).href);
const BeforeEngine = archived.SMCEngine ?? archived.default.SMCEngine;
const archivedLiquidity = await import(pathToFileURL(path.join(baselineRoot, 'src/engine/smc/modules/liquidity.ts')).href);
const BeforeLiquidity = archivedLiquidity.LiquidityEngine ?? archivedLiquidity.default.LiquidityEngine;

test('legacy engine events/state equal PRE archive on synthetic and frozen real candles', () => {
    const fixturePath = process.env.SMC_REAL_FIXTURE ?? '/tmp/jarvis-smc-verification/C-real-candles.json';
    const real: OHLCV[] = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).map((row: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])));
    const synthetic: OHLCV[] = Array.from({ length: 700 }, (_, i) => {
        const center = 100 + Math.sin(i / 8) * 4 + Math.sin(i / 31);
        const open = center - Math.sin(i) * .3, close = center + Math.cos(i / 3) * .4;
        return bar(i, { open, close, high: Math.max(open, close) + .4 + (i % 5) * .1, low: Math.min(open, close) - .4 - (i % 7) * .05, volume: 5 + i % 30 });
    });
    let comparisons = 0, eventCount = 0;
    for (const candles of [synthetic, real]) for (const period of ['M5', 'H1']) for (const explicit of [false, true]) {
        const preset = { ...basePreset(), ...(explicit ? { signal_profile: 'legacy_v1' as const } : {}) };
        const current = new SMCEngine(preset, period), before = new BeforeEngine(preset, period);
        for (const [i, candle] of candles.entries()) {
            if (i === 200) { current.setPreset('Forex - 3. Balanceado'); before.setPreset('Forex - 3. Balanceado'); }
            const a = current.nextCandle({ ...candle }), b = before.nextCandle({ ...candle });
            assert.deepEqual(a, b, `events ${period} ${explicit} bar ${i}`);
            assert.deepEqual(current.getState(), before.getState(), `state ${period} ${explicit} bar ${i}`);
            comparisons++; eventCount += a.length;
        }
    }
    log(`LEGACY_ARCHIVE_PARITY ${JSON.stringify({ comparisons, eventCount, syntheticBars: synthetic.length, realBars: real.length, baselineRoot, fixturePath })}`);
});

test('legacy liquidity number flow and dual-direction sweeps equal PRE archive', () => {
    const current = new LiquidityEngine(new ZScoreCalculator());
    const before = new BeforeLiquidity(new ZScoreCalculator());
    current.dailyLow = before.dailyLow = 94;
    current.dailyHigh = before.dailyHigh = 96;
    const candle = bar(0, { open: 94.5, high: 110, low: 90, close: 95, volume: 1 });
    const a = current.processCandle(candle, 2, { min_sweep_wick_pct: .2 }, 3);
    const b = before.processCandle(candle, 2, { min_sweep_wick_pct: .2 }, 3);
    assert.deepEqual(a, b);
    assert.equal(current.sweepBullActive, true);
    assert.equal(current.sweepBearActive, true);
    const next = { ...candle, timestamp: candle.timestamp + STEP };
    const emitted = current.processCandle(next, 2, {}, 0);
    assert.deepEqual(emitted, before.processCandle(next, 2, {}, 0));
    assert.equal(emitted.length, 2);
    assert.equal('availableAt' in emitted[0], false);
});

log(`SMC integration: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
