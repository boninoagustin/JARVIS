import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { tickFlow } from '../src/engine/TickFlow.js';
import { isRolloverBaselineWindow, isSpreadNormalized, registerRolloverSchedule } from '../src/engine/RolloverSpreadGate.js';

// Module-only tests: no listener, broker, network, or wall-clock fixtures.
const OFF_ROLLOVER = Date.parse('2026-10-14T15:00:00.000Z');
const BID = 1.1;
const NORMAL = 0.0001;
const WIDE = 0.0019;

function feed(ticker: string, start: number, count: number, spread = NORMAL, step = 1): number {
    // These synthetic fixtures deliberately define NORMAL as 1 pip rather than
    // the live raw-FX default (0.1 pip). Supply that independent fixture config;
    // never derive the bootstrap reference from `spread` (which may be WIDE).
    tickFlow.configureBootstrapSpread(ticker, { baseSpreadPrice: NORMAL, pipSize: 0.0001 });
    assert.equal(registerRolloverSchedule(ticker, {
        scheduleTimeZone: 'America/New_York',
        schedule: Array.from({ length: 5 }, (_, i) => ({
            startSecond: 61205 + i * 86400,
            endSecond: 145795 + i * 86400,
        })),
    }), true);
    for (let i = 0; i < count; i++) {
        tickFlow.onTick(ticker, start + i * step, BID, BID + spread);
    }
    return start + (count - 1) * step;
}

function near(actual: number | null, expected: number, message?: string): void {
    assert.notEqual(actual, null, message);
    assert.ok(Math.abs(actual! - expected) < 1e-10, message ?? `${actual} != ${expected}`);
}

test('rollover-only asset classes cover every broker index alias and non-gold metal or energy', async () => {
    assert.ok(fs.existsSync(new URL('../src/engine/RolloverSpreadReference.ts', import.meta.url)),
        'pure rollover spread reference module is missing');
    const { getRolloverAssetClass } = await import('../src/engine/RolloverSpreadReference.js');
    const text = fs.readFileSync(new URL('../src/services/ctrader.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('ctrader.ts', text, ts.ScriptTarget.Latest, true);
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'mapToCTraderSymbol');
    assert.ok(node, 'broker alias mapping missing');
    // Evaluate only the pure declaration: never import the live broker service.
    const map = vm.runInNewContext(ts.transpileModule(node!.getText(ast), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText + '\nmapToCTraderSymbol', { console: { warn() {} } });
    for (const ticker of ['GER40', 'DE40', 'JP225', 'NIKKEI225', 'JAPAN225', 'NIKKEI', 'US100', 'NAS100',
        'US30', 'DOW30', 'US500', 'SPX500', 'USTECH100', 'FRA40', 'UK100', 'SPAIN35', 'NL25', 'ITALY40',
        'EUROPE50', 'AUSTRALIA200']) {
        for (const alias of [ticker, map(ticker), ticker.toLowerCase(), ticker + '.cash']) {
            assert.equal(getRolloverAssetClass(alias), 'INDICES', alias);
        }
    }
    for (const ticker of ['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD', 'GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM']) {
        assert.equal(getRolloverAssetClass(ticker), 'METALS', ticker);
    }
    for (const ticker of ['USOIL', 'UKOIL', 'XTIUSD', 'XBRUSD', 'WTI', 'BRENT', 'NATGAS', 'NAT.GAS']) {
        assert.equal(getRolloverAssetClass(ticker), 'ENERGY', ticker);
        assert.equal(getRolloverAssetClass(map(ticker)), 'ENERGY', map(ticker));
    }
    for (const ticker of ['EURUSD', 'USDJPY']) assert.equal(getRolloverAssetClass(ticker), 'FOREX');
    for (const ticker of ['BTCUSD', 'ETHUSD']) assert.equal(getRolloverAssetClass(ticker), 'CRYPTO');
});

test('rollover spread references preserve independent price-unit pip and class-default conventions', async () => {
    const api = await import('../src/engine/RolloverSpreadReference.js');
    assert.equal(typeof api.getRolloverSpreadReference, 'function', 'price-unit rollover reference API is missing');
    for (const [ticker, price, pip, basePips] of [
        ['EURUSD', 1.1, 0.0001, 0.1], ['USDJPY', 150, 0.01, 0.1], ['usdJPY.cash', 150, 0.01, 0.1],
        ['JP225', 40000, 1, 1], ['JAPAN 225', 40000, 1, 1], ['US TECH 100', 20000, 1, 1],
        ['NETHERLANDS 25', 900, 1, 1], ['EUROPE50', 5000, 1, 1],
        ['XAUUSD', 2500, 0.1, 1], ['XAGUSD', 30, 0.1, 1], ['XPTUSD', 1000, 0.1, 1], ['XPDUSD', 1000, 0.1, 1],
        ['USOIL', 70, 0.01, 3], ['XTIUSD', 70, 0.01, 3], ['XBRUSD', 75, 0.01, 3], ['NAT.GAS', 3, 0.01, 3],
        ['BTCUSD', 60000, 6, 2], ['ETHUSD', 3000, 0.3, 2],
    ] as const) {
        const reference = api.getRolloverSpreadReference(ticker, price);
        near(reference.pipSize, pip, ticker);
        near(reference.baseSpreadPrice, Math.max(pip * basePips, reference.cleanBaseline ?? 0), ticker);
    }
    const reference = api.getRolloverSpreadReference('EURUSD', 1.1);
    reference.baseSpreadPrice = 1;
    near(api.getRolloverSpreadReference('EURUSD', 1.1).baseSpreadPrice, 0.00001, 'references must be independent snapshots');
    assert.equal(api.getRolloverSpreadReference('BTCUSD', 30000).pipSize, 3, 'crypto proxy must follow price, not spread');
});

test('independent calibration is resolved through broker aliases without inventing missing baselines', () => {
    const text = fs.readFileSync(new URL('../src/engine/RolloverSpreadReference.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('RolloverSpreadReference.ts', text, ts.ScriptTarget.Latest, true);
    const declarations = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(ast)).join('\n');
    const code = ts.transpileModule(declarations, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText;
    const calibration = { JP225: { cleanBaseline: 3 }, USOIL: { cleanBaseline: 0.04 }, XPTUSD: { cleanBaseline: 9.22 },
        AUDNZD: { cleanBaseline: 0.0002 }, NL25: { cleanBaseline: 0.62 } };
    // Inject test-only references into the real pure module; do not fill production calibration here.
    const api = vm.runInNewContext(code + '\nexports', { exports: {}, rolloverSpreadCalibration: calibration });
    for (const [ticker, expected] of [
        ['JP225', 3], ['JAPAN 225', 3], ['nikkei225.cash', 3], ['XTIUSD', 0.04], ['USOIL.cash', 0.04],
        ['XPTUSD', 9.22], ['PLATINUM', 9.22], ['audnzd.cash', 0.0002], ['NETHERLANDS 25', 0.62],
    ] as const) assert.equal(api.getRolloverSpreadReference(ticker, 100).cleanBaseline, expected, ticker);
    assert.equal(api.getRolloverSpreadReference('EURUSD', 1.1).cleanBaseline, undefined, 'unmeasured symbols must not borrow a baseline');
    assert.equal(api.getRolloverSpreadReference('XAUEUR', 2000).cleanBaseline, undefined, 'do not reuse a USD-denominated metal reference');
});

test('measured JP225 S_base recovers normal 3 points after 100 unusually tight 1-point quotes', async () => {
    const { getRolloverSpreadReference } = await import('../src/engine/RolloverSpreadReference.js');
    const ticker = 'JP225-MEASURED-RECOVERY', bid = 40000;
    const reference = getRolloverSpreadReference(ticker, bid);
    registerRolloverSchedule(ticker, { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }] });
    tickFlow.configureBootstrapSpread(ticker, reference);
    for (let i = 0; i < 100; i++) tickFlow.onTick(ticker, OFF_ROLLOVER + i, bid, bid + 1);
    for (let i = 100; i < 500; i++) tickFlow.onTick(ticker, OFF_ROLLOVER + i, bid, bid + 3);
    const snapshot = tickFlow.getSpreadSnapshot(ticker, OFF_ROLLOVER + 499)!;
    assert.equal(isSpreadNormalized(snapshot, OFF_ROLLOVER + 499, reference.baseSpreadPrice, reference.pipSize), true, 'independently measured normal spread permanently locked out by tight warmup');
    assert.equal(snapshot.samples, 500); near(snapshot.baselineSpread, 3 - 2 * 0.95 ** 400);
    assert.equal(reference.baseSpreadPrice, 3, 'S_base uses measured reference, not learned EWMA');
});

test('measured FX S_base keeps sustained 19 pip spread blocked without baseline contamination', async () => {
    const { getRolloverSpreadReference } = await import('../src/engine/RolloverSpreadReference.js');
    const ticker = 'EURUSD-MEASURED-WIDE', reference = getRolloverSpreadReference(ticker, BID);
    registerRolloverSchedule(ticker, { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }] });
    tickFlow.configureBootstrapSpread(ticker, reference);
    for (let i = 0; i < 100; i++) tickFlow.onTick(ticker, OFF_ROLLOVER + i, BID, BID + 0.00001);
    const baseline = tickFlow.getStructuralSpread(ticker)!;
    for (let i = 100; i < 500; i++) tickFlow.onTick(ticker, OFF_ROLLOVER + i, BID, BID + WIDE);
    const snapshot = tickFlow.getSpreadSnapshot(ticker, OFF_ROLLOVER + 499)!;
    assert.equal(isSpreadNormalized(snapshot, OFF_ROLLOVER + 499, reference.baseSpreadPrice, reference.pipSize), false);
    assert.equal(snapshot.samples, 100); near(snapshot.baselineSpread, baseline);
});

test('invalid measured calibration cannot enlarge S_base or become bootstrap evidence', () => {
    const text = fs.readFileSync(new URL('../src/engine/RolloverSpreadReference.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('reference.ts', text, ts.ScriptTarget.Latest, true);
    const declarations = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(ast)).join('\n');
    const code = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    for (const cleanBaseline of [0, -1, Infinity, NaN, '3', null]) {
        const api = vm.runInNewContext(code + '\nexports', { exports: {}, rolloverSpreadCalibration: { JP225: { cleanBaseline } } });
        const reference = api.getRolloverSpreadReference('JP225', 40000);
        assert.equal(reference.baseSpreadPrice, 1); assert.equal(reference.cleanBaseline, undefined);
    }
});

test('USDJPY actual broker schedule permits clean learning at 13 UTC and the stored live probe time', () => {
    const ticker = 'USDJPY-TICKFLOW-BROKER-CALENDAR';
    registerRolloverSchedule(ticker, { scheduleTimeZone: 'America/New_York', schedule: [
        { startSecond: 61205, endSecond: 145795 }, { startSecond: 147605, endSecond: 232195 },
        { startSecond: 234005, endSecond: 318595 }, { startSecond: 320405, endSecond: 404995 },
        { startSecond: 406805, endSecond: 491395 },
    ] });
    tickFlow.configureBootstrapSpread(ticker, { baseSpreadPrice: 0.001, pipSize: 0.01 });
    for (const timestamp of ['2026-10-13T13:00:00Z', '2026-10-14T14:22:17.200Z']) {
        const start = Date.parse(timestamp);
        assert.equal(isRolloverBaselineWindow(ticker, start), false, 'real USDJPY calendar wrongly imposed an embargo');
        for (let i = 0; i < 100; i++) tickFlow.onTick(ticker, start + i, 158.392, 158.394);
    }
    const last = Date.parse('2026-10-14T14:22:17.200Z') + 99;
    assert.equal(tickFlow.getSpreadSnapshot(ticker, last)!.samples, 200);
    near(tickFlow.getStructuralSpread(ticker), 0.002);
});

test('calibrated bootstrap still requires 100 fresh unpaused quotes and cannot enlarge the mature gate floor', () => {
    const ticker = 'EURUSD-TICKFLOW-CALIBRATED-BOOTSTRAP';
    registerRolloverSchedule(ticker, { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }] });
    const config = { baseSpreadPrice: 0.00001, pipSize: 0.0001, cleanBaseline: 0.0002 };
    tickFlow.configureBootstrapSpread(ticker, config);
    for (let i = 0; i < 99; i++) tickFlow.onTick(ticker, OFF_ROLLOVER + i, BID, BID + 0.00008);
    const warming = tickFlow.getSpreadSnapshot(ticker, OFF_ROLLOVER + 98)!;
    assert.equal(warming.baselineSpread, null);
    assert.equal(isSpreadNormalized(warming, OFF_ROLLOVER + 98, config.baseSpreadPrice, config.pipSize), false);
    tickFlow.onTick(ticker, OFF_ROLLOVER + 99, BID, BID + 0.00008);
    const baseline = tickFlow.getStructuralSpread(ticker)!;
    for (let i = 100; i < 500; i++) tickFlow.onTick(ticker, OFF_ROLLOVER + i, BID, BID + 0.000216);
    const wide = tickFlow.getSpreadSnapshot(ticker, OFF_ROLLOVER + 499)!;
    assert.equal(wide.samples, 100, 'bootstrap calibration must not relax the mature normalization gate');
    near(wide.baselineSpread, baseline);
    tickFlow.onTick(ticker, OFF_ROLLOVER + 500, BID, BID + 0.00008, { quoteTs: OFF_ROLLOVER + 500 - 10_001 });
    assert.equal(tickFlow.getSpreadSnapshot(ticker, OFF_ROLLOVER + 500), null);
    near(tickFlow.getStructuralSpread(ticker), baseline);
});

test('400 consecutive 19-pip ticks cannot train away an established clean baseline', () => {
    const ticker = 'EURUSD-TICKFLOW-PERSISTENT';
    const cleanEnd = feed(ticker, OFF_ROLLOVER, 200);
    const baseline = tickFlow.getStructuralSpread(ticker);
    near(baseline, NORMAL);
    const wideEnd = feed(ticker, cleanEnd + 1, 400, WIDE);
    near(tickFlow.getStructuralSpread(ticker), baseline!, 'wide ticks contaminated the structural baseline');
    const wide = tickFlow.getSpreadSnapshot(ticker, wideEnd)!;
    assert.equal(wide.samples, 200, 'outliers counted as clean history');
    near(wide.spread, WIDE);
    assert.equal(isSpreadNormalized(wide, wideEnd, NORMAL, 0.0001), false);
});

test('a sustained 2.16-pip episode cannot normalize itself against a clean 0.8-pip baseline', () => {
    const ticker = 'EURUSD-TICKFLOW-MODERATE-CONTAMINATION';
    registerRolloverSchedule(ticker, { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }] });
    const config = { baseSpreadPrice: 0.1 * 0.0001, pipSize: 0.0001 };
    tickFlow.configureBootstrapSpread(ticker, config);
    for (let i = 0; i < 100; i++) tickFlow.onTick(ticker, OFF_ROLLOVER + i, BID, BID + 0.8 * 0.0001);
    const baseline = tickFlow.getStructuralSpread(ticker)!;
    near(baseline, 0.8 * 0.0001);
    const last = OFF_ROLLOVER + 499;
    for (let i = 100; i < 500; i++) tickFlow.onTick(ticker, OFF_ROLLOVER + i, BID, BID + 2.16 * 0.0001);
    const snapshot = tickFlow.getSpreadSnapshot(ticker, last)!;
    assert.equal(isSpreadNormalized(snapshot, last, config.baseSpreadPrice, config.pipSize), false,
        'a gate-rejected spread trained away its own anomaly');
    assert.equal(snapshot.samples, 100);
    near(snapshot.baselineSpread, baseline);
    tickFlow.onTick(ticker, last + 1, BID, BID + 0.8 * 0.0001);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, last + 1)!.samples, 101);
    near(tickFlow.getStructuralSpread(ticker), baseline);
});

test('learning also accepts the gate-independent base-plus-0.8-pip floor after warmup', () => {
    const ticker = 'EURUSD-TICKFLOW-INDEPENDENT-FLOOR';
    registerRolloverSchedule(ticker, { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }] });
    const config = { baseSpreadPrice: NORMAL, pipSize: 0.0001 };
    tickFlow.configureBootstrapSpread(ticker, config);
    for (let i = 0; i < 100; i++) tickFlow.onTick(ticker, OFF_ROLLOVER + i, BID, BID + 0.2 * NORMAL);
    const previous = tickFlow.getStructuralSpread(ticker)!;
    const ts = OFF_ROLLOVER + 100;
    const spread = 0.9 * NORMAL;
    assert.equal(isSpreadNormalized({ bid: BID, ask: BID + spread, ts, ageMs: 0, samples: 100,
        baselineSpread: previous, spread }, ts, config.baseSpreadPrice, config.pipSize), true);
    tickFlow.onTick(ticker, ts, BID, BID + spread);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, ts)!.samples, 101, 'gate-normalized tick was not learned');
    near(tickFlow.getStructuralSpread(ticker), previous + 0.05 * (spread - previous));
});

test('instrument quote subtraction tolerates only floating-point noise at the bootstrap floor', () => {
    for (const [ticker, bid, pipSize, baseSpreadPrice] of [
        ['AUDCAD-TICKFLOW-FLOAT-FX', 0.8, 0.0001, 0.00001],
        ['JP225-TICKFLOW-FLOAT-INDEX', 40000, 1, 1],
    ] as const) {
        registerRolloverSchedule(ticker, { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }] });
        tickFlow.configureBootstrapSpread(ticker, { baseSpreadPrice, pipSize });
        const floor = baseSpreadPrice + 0.8 * pipSize;
        for (let i = 0; i < 100; i++) tickFlow.onTick(ticker, OFF_ROLLOVER + i, bid, bid + floor);
        const ts = OFF_ROLLOVER + 99;
        const q = tickFlow.getSpreadSnapshot(ticker, ts)!;
        assert.equal(q.samples, 100, `${ticker}: exact bootstrap boundary rejected after quote subtraction`);
        assert.equal(isSpreadNormalized({ ...q, baselineSpread: floor / 10 }, ts, baseSpreadPrice, pipSize), true,
            `${ticker}: exact gate floor rejected after quote subtraction`);
        assert.equal(isSpreadNormalized({ ...q, ask: bid + floor + pipSize * 0.000001,
            spread: floor + pipSize * 0.000001, baselineSpread: floor / 10 }, ts, baseSpreadPrice, pipSize), false,
            'tolerance must not admit genuine above-threshold spreads');
    }
});

test('a bilateral snapshot reports quote age and only exposes a baseline after 100 clean samples', () => {
    const ticker = 'EURUSD-TICKFLOW-SNAPSHOT';
    assert.equal(typeof tickFlow.getSpreadSnapshot, 'function', 'fresh bilateral snapshot API is missing');
    assert.equal(tickFlow.getSpreadSnapshot(ticker, OFF_ROLLOVER), null);
    let ts = feed(ticker, OFF_ROLLOVER, 99);
    const warming = tickFlow.getSpreadSnapshot(ticker, ts + 5)!;
    assert.ok(warming);
    assert.equal(warming.bid, BID);
    near(warming.ask, BID + NORMAL);
    assert.equal(warming.ts, ts);
    assert.equal(warming.ageMs, 5);
    assert.equal(warming.samples, 99);
    near(warming.spread, NORMAL);
    assert.equal(warming.baselineSpread, null);
    assert.equal(isSpreadNormalized(warming, ts + 5, NORMAL, 0.0001), false);
    assert.equal(tickFlow.getStructuralSpread(ticker), null);
    ts = feed(ticker, ts + 1, 1);
    const ready = tickFlow.getSpreadSnapshot(ticker, ts)!;
    assert.equal(ready.samples, 100);
    near(ready.baselineSpread, NORMAL);
    near(tickFlow.getSpread(ticker, ts), NORMAL);
});

test('quotes expire strictly after 10 seconds and cannot be queried before their event timestamp', () => {
    const ticker = 'EURUSD-TICKFLOW-FRESHNESS';
    const ts = feed(ticker, OFF_ROLLOVER, 100);
    assert.ok(tickFlow.getSpreadSnapshot(ticker, ts + 10_000));
    assert.equal(tickFlow.getSpreadSnapshot(ticker, ts + 10_001), null, 'stale quote stayed executable');
    assert.equal(tickFlow.getSpread(ticker, ts + 10_001), null);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, ts - 1), null);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, NaN), null);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, Infinity), null);
    near(tickFlow.getStructuralSpread(ticker), NORMAL, 'expiry must not erase clean history');
});

for (const [label, bid, ask] of [
    ['missing ask', BID, undefined],
    ['NaN ask', BID, NaN],
    ['infinite ask', BID, Infinity],
    ['crossed quote', BID, BID - NORMAL],
    ['zero spread', BID, BID],
    ['NaN bid', NaN, BID + NORMAL],
    ['zero bid', 0, NORMAL],
    ['negative bid', -1, 1],
] as const) {
    test(`${label} cannot reuse a previous bilateral quote`, () => {
        const ticker = `EURUSD-TICKFLOW-INVALID-${label}`;
        const ts = feed(ticker, OFF_ROLLOVER, 100);
        tickFlow.onTick(ticker, ts + 1, bid, ask as number);
        assert.equal(tickFlow.getSpreadSnapshot(ticker, ts + 1), null, 'invalid sides reused old quote');
        assert.equal(tickFlow.getSpread(ticker, ts + 1), null);
        near(tickFlow.getStructuralSpread(ticker), NORMAL);
        tickFlow.onTick(ticker, ts + 2, BID, BID + NORMAL);
        assert.equal(tickFlow.getSpreadSnapshot(ticker, ts + 2)!.samples, 101);
    });
}

test('out-of-order events cannot move the quote, baseline, or velocity clock backwards', () => {
    const ticker = 'EURUSD-TICKFLOW-ORDER';
    const ts = feed(ticker, OFF_ROLLOVER, 100, NORMAL, 10);
    const before = tickFlow.getSpreadSnapshot(ticker, ts);
    const velocity = tickFlow.getTickVelocity(ticker)!;
    tickFlow.onTick(ticker, ts - 500, BID + 0.01, BID + 0.01 + WIDE);
    assert.deepEqual(tickFlow.getSpreadSnapshot(ticker, ts), before, 'old event replaced the fresh quote');
    tickFlow.onTick(ticker, ts - 1, NaN, NaN);
    assert.deepEqual(tickFlow.getSpreadSnapshot(ticker, ts), before, 'old partial event invalidated the fresh quote');
    tickFlow.onTick(ticker, ts + 10, BID, BID + NORMAL);
    near(tickFlow.getTickVelocity(ticker)!.ticksPerSec, velocity.ticksPerSec);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, ts + 10)!.samples, 101);
});

test('a late bilateral event cannot undo invalidation by a newer ask-only event', () => {
    const ticker = 'EURUSD-TICKFLOW-PARTIAL-ORDER';
    const ts = feed(ticker, OFF_ROLLOVER, 100);
    tickFlow.onTick(ticker, ts + 100, NaN, BID + NORMAL);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, ts + 100), null);
    tickFlow.onTick(ticker, ts + 50, BID, BID + NORMAL);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, ts + 100), null, 'older event undid newer quote invalidation');
    tickFlow.onTick(ticker, ts + 101, BID, BID + NORMAL);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, ts + 101)!.samples, 101);
});

for (const ts of [NaN, Infinity, -Infinity, -1, 0, 1e20]) {
    test(`invalid timestamp ${ts} cannot corrupt a fresh quote`, () => {
        const ticker = `EURUSD-TICKFLOW-TIMESTAMP-${ts}`;
        const last = feed(ticker, OFF_ROLLOVER, 100);
        const before = tickFlow.getSpreadSnapshot(ticker, last);
        assert.doesNotThrow(() => tickFlow.onTick(ticker, ts, BID, BID + NORMAL));
        assert.deepEqual(tickFlow.getSpreadSnapshot(ticker, last), before);
        tickFlow.onTick(ticker, last + 1, BID, BID + NORMAL);
        assert.equal(tickFlow.getSpreadSnapshot(ticker, last + 1)!.samples, 101);
    });
}

for (const [label, rollover, normal] of [
    ['summer', '2026-10-14T20:45:00.000Z', '2026-10-14T22:00:00.000Z'],
    ['winter', '2026-01-14T21:45:00.000Z', '2026-01-14T23:00:00.000Z'],
] as const) {
    test(`startup during ${label} NY rollover cannot train an initial 19-pip baseline`, () => {
        const ticker = `EURUSD-TICKFLOW-ROLLOVER-${label}`;
        const end = feed(ticker, Date.parse(rollover), 400, WIDE);
        assert.equal(isRolloverBaselineWindow(ticker, end), true);
        assert.equal(tickFlow.getStructuralSpread(ticker), null, 'rollover spread became a baseline');
        const q = tickFlow.getSpreadSnapshot(ticker, end)!;
        near(q.spread, WIDE);
        assert.equal(q.samples, 0);
        assert.equal(q.baselineSpread, null);
        let normalEnd = feed(ticker, Date.parse(normal), 99);
        assert.equal(isRolloverBaselineWindow(ticker, normalEnd), false);
        assert.equal(tickFlow.getSpreadSnapshot(ticker, normalEnd)!.baselineSpread, null);
        normalEnd = feed(ticker, normalEnd + 1, 1);
        near(tickFlow.getSpreadSnapshot(ticker, normalEnd)!.baselineSpread, NORMAL);
        assert.equal(tickFlow.getSpreadSnapshot(ticker, normalEnd)!.samples, 100);
    });
}

test('anomaly detection uses the fresh quote and recovers without relearning after a long wide episode', () => {
    const ticker = 'EURUSD-TICKFLOW-RECOVERY';
    let ts = feed(ticker, OFF_ROLLOVER, 200);
    assert.equal(tickFlow.isSpreadAnomalous(ticker, 3, ts), false);
    ts = feed(ticker, ts + 1, 400, WIDE);
    assert.equal(tickFlow.isSpreadAnomalous(ticker, 3, ts), true, 'wide episode stopped being anomalous');
    assert.equal(tickFlow.isSpreadAnomalous(ticker, 3, ts + 10_001), false);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, ts + 10_001), null);
    ts = feed(ticker, ts + 10_002, 1);
    const recovered = tickFlow.getSpreadSnapshot(ticker, ts)!;
    assert.equal(recovered.samples, 201);
    near(recovered.baselineSpread, NORMAL);
    assert.equal(tickFlow.isSpreadAnomalous(ticker, 3, ts), false);
    assert.equal(isSpreadNormalized(recovered, ts, NORMAL, 0.0001), true);
    assert.equal(isSpreadNormalized(null, ts + 10_001, NORMAL, 0.0001), false);
});

test('outliers during warmup do not satisfy the minimum 100 clean samples', () => {
    const ticker = 'EURUSD-TICKFLOW-WARMUP-OUTLIERS';
    let ts = feed(ticker, OFF_ROLLOVER, 99);
    ts = feed(ticker, ts + 1, 400, WIDE);
    const warming = tickFlow.getSpreadSnapshot(ticker, ts)!;
    assert.equal(warming.samples, 99);
    assert.equal(warming.baselineSpread, null);
    assert.equal(isSpreadNormalized(warming, ts, NORMAL, 0.0001), false);
    ts = feed(ticker, ts + 1, 1);
    near(tickFlow.getSpreadSnapshot(ticker, ts)!.baselineSpread, NORMAL);
});

test('high-rate ordinary spreads still adapt while even moderate quotes are frozen during rollover', () => {
    const ticker = 'EURUSD-TICKFLOW-ADAPT';
    let ts = feed(ticker, OFF_ROLLOVER, 200);
    ts = feed(ticker, ts + 1, 200, NORMAL * 1.5);
    const adapted = tickFlow.getSpreadSnapshot(ticker, ts)!;
    assert.equal(adapted.samples, 400);
    assert.ok(adapted.baselineSpread! > NORMAL * 1.49);
    assert.ok(adapted.baselineSpread! < NORMAL * 1.5);
    assert.equal(isSpreadNormalized(adapted, ts, NORMAL, 0.0001), true);
    ts = feed(ticker, Date.parse('2026-10-14T20:45:00.000Z'), 200, NORMAL * 2);
    const frozen = tickFlow.getSpreadSnapshot(ticker, ts)!;
    assert.equal(frozen.samples, 400);
    assert.equal(frozen.baselineSpread, adapted.baselineSpread);
    const previous = { ...frozen };
    frozen.bid = 0;
    assert.deepEqual(tickFlow.getSpreadSnapshot(ticker, ts), previous, 'snapshot mutation escaped into engine state');
});

test('partial Bid ticks retain real sweep history without synthesizing an executable Ask', () => {
    const ticker = 'EURUSD-TICKFLOW-BID-ONLY';
    for (let i = 0; i < 25; i++) tickFlow.onTick(ticker, OFF_ROLLOVER + i, BID, NaN);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, OFF_ROLLOVER + 24), null);
    assert.equal(tickFlow.getStructuralSpread(ticker), null);
    assert.ok(tickFlow.getTickVelocity(ticker));
    assert.equal(tickFlow.analyzeSweep(ticker, BID + NORMAL, 'BUY', OFF_ROLLOVER + 24).classification, 'RETAIL');
    const invalid = 'EURUSD-TICKFLOW-ASK-ONLY';
    for (let i = 0; i < 25; i++) tickFlow.onTick(invalid, OFF_ROLLOVER + i, NaN, BID);
    assert.equal(tickFlow.getTickVelocity(invalid), null);
    assert.equal(tickFlow.analyzeSweep(invalid, BID + NORMAL, 'BUY', OFF_ROLLOVER + 24).classification, 'UNKNOWN');
});
