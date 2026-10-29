import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// A missing helper is asserted as missing behaviour, not a loader error.
const core: any = await import('./rollover_eval_core.js').catch((error: any) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
});

test('raw cTrader prices use the protocol 100000 scale', () => {
    assert.equal(typeof core.decodeTrendbar, 'function');
    const bar = core.decodeTrendbar({ low: '111971', deltaHigh: '29', utcTimestampInMinutes: 29820000 });
    assert.equal(bar.low, 1.11971);
    assert.equal(bar.high, 1.12);
    assert.equal(bar.ts, 29820000 * 60000);
});

const iso = (time: string) => Date.parse(time);
const baseTrade = {
    id: 'fixture-trade', ctraderPositionId: '123', ticker: 'EURUSD', direction: 'BUY',
    mode: 'live', ctraderStatus: 'EXECUTED', result: 'WIN',
    timestamp: iso('2026-10-01T19:00:00Z'), closedAtISO: '2026-10-01T22:00:00Z',
    entryPrice: 1.13, initialSlPrice: 1.12, slPrice: 1.13, originalSlPrice: 1.13, rMultiple: 2,
};
const now = iso('2026-10-03T00:00:00Z');

test('a trade without a real close is excluded, not open until now', () => {
    assert.equal(typeof core.normalizeTrade, 'function');
    assert.equal(core.normalizeTrade({ ...baseTrade, closedAtISO: undefined }, now).reason, 'missing_or_invalid_close');
    assert.equal(core.normalizeTrade(baseTrade, now).trade.closedAt, iso(baseTrade.closedAtISO));
});

test('only initialSlPrice is trusted as the immutable original stop', () => {
    assert.equal(core.normalizeTrade({ ...baseTrade, initialSlPrice: undefined }, now).reason, 'missing_original_stop');
    assert.equal(core.normalizeTrade(baseTrade, now).trade.initialSlPrice, 1.12);
    assert.equal(core.normalizeTrade({ ...baseTrade, initialSlPrice: null }, now).reason, 'missing_original_stop');
});

test('invalid trade identity, direction and lifetime cannot enter the evaluation', () => {
    const cases = [
        [{ timestamp: undefined }, 'missing_or_invalid_open'],
        [{ closedAtISO: '2026-10-01T18:00:00Z' }, 'invalid_lifetime'],
        [{ closedAtISO: '2026-10-04T00:00:00Z' }, 'close_in_future'],
        [{ direction: 'UNKNOWN' }, 'invalid_direction'],
        [{ ctraderPositionId: undefined, id: undefined }, 'missing_identity'],
        [{ entryPrice: 1.11 }, 'invalid_original_stop'],
    ] as const;
    for (const [change, reason] of cases) assert.equal(core.normalizeTrade({ ...baseTrade, ...change }, now).reason, reason);
});

test('calendar windows include the final UTC date even when closure is earlier than entry hour', () => {
    assert.equal(typeof core.tradeWindows, 'function');
    const trade = core.normalizeTrade({ ...baseTrade, timestamp: iso('2026-10-01T23:00:00Z'), closedAtISO: '2026-10-02T22:00:00Z' }, now).trade;
    const getCalendar = (_ticker: string, at: number) => ({
        metadataAvailable: true, scheduleTimeZone: 'UTC',
        pauseStartMs: Math.floor(at / 86400000) * 86400000 + (21 * 60) * 60000,
        reopenMs: Math.floor(at / 86400000) * 86400000 + (21 * 60 + 30) * 60000,
        periodKey: `fixture:${Math.floor(at / 86400000)}`,
    });
    const windows = core.tradeWindows(trade, getCalendar).windows;
    assert.equal(windows.length, 1);
    assert.equal(windows[0].start, iso('2026-10-02T20:51:00Z'));
    assert.equal(windows[0].end, iso('2026-10-02T21:45:00Z'));
});

const fixtureCalendar = (_ticker: string, at: number) => ({
    metadataAvailable: true, scheduleTimeZone: 'UTC',
    pauseStartMs: Math.floor(at / 86400000) * 86400000 + 21 * 60 * 60000,
    reopenMs: Math.floor(at / 86400000) * 86400000 + (21 * 60 + 30) * 60000,
    periodKey: `fixture:${Math.floor(at / 86400000)}`,
});
const fixtureBars = [{ ts: iso('2026-10-01T21:00:00Z'), low: 1.11971, high: 1.121 }];

test('BUY stop traversal is descriptive evidence, never R saved or proof of rule A', () => {
    assert.equal(typeof core.evaluateRollover, 'function');
    const report = core.evaluateRollover({ trades: [baseTrade], evaluatedAt: now,
        getCalendar: fixtureCalendar, barsByTicker: { EURUSD: { bars: fixtureBars } } });
    assert.equal(report.global.nVentanas, 1);
    assert.equal(report.global.slTocado, 1);
    assert.equal(report.global.sobrevivio, 1);
    assert.equal(report.global.rSalvado, null);
    assert.equal(report.tickers[0].evidence[0].causalAttribution, 'not_established');
});

test('one non-crossing M5 bar in a 54-minute exposure leaves stop evidence unknown', () => {
    const report = core.evaluateRollover({ trades: [baseTrade], evaluatedAt: now,
        getCalendar: fixtureCalendar,
        barsByTicker: { EURUSD: { bars: [{ ...fixtureBars[0], low: 1.125, high: 1.13 }] } } });
    const evidence = report.tickers[0].evidence[0];
    assert.equal(evidence.touch, 'unknown');
    assert.equal(evidence.status, 'bid_bar_coverage_gaps');
    assert.equal(report.global.slIndeterminado, 1);
    assert.equal(report.global.slTocado, 0);
    assert.equal(report.global.rSalvado, null);
    assert.equal(evidence.coverage, 'partial');
    // A gap is absent trajectory, not a known number of missing feed bars:
    // the calendar contains a scheduled pause, and the exposure has M5 edges.
    assert.equal(evidence.barsMissing, null);
    assert.deepEqual(evidence.coverageGaps, [
        { start: iso('2026-10-01T20:51:00Z'), end: iso('2026-10-01T21:00:00Z') },
        { start: iso('2026-10-01T21:05:00Z'), end: iso('2026-10-01T21:45:00Z') },
    ]);
});

// Grid-aligned exposure 21:00–21:45 makes complete interval coverage possible.
const alignedCalendar = (ticker: string, at: number) => ({
    ...fixtureCalendar(ticker, at),
    pauseStartMs: fixtureCalendar(ticker, at).pauseStartMs + 9 * 60000,
});
const alignedBars = Array.from({ length: 9 }, (_, index) => ({
    ts: iso('2026-10-01T21:00:00Z') + index * core.M5_MS, low: 1.125, high: 1.13,
}));

test('full Bid M5 interval coverage permits only descriptive non-observation', () => {
    const report = core.evaluateRollover({ trades: [baseTrade], evaluatedAt: now,
        getCalendar: alignedCalendar, barsByTicker: { EURUSD: { bars: [...alignedBars].reverse() } } });
    const evidence = report.tickers[0].evidence[0];
    assert.equal(evidence.touch, 'not_observed');
    assert.equal(evidence.coverage, 'complete');
    assert.equal(evidence.barsMissing, 0);
    assert.deepEqual(evidence.coverageGaps, []);
    assert.equal(report.global.slIndeterminado, 0);
    assert.equal(report.global.rSalvado, null);
    assert.equal(evidence.causalAttribution, 'not_established');
    assert.equal(report.global.ruleAEvidence, 'not_established');
});

test('scheduled no-feed pause never substitutes for missing price trajectory', () => {
    const openSessionBars = alignedBars.filter((bar: any) => bar.ts < iso('2026-10-01T21:09:00Z') || bar.ts >= iso('2026-10-01T21:30:00Z'));
    const report = core.evaluateRollover({ trades: [baseTrade], evaluatedAt: now,
        getCalendar: alignedCalendar, barsByTicker: { EURUSD: { bars: openSessionBars } } });
    const evidence = report.tickers[0].evidence[0];
    assert.equal(evidence.touch, 'unknown');
    assert.equal(evidence.barsMissing, null);
    assert.equal(report.global.slIndeterminado, 1);
    assert.deepEqual(evidence.coverageGaps, [
        { start: iso('2026-10-01T21:10:00Z'), end: iso('2026-10-01T21:30:00Z') },
    ]);
});

test('duplicate intervals do not fill an interior coverage gap', () => {
    const duplicateBars = alignedBars.filter((_: any, index: number) => index !== 3);
    duplicateBars.push(duplicateBars[0]); // Nine records, still one absent interval.
    const report = core.evaluateRollover({ trades: [baseTrade], evaluatedAt: now,
        getCalendar: alignedCalendar, barsByTicker: { EURUSD: { bars: duplicateBars } } });
    const evidence = report.tickers[0].evidence[0];
    assert.equal(evidence.touch, 'unknown');
    assert.equal(evidence.coverage, 'partial');
    assert.deepEqual(evidence.coverageGaps, [
        { start: iso('2026-10-01T21:15:00Z'), end: iso('2026-10-01T21:20:00Z') },
    ]);
});

test('uncovered exposure edges remain unknown even with every contained M5 interval', () => {
    const report = core.evaluateRollover({ trades: [baseTrade], evaluatedAt: now,
        getCalendar: fixtureCalendar, barsByTicker: { EURUSD: { bars: [
            { ...alignedBars[0], ts: iso('2026-10-01T20:50:00Z') },
            { ...alignedBars[0], ts: iso('2026-10-01T20:55:00Z') }, ...alignedBars,
        ] } } });
    const evidence = report.tickers[0].evidence[0];
    assert.equal(evidence.touch, 'unknown');
    assert.deepEqual(evidence.coverageGaps, [
        { start: iso('2026-10-01T20:51:00Z'), end: iso('2026-10-01T20:55:00Z') },
    ]);
});

test('coverage ends at actual closure, never fills the rest of a partial close bar', () => {
    const report = core.evaluateRollover({ trades: [{ ...baseTrade, closedAtISO: '2026-10-01T21:13:00Z' }], evaluatedAt: now,
        getCalendar: alignedCalendar, barsByTicker: { EURUSD: { bars: alignedBars } } });
    const evidence = report.tickers[0].evidence[0];
    assert.equal(evidence.observedUntil, iso('2026-10-01T21:13:00Z'));
    assert.equal(evidence.touch, 'unknown');
    assert.equal(evidence.barCount, 2);
    assert.deepEqual(evidence.coverageGaps, [
        { start: iso('2026-10-01T21:10:00Z'), end: iso('2026-10-01T21:13:00Z') },
    ]);
    assert.equal(evidence.survivedWindow, false);
});

test('positive traversal despite gaps remains observed but proves no counterfactual', () => {
    const report = core.evaluateRollover({ trades: [baseTrade], evaluatedAt: now,
        getCalendar: fixtureCalendar, barsByTicker: { EURUSD: { bars: fixtureBars } } });
    const evidence = report.tickers[0].evidence[0];
    assert.equal(evidence.touch, 'observed');
    assert.equal(evidence.status, 'bid_bar_traversal_observed');
    assert.equal(evidence.coverage, 'partial');
    assert.equal(evidence.barsMissing, null);
    assert.equal(report.global.slIndeterminado, 0);
    assert.equal(report.global.rSalvado, null);
    assert.equal(evidence.causalAttribution, 'not_established');
});

test('SELL remains unknown even with complete Bid coverage', () => {
    const report = core.evaluateRollover({ trades: [{ ...baseTrade, direction: 'SELL', initialSlPrice: 1.14 }], evaluatedAt: now,
        getCalendar: alignedCalendar, barsByTicker: { EURUSD: { bars: alignedBars } } });
    const evidence = report.tickers[0].evidence[0];
    assert.equal(evidence.coverage, 'complete'); // Bid only, not Ask evidence.
    assert.equal(evidence.touch, 'unknown');
    assert.equal(evidence.status, 'ask_unavailable');
    assert.equal(report.global.slIndeterminado, 1);
    assert.equal(report.global.slTocado, 0);
    assert.equal(report.global.rSalvado, null);
});

test('invalid OHLC intervals cannot certify coverage or fabricate traversal', () => {
    for (const invalid of [
        { low: NaN }, { low: 0 }, { low: -1 }, { low: Infinity },
        { high: NaN }, { high: Infinity }, { high: 1.12 },
    ]) {
        const report = core.evaluateRollover({ trades: [baseTrade], evaluatedAt: now,
            getCalendar: alignedCalendar, barsByTicker: { EURUSD: { bars: alignedBars.map((bar: any, index: number) =>
                index === 3 ? { ...bar, ...invalid } : bar) } } });
        assert.equal(report.tickers[0].evidence[0].touch, 'unknown');
        assert.equal(report.tickers[0].evidence[0].coverage, 'partial');
        assert.equal(report.global.slTocado, 0);
        assert.equal(report.global.slIndeterminado, 1);
    }
});

test('duplicate journal records cannot multiply position-window results', () => {
    const report = core.evaluateRollover({ trades: [baseTrade, { ...baseTrade, id: 'duplicate' }], evaluatedAt: now,
        getCalendar: fixtureCalendar, barsByTicker: { EURUSD: { bars: fixtureBars } } });
    assert.equal(report.global.nVentanas, 1);
    assert.equal(report.global.slTocado, 1);
    assert.equal(report.global.excluded.duplicate_position_window, 1);
    assert.equal(report.global.rSalvado, null);
});

test('SELL without Ask stays indeterminate even if Bid crosses its stop', () => {
    const report = core.evaluateRollover({ trades: [{ ...baseTrade, direction: 'SELL', initialSlPrice: 1.14 }], evaluatedAt: now,
        getCalendar: fixtureCalendar, barsByTicker: { EURUSD: { bars: [{ ...fixtureBars[0], high: 1.15 }] } } });
    assert.equal(report.global.slIndeterminado, 1);
    assert.equal(report.global.slTocado, 0);
    assert.equal(report.tickers[0].evidence[0].status, 'ask_unavailable');
});

test('missing or failed bar coverage remains unknown rather than a safe stop', () => {
    for (const data of [{ bars: [] }, { bars: fixtureBars, error: 'broker_request_failed' }]) {
        const report = core.evaluateRollover({ trades: [baseTrade], evaluatedAt: now,
            getCalendar: fixtureCalendar, barsByTicker: { EURUSD: data } });
        assert.equal(report.global.slIndeterminado, 1);
        assert.equal(report.global.slTocado, 0);
        assert.equal(report.tickers[0].evidence[0].touch, 'unknown');
        assert.equal(report.tickers[0].evidence[0].coverage, 'unavailable');
        assert.equal(report.tickers[0].evidence[0].barsMissing, null);
        assert.deepEqual(report.tickers[0].evidence[0].coverageGaps, [
            { start: iso('2026-10-01T20:51:00Z'), end: iso('2026-10-01T21:45:00Z') },
        ]);
    }
});

test('partial M5 bars at close or window end cannot establish traversal or survival', () => {
    const report = core.evaluateRollover({ trades: [{ ...baseTrade, closedAtISO: '2026-10-01T21:03:00Z' }], evaluatedAt: now,
        getCalendar: fixtureCalendar, barsByTicker: { EURUSD: { bars: fixtureBars } } });
    assert.equal(report.global.slTocado, 0);
    assert.equal(report.global.sobrevivio, 0);
    assert.equal(report.tickers[0].evidence[0].survivedWindow, false);
    assert.equal(report.tickers[0].evidence[0].barCount, 0);
    const ending = core.evaluateRollover({ trades: [baseTrade], evaluatedAt: now,
        getCalendar: fixtureCalendar, barsByTicker: { EURUSD: { bars: [{ ...fixtureBars[0], ts: iso('2026-10-01T21:45:00Z') }] } } });
    assert.equal(ending.global.slTocado, 0);
});

test('blocked entries preserve legacy dBlocked but are explicitly rule C', () => {
    const report = core.evaluateRollover({ trades: [], evaluatedAt: now, getCalendar: fixtureCalendar,
        barsByTicker: {}, blockedByTicker: { EURUSD: 2, XAUUSD: 1 } });
    assert.equal(report.global.dBlocked, 3);
    assert.equal(report.global.blockedRule, 'C');
    assert.equal(report.tickers.length, 2);
});

test('malformed raw bars cannot fabricate a zero-price stop crossing', () => {
    for (const raw of [
        { utcTimestampInMinutes: 29820000, low: null, deltaHigh: 0 },
        { utcTimestampInMinutes: 29820000, low: 'bad', deltaHigh: 0 },
        { utcTimestampInMinutes: 29820000, low: 111971, deltaHigh: -1 },
        { low: 111971, deltaHigh: 0 },
    ]) assert.equal(core.decodeTrendbar(raw), null);
    assert.equal(core.decodeTrendbar({ utcTimestampInMinutes: 29820000, low: 111971 }).high, 1.11971);
});

test('evaluator import is side-effect-free and publishing requires an explicit flag', async () => {
    const source = fs.readFileSync(new URL('./rollover_eval.ts', import.meta.url), 'utf8');
    // Do not import the legacy script: it would initialize Firestore and run main.
    assert.match(source, /export function parseCliOptions/);
    const evaluator = await import('./rollover_eval.js');
    assert.deepEqual(evaluator.parseCliOptions([]), { publish: false });
    assert.deepEqual(evaluator.parseCliOptions(['--dry-run']), { publish: false });
    assert.deepEqual(evaluator.parseCliOptions(['--publish']), { publish: true });
    assert.throws(() => evaluator.parseCliOptions(['--publish', '--dry-run']));
    assert.throws(() => evaluator.parseCliOptions(['--publish', '--fixture', '/tmp/test.json']));
    assert.throws(() => evaluator.parseCliOptions(['--typo']));
});

for (const { name, env, expected } of [
    { name: 'defaults to demo', env: {}, expected: 'demo' },
    { name: 'empty CTRADER_DEMO defaults to demo', env: { CTRADER_DEMO: '' }, expected: 'demo' },
    { name: 'true selects demo', env: { CTRADER_DEMO: 'true' }, expected: 'demo' },
    { name: 'true is case-insensitive', env: { CTRADER_DEMO: 'TrUe' }, expected: 'demo' },
    { name: 'false selects live without CTRADER_ENVIRONMENT', env: { CTRADER_DEMO: 'false' }, expected: 'live' },
    { name: 'false is case-insensitive', env: { CTRADER_DEMO: 'FALSE' }, expected: 'live' },
    { name: 'demo ignores contradictory live environment', env: { CTRADER_DEMO: 'true', CTRADER_ENVIRONMENT: 'live' }, expected: 'demo' },
    { name: 'live ignores contradictory demo environment', env: { CTRADER_DEMO: 'false', CTRADER_ENVIRONMENT: 'demo' }, expected: 'live' },
    { name: 'default ignores legacy live environment', env: { CTRADER_ENVIRONMENT: 'live' }, expected: 'demo' },
    { name: 'other nonempty values select live like the bot', env: { CTRADER_DEMO: '1' }, expected: 'live' },
    { name: 'values are not trimmed like the bot', env: { CTRADER_DEMO: ' true ' }, expected: 'live' },
]) {
    test(`broker environment ${name}`, async () => {
        const evaluator: any = await import('./rollover_eval.js');
        assert.equal(typeof evaluator.resolveBrokerEnvironment, 'function');
        assert.equal(evaluator.resolveBrokerEnvironment(env), expected);
    });
}

test('calendar traversal does not silently omit earlier intraday pauses', () => {
    const trade = core.normalizeTrade(baseTrade, now).trade;
    trade.openedAt = iso('2026-10-01T08:00:00Z');
    const getCalendar = (_ticker: string, at: number) => {
        const day = Math.floor(at / 86400000) * 86400000;
        const pauses = [12, 21].map(hour => day + hour * 3600000).filter(start => start - 9 * 60000 <= at);
        const start = pauses.at(-1) ?? null;
        return { metadataAvailable: true, scheduleTimeZone: 'UTC', pauseStartMs: start,
            reopenMs: start === null ? null : start + 30 * 60000, periodKey: start === null ? null : `fixture:${start}` };
    };
    assert.equal(core.tradeWindows(trade, getCalendar).windows.length, 2);
});

test('broker collection disconnects even when symbol discovery fails, marking coverage unknown', async () => {
    const evaluator: any = await import('./rollover_eval.js');
    assert.equal(typeof evaluator.collectBrokerEvidence, 'function');
    let disconnected = false;
    const ct = { getSymbols: async () => { throw new Error('fixture discovery failure'); },
        disconnect: async () => { disconnected = true; } };
    const bars = await evaluator.collectBrokerEvidence(ct, [core.normalizeTrade(baseTrade, now).trade], now, 5);
    assert.equal(disconnected, true);
    assert.equal(bars.EURUSD.error, 'broker_discovery_failed');
    assert.deepEqual(bars.EURUSD.bars, []);
});

const fixtureSchedule = {
    scheduleTimeZone: 'America/New_York',
    schedule: Array.from({ length: 5 }, (_, i) => ({ startSecond: 61205 + i * 86400, endSecond: 145795 + i * 86400 })),
};

test('broker M5 collection pages UTC days and subdivides explicit truncation', async () => {
    const evaluator = await import('./rollover_eval.js');
    const calls: any[] = [];
    let disconnected = false;
    const barTime = iso('2026-10-01T21:00:00Z');
    const raw = { utcTimestampInMinutes: barTime / 60000, low: 111971, deltaHigh: 29 };
    const ct = {
        getSymbols: async () => [{ symbolId: 1, symbolName: 'EURUSD' }],
        getSymbolDetails: async () => [fixtureSchedule],
        raw: { market: { getTrendbars: async (request: any) => {
            calls.push(request);
            if (calls.length === 1) return { trendbars: [raw], hasMore: true };
            return { trendbars: barTime >= request.fromTimestamp && barTime <= request.toTimestamp ? [raw] : [], hasMore: false };
        } } }, disconnect: async () => { disconnected = true; },
    };
    const data = await evaluator.collectBrokerEvidence(ct, [core.normalizeTrade(baseTrade, now).trade], now, 5);
    assert.equal(data.EURUSD.error, undefined);
    assert.equal(data.EURUSD.bars.length, 1);
    assert.equal(data.EURUSD.bars[0].low, 1.11971);
    assert.ok(calls.length >= 3);
    assert.ok(calls.every(c => c.toTimestamp - c.fromTimestamp < 86400000));
    assert.equal(disconnected, true);
});

test('publication defaults to no writes and verifies the entire exact document in explicit mode', async () => {
    const evaluator: any = await import('./rollover_eval.js');
    assert.equal(typeof evaluator.publishEvaluation, 'function');
    await evaluator.publishEvaluation({ collection: () => { throw new Error('unexpected write'); } }, []);
    let writes = 0;
    let stored: any;
    const document = { ticker: 'EURUSD', nVentanas: 1, slTocado: 1, sobrevivio: 0, rSalvado: null, evaluatedAt: now };
    const db = { collection: (name: string) => {
        assert.equal(name, 'rollover_evals');
        return { doc: (id: string) => {
            assert.equal(id, 'EURUSD');
            return { set: async (value: any, options: any) => { assert.deepEqual(options, { merge: false }); stored = { ...value }; writes++; },
                get: async () => ({ data: () => stored }) };
        } };
    } };
    assert.equal(await evaluator.publishEvaluation(db, [document], false), false);
    assert.equal(writes, 0);
    assert.equal(await evaluator.publishEvaluation(db, [document], true), true);
    assert.equal(writes, 1);
    const corrupted = { collection: () => ({ doc: () => ({ set: async () => {}, get: async () => ({ data: () => ({ ...document, sobrevivio: 99 }) }) }) }) };
    await assert.rejects(evaluator.publishEvaluation(corrupted, [document], true), /verification/i);
});

test('actual shared calendar handles DST and excludes unverified fallback metadata', async () => {
    const { getRolloverCalendar, registerRolloverSchedule } = await import('../src/engine/RolloverSpreadGate.js');
    registerRolloverSchedule('EURUSD', fixtureSchedule);
    for (const [date, expected] of [['2026-10-29', '20:20:55'], ['2026-11-05', '21:20:55']]) {
        const trade = core.normalizeTrade({ ...baseTrade, timestamp: iso(`${date}T18:00:00Z`), closedAtISO: `${date}T23:00:00Z` }, iso('2026-11-06T00:00:00Z')).trade;
        const windows = core.tradeWindows(trade, getRolloverCalendar).windows;
        assert.equal(windows.length, 1);
        assert.equal(windows[0].start, iso(`${date}T${expected}Z`));
    }
    registerRolloverSchedule('EURUSD', { scheduleTimeZone: '', schedule: [] });
    assert.equal(core.tradeWindows(core.normalizeTrade(baseTrade, now).trade, getRolloverCalendar).reason, 'calendar_unresolved');
});

test('ISO closure inside a window cannot be counted as survival even after an observed traversal', () => {
    const report = core.evaluateRollover({ trades: [{ ...baseTrade, closedAtISO: '2026-10-01T21:10:00Z' }], evaluatedAt: now,
        getCalendar: fixtureCalendar, barsByTicker: { EURUSD: { bars: fixtureBars } } });
    assert.equal(report.global.slTocado, 1);
    assert.equal(report.global.sobrevivio, 0);
    assert.equal(report.global.rSalvado, null);
});

test('offline CLI dry-run executes a labelled fixture without Firestore or broker access', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rollover-eval-test-'));
    const fixtureFile = path.join(directory, 'fixture.json');
    const fixture = { kind: 'rollover_eval_test_fixture', evaluatedAt: now,
        trades: [baseTrade, { ...baseTrade, id: 'duplicate' }, { ...baseTrade, ctraderPositionId: 'missing-stop', initialSlPrice: undefined },
            { ...baseTrade, ctraderPositionId: 'missing-close', closedAtISO: undefined },
            { ...baseTrade, ctraderPositionId: 'sell', direction: 'SELL', initialSlPrice: 1.14 }],
        symbols: { EURUSD: fixtureSchedule }, rawBarsByTicker: { EURUSD: [{ low: 111971, deltaHigh: 29,
            utcTimestampInMinutes: iso('2026-10-01T21:00:00Z') / 60000 }] }, blockedByTicker: { EURUSD: 2 } };
    try {
        fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
        for (const flags of [['--dry-run'], []]) {
            const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rollover_eval.ts', ...flags, '--fixture', fixtureFile], {
                cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 15000,
                env: { PATH: process.env.PATH, HOME: directory } });
            assert.equal(child.status, 0, child.stderr);
            const output = JSON.parse(child.stdout);
            assert.equal(output.mode, 'dry-run');
            assert.equal(output.source, 'test_fixture_not_history');
            assert.equal(output.published, false);
            assert.equal(output.global.nVentanas, 2);
            assert.equal(output.global.slTocado, 1);
            assert.equal(output.global.slIndeterminado, 1);
            assert.equal(output.global.rSalvado, null);
            assert.equal(output.global.dBlocked, 2);
            assert.equal(output.global.excluded.missing_original_stop, 1);
            assert.equal(output.global.excluded.missing_or_invalid_close, 1);
            assert.equal(output.tickers[0].evidence[0].coverage, 'partial');
            assert.equal(output.tickers[0].evidence[0].barsMissing, null);
            assert.ok(output.tickers[0].evidence[0].coverageGaps.length > 0);
        }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('out-of-range timestamps are rejected before date iteration', () => {
    assert.equal(core.parseTimestamp(1e200), null);
    assert.equal(core.parseTimestamp({ seconds: 1e20 }), null);
    assert.equal(core.normalizeTrade({ ...baseTrade, timestamp: 1e200 }, now).reason, 'missing_or_invalid_open');
});

test('broker discovery errors retain their exclusion reason when the calendar is unresolved', () => {
    const report = core.evaluateRollover({ trades: [baseTrade], evaluatedAt: now,
        getCalendar: () => ({ metadataAvailable: false, scheduleTimeZone: null, pauseStartMs: null, reopenMs: null, periodKey: null }),
        barsByTicker: { EURUSD: { bars: [], error: 'broker_discovery_failed' } } });
    assert.equal(report.global.excluded.broker_discovery_failed, 1);
    assert.equal(report.global.nVentanas, 0);
    assert.equal(report.global.rSalvado, null);
});

test('timestamps normalize ISO and Firestore values without manufacturing a close', () => {
    assert.equal(typeof core.parseTimestamp, 'function');
    const expected = Date.parse('2026-10-01T21:06:00Z');
    assert.equal(core.parseTimestamp('2026-10-01T21:06:00Z'), expected);
    assert.equal(core.parseTimestamp({ seconds: expected / 1000, nanoseconds: 0 }), expected);
    assert.equal(core.parseTimestamp({ toMillis: () => expected }), expected);
    assert.equal(core.parseTimestamp(undefined), null);
    assert.equal(core.parseTimestamp(null), null);
    assert.equal(core.parseTimestamp('2026-10-01T21:06:00'), null);
});
