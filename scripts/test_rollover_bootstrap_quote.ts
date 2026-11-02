import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { tickFlow } from '../src/engine/TickFlow.js';
import { evaluateRolloverEntryGate, registerRolloverSchedule } from '../src/engine/RolloverSpreadGate.js';
import { getRolloverSpreadReference } from '../src/engine/RolloverSpreadReference.js';

const NOW = Date.parse('2026-07-13T22:00:00Z');
const PIP = 0.0001;
const schedule = { scheduleTimeZone: 'America/New_York', schedule: Array.from({ length: 5 }, (_, i) => ({ startSecond: 61205 + i * 86400, endSecond: 145795 + i * 86400 })) };
function feed(ticker: string, ts: number, count: number, spread: number) {
    registerRolloverSchedule(ticker, schedule);
    for (let i = 0; i < count; i++) tickFlow.onTick(ticker, ts + i, 1.1, 1.1 + spread);
    return ts + count - 1;
}
function gate(ticker: string, now: number) {
    return evaluateRolloverEntryGate(ticker, now, tickFlow.getSpreadSnapshot(ticker, now), { live: true, pipSize: PIP, baseSpreadPrice: 0.1 * PIP });
}

// Real TickFlow + real gate, no FrictionModel/database/listener imports.
test('restart after thaw never bootstraps from 100 or 1000 persistent 19-pip quotes', () => {
    const ticker = 'EURUSD-BOOTSTRAP-WIDE';
    let now = feed(ticker, NOW, 100, 19 * PIP);
    assert.equal(tickFlow.getStructuralSpread(ticker), null, 'wide startup self-certified as clean');
    assert.equal(tickFlow.getSpreadSnapshot(ticker, now)!.samples, 0);
    assert.equal(gate(ticker, now).blocked, true);
    now = feed(ticker, now + 1, 900, 19 * PIP);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, now)!.samples, 0);
    assert.equal(gate(ticker, now).blocked, true);
    now = feed(ticker, now + 1, 99, 0.1 * PIP);
    assert.equal(gate(ticker, now).blocked, true);
    now = feed(ticker, now + 1, 1, 0.1 * PIP);
    assert.equal(gate(ticker, now).blocked, false, 'recovery must not deadlock');
});

test('all warmup ticks inside rollover are excluded, including ordinary 0.1-pip quotes', () => {
    const ticker = 'EURUSD-BOOTSTRAP-EMBARGO';
    const end = feed(ticker, Date.parse('2026-07-13T20:45:00Z'), 1000, 0.1 * PIP);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, end)!.samples, 0);
    const now = feed(ticker, NOW, 100, 0.1 * PIP);
    assert.equal(gate(ticker, now).blocked, false);
});

test('one tiny first quote does not lock the remaining independently clean warmup out', () => {
    const ticker = 'EURUSD-BOOTSTRAP-TINY';
    feed(ticker, NOW, 1, 0.01 * PIP);
    const now = feed(ticker, NOW + 1, 99, 0.8 * PIP);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, now)!.samples, 100);
    assert.equal(gate(ticker, now).blocked, false);
});

test('configured price-unit bounds support JPY, metals, oil, indices and trusted clean seeds', () => {
    for (const [ticker, pipSize, basePips] of [['USDJPY-BOOTSTRAP', 0.01, 0.1], ['XAUUSD-BOOTSTRAP', 0.1, 1], ['USOIL-BOOTSTRAP', 0.01, 3], ['US500-BOOTSTRAP', 1, 1]] as const) {
        tickFlow.configureBootstrapSpread(ticker, { baseSpreadPrice: basePips * pipSize, pipSize });
        let now = feed(ticker, NOW, 100, (basePips + 1) * pipSize);
        assert.equal(tickFlow.getSpreadSnapshot(ticker, now)!.samples, 0);
        now = feed(ticker, now + 1, 100, basePips * pipSize);
        assert.equal(tickFlow.getSpreadSnapshot(ticker, now)!.samples, 100);
    }
    const ticker = 'EURUSD-BOOTSTRAP-SEEDED';
    tickFlow.configureBootstrapSpread(ticker, { baseSpreadPrice: 0.1 * PIP, pipSize: PIP, cleanBaseline: PIP });
    let now = feed(ticker, NOW, 100, 19 * PIP);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, now)!.samples, 0);
    now = feed(ticker, now + 1, 99, PIP);
    assert.equal(tickFlow.getStructuralSpread(ticker), null, 'seed must not manufacture 100 observations');
    now = feed(ticker, now + 1, 1, PIP);
    assert.equal(gate(ticker, now).blocked, false);
});

function service(names: string[], dependencies: any = {}, modulePath = 'services/ctrader.ts') {
    const path = new URL('../src/' + modulePath, import.meta.url);
    const source = fs.readFileSync(path, 'utf8');
    const ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
    const text = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '')) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast))))).map(n => n.getText(ast)).join('\n');
    const code = ts.transpileModule(text.replace(/export /g, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    return vm.runInNewContext(code + '\n({' + names.join(',') + '})', { console, tickFlow, getRolloverSpreadReference, ...dependencies });
}
function quotes() {
    return service(['MAX_QUOTE_AGE_MS', 'lastBidAsk', 'quoteSides', 'ingestSpotQuote', 'getLastBidAsk']);
}

test('missing broker timestamp cannot refresh a delayed price with local now', () => {
    const api = quotes();
    const ticker = 'EURUSD-NO-TIMESTAMP';
    api.ingestSpotQuote(ticker, { bid: 110000, ask: 110001 }, NOW);
    assert.equal(api.getLastBidAsk(ticker, NOW), null);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, NOW), null);
    assert.equal(tickFlow.getTickVelocity(ticker), null);
});

test('timestamp-less partial invalidates prior executable evidence until both sides are timestamped again', () => {
    const api = quotes();
    const ticker = 'EURUSD-MISSING-TS-AFTER-CLEAN';
    api.ingestSpotQuote(ticker, { bid: 110000, ask: 110001, timestamp: NOW }, NOW);
    api.ingestSpotQuote(ticker, { ask: 110002 }, NOW + 1);
    assert.equal(api.getLastBidAsk(ticker, NOW + 1), null);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, NOW + 1), null);
    api.ingestSpotQuote(ticker, { ask: 110002, timestamp: NOW + 2 }, NOW + 2);
    assert.equal(api.getLastBidAsk(ticker, NOW + 2), null, 'unknown Bid age was reused');
    api.ingestSpotQuote(ticker, { bid: 110000, timestamp: NOW + 3 }, NOW + 3);
    assert.equal(api.getLastBidAsk(ticker, NOW + 3).ts, NOW + 2);
});

test('delayed, future and out-of-order Bid-only/Ask-only events do not refresh either quote clock', () => {
    for (const side of ['bid', 'ask']) {
        const api = quotes();
        const ticker = `EURUSD-DELAYED-${side}`;
        api.ingestSpotQuote(ticker, { bid: 110000, ask: 110001, timestamp: NOW }, NOW);
        const before = tickFlow.getSpreadSnapshot(ticker, NOW);
        for (const timestamp of [NOW - 10001, NOW + 100, NOW - 1]) api.ingestSpotQuote(ticker, { [side]: 109000, timestamp }, NOW);
        assert.deepEqual(tickFlow.getSpreadSnapshot(ticker, NOW), before);
        assert.equal(api.getLastBidAsk(ticker, NOW).ts, NOW);
    }
});

test('ask-only updates quote age from the older side without adding Bid ticks or breaches', () => {
    const api = quotes();
    const ticker = 'EURUSD-REAL-ASK-ONLY';
    registerRolloverSchedule(ticker, schedule);
    for (let i = 0; i < 19; i++) api.ingestSpotQuote(ticker, { bid: 110000, ask: 110001, timestamp: NOW + i * 100 }, NOW + i * 100);
    const before = tickFlow.getTickVelocity(ticker);
    for (let i = 1; i <= 100; i++) api.ingestSpotQuote(ticker, { ask: 110002, timestamp: NOW + 1800 + i }, NOW + 1800 + i);
    const now = NOW + 1900;
    assert.deepEqual(tickFlow.getTickVelocity(ticker), before, 'Ask-only accelerated Bid velocity');
    assert.equal(tickFlow.analyzeSweep(ticker, 1.1001, 'BUY', now).classification, 'UNKNOWN', 'Ask-only manufactured enough Bid history for a breach');
    assert.equal(tickFlow.getSpreadSnapshot(ticker, now)!.ts, NOW + 1800);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, now)!.ageMs, 100);
    assert.equal(api.getLastBidAsk(ticker, now).ts, NOW + 1800);
    assert.equal(tickFlow.getSpreadSnapshot(ticker, NOW + 11801), null);
    assert.equal(api.getLastBidAsk(ticker, NOW + 11801), null);
});

test('live wiring requests timestamps explicitly and installs independent bootstrap config before quotes', async () => {
    const calls: any[] = [];
    const api = service(['subscribeToLiveTrendbars', 'subscribedSymbols', 'symbolToTicker', 'subscribedSpots', 'subscribedTrendbars'], {
        isConnected: true, ctClient: { raw: { market: { subscribeSpots: async (...args: any[]) => { calls.push(args); }, subscribeLiveTrendbar: async () => {} } } },
        mapToCTraderSymbol: (t: string) => t, getSymbolInfo: async () => ({ symbolId: 1, ...schedule }),
        registerRolloverSchedule, configureSpotBootstrap: (ticker: string) => { calls.push(['bootstrap', ticker]); }, lastBidAsk: new Map(),
    });
    await api.subscribeToLiveTrendbars('EURUSD-WIRING', 5, 'M5');
    assert.ok(calls.some(c => c[0] === 'bootstrap'), 'subscription omitted independent bootstrap config');
    assert.equal(calls.find(c => Array.isArray(c[0]))[1], true, 'subscribeToSpotTimestamp was omitted');
});

test('SDK restoreSubscriptions retains timestamp requests through the application request adapter', async () => {
    const path = new URL('../src/services/ctrader.ts', import.meta.url);
    assert.ok(/function installTimestampedSpotRequests/.test(fs.readFileSync(path, 'utf8')), 'missing application reconnect adapter');
    const sdk = await import(new URL('../node_modules/ctrader-ts/dist/src/modules/market.js', import.meta.url).href);
    const requests: any[] = [];
    const connection = { request: async function (type: number, payload: any) { assert.equal(this, connection); requests.push({ type, payload }); return {}; } };
    const client = { connection, raw: { market: new sdk.CTraderMarket(connection, 99) } };
    const api = service(['installTimestampedSpotRequests'], { PayloadType: { SUBSCRIBE_SPOTS_REQ: 2127 } });
    api.installTimestampedSpotRequests(client);
    await client.raw.market.subscribeSpots([1], true);
    requests.length = 0;
    await client.raw.market.restoreSubscriptions();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].payload.subscribeToSpotTimestamp, true, 'SDK auto-restore silently lost timestamps');
    assert.deepEqual(requests[0].payload.symbolId, [1]);
});

test('spot bootstrap transmits independent reference cleanBaseline in price units unchanged', () => {
    const calls: any[] = [];
    const reference = { pipSize: 0.01, baseSpreadPrice: 0.03, cleanBaseline: 0.04 };
    const api = service(['configureSpotBootstrap'], {
        tickFlow: { configureBootstrapSpread: (...args: any[]) => calls.push(args) },
        getRolloverSpreadReference: (ticker: string, price: number) => { assert.equal(ticker, 'usoil'); assert.equal(price, 80); return reference; },
        getPipValue: () => 0.01, getAssetClass: () => 'ENERGY', defaultFrictionConfig: { ENERGY: { baseSpreadPips: 3 } },
    });
    api.configureSpotBootstrap('usoil', 80);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['USOIL', reference]]);
});

test('independent clean seed wiring permits calibrated oil cross FX index and platinum without self-certifying wide quotes', () => {
    for (const [ticker, pipSize, baseSpreadPrice, cleanBaseline, price] of [
        ['USOIL-CALIBRATION-WIRING', .01, .03, .04, 80], ['AUDNZD-CALIBRATION-WIRING', .0001, .00001, .0002, 1.1],
        ['JP225-CALIBRATION-WIRING', 1, 1, 3, 40000], ['XPTUSD-CALIBRATION-WIRING', .1, .1, 9.22, 1500],
    ] as const) {
        const reference = { pipSize, baseSpreadPrice, cleanBaseline };
        const api = service(['configureSpotBootstrap'], { getRolloverSpreadReference: () => reference });
        api.configureSpotBootstrap(ticker, price);
        registerRolloverSchedule(ticker, schedule);
        for (let i = 0; i < 100; i++) tickFlow.onTick(ticker, NOW + i, price, price + 4 * cleanBaseline);
        assert.equal(tickFlow.getSpreadSnapshot(ticker, NOW + 99)!.samples, 0, `${ticker}: wide live observations must not certify themselves`);
        for (let i = 0; i < 100; i++) tickFlow.onTick(ticker, NOW + 100 + i, price, price + cleanBaseline);
        const snapshot = tickFlow.getSpreadSnapshot(ticker, NOW + 199)!;
        assert.equal(snapshot.samples, 100, `${ticker}: clean seed must permit independently measured normal spreads`);
        assert.equal(evaluateRolloverEntryGate(ticker, NOW + 199, snapshot, { live: true, ...reference }).blocked, false);
    }
});

test('real SpotEvent handler configures normalized asset bounds before TickFlow, including dynamic crypto pips', () => {
    let now = NOW;
    let spot: (msg: any) => void = () => { throw new Error('missing SpotEvent handler'); };
    const client = { onExecution() {}, connection: { on(type: number, fn: any) { assert.equal(type, 2131); spot = fn; } } };
    const api = service(['setupCTraderEvents', 'configureSpotBootstrap', 'MAX_QUOTE_AGE_MS', 'lastBidAsk', 'quoteSides', 'ingestSpotQuote', 'getLastBidAsk', 'symbolToTicker', 'subscribedSymbols'], { getRolloverSpreadReference, Date: { now: () => now } });
    api.setupCTraderEvents(client);
    for (const [id, ticker, bid, spread] of [[1, 'XAUUSD-REAL-WIRING', 3000, 0.1], [2, 'BTCUSD-REAL-WIRING', 50000, 10]] as const) {
        api.symbolToTicker.set(id, ticker);
        registerRolloverSchedule(ticker, schedule);
        for (let i = 0; i < 100; i++) {
            now = NOW + i;
            spot({ symbolId: id, bid: bid * 100000, ask: (bid + spread) * 100000, timestamp: now });
        }
        const q = tickFlow.getSpreadSnapshot(ticker, now)!;
        assert.equal(q.samples, 100, `${ticker}: independent asset configuration was not installed before quote`);
        assert.ok(Math.abs(q.baselineSpread! - spread) < 1e-9);
    }
});
