import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { getRolloverAssetClass, getRolloverSpreadReference } from '../src/engine/RolloverSpreadReference.js';
import { validateExecutionInstrument } from '../src/engine/ExecutionCosts.js';

const root = new URL('../', import.meta.url);
const source = (path: string) => fs.readFileSync(new URL(path, root), 'utf8');
const tests: [string, () => any][] = [];
function test(name: string, fn: () => any) { tests.push([name, fn]); }
function isolated(text: string, dependencies: any, exports: string[]) {
    // Only selected source is evaluated: no live imports/listeners/Firestore.
    const code = ts.transpileModule(text.replace(/export /g, '').replace(/import\('\.\.\/services\/ctrader\.js'\)/g, 'Promise.resolve(__broker)'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, __broker: dependencies.broker, getRolloverAssetClass, getRolloverSpreadReference, ...dependencies });
    return vm.runInContext(code + '\n({' + exports.join(',') + '})', context);
}
export function selected(path: string, names: string[]) {
    // Keep isolated real declarations closed over new rollover recovery dependencies.
    if (path === 'src/db/trading.ts') {
        names = [...names];
        if (names.includes('rehydrateRolloverPending') || names.includes('loadRolloverJournalPending'))
            names.push('rehydrateLiveRolloverRecord','loadLiveRolloverJournalRecords','rolloverTriageRecords','rolloverMutationInFlight');
        if (names.includes('canExpireOrphanTrade')) names.push('rolloverTriageRecords');
    }
    const text = source(path);
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    return ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '')) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast))))).map(n => n.getText(ast)).join('\n');
}
let gate: any;
test('calendar exists and follows broker NY DST rather than fixed UTC', async () => {
    assert.ok(fs.existsSync(new URL('src/engine/RolloverSpreadGate.ts', root)), 'missing broker calendar module');
    gate = await import('../src/engine/RolloverSpreadGate.js');
    const schedule = [{ startSecond: 61205, endSecond: 145795 }, { startSecond: 147605, endSecond: 232195 }, { startSecond: 234005, endSecond: 318595 }, { startSecond: 320405, endSecond: 404995 }, { startSecond: 406805, endSecond: 491395 }];
    gate.registerRolloverSchedule('EURUSD', { scheduleTimeZone: 'America/New_York', schedule });
    for (const [date, hour] of [['2026-01-12', '21'], ['2026-07-13', '20']]) {
        const c = gate.getRolloverCalendar('EURUSD', Date.parse(`${date}T${hour}:29:55Z`));
        assert.equal(c.pauseStartMs, Date.parse(`${date}T${hour}:29:55Z`));
        assert.equal(c.reopenMs, Date.parse(`${date}T${Number(hour) + 1}:00:05Z`));
        assert.equal(c.entryWindow, true);
        assert.equal(c.marketOpen, false);
        assert.equal(c.metadataAvailable, true);
    }
});

const ms = (s: string) => Date.parse(s);
const quote = (now: number, spread = 0.0001) => ({ bid: 1.1, ask: 1.1 + spread, ts: now, ageMs: 0, samples: 100, spread, baselineSpread: 0.0001 });
test('entry gate stays closed after thaw with wide or missing spread evidence', async () => {
    gate ??= await import('../src/engine/RolloverSpreadGate.js');
    assert.equal(typeof gate.evaluateRolloverEntryGate, 'function', 'missing evidence based entry gate');
    const now = ms('2026-07-13T22:00:00Z');
    const opts = { live: true, baseSpreadPrice: 0.00001, pipSize: 0.0001 };
    assert.equal(gate.evaluateRolloverEntryGate('EURUSD', now, quote(now, 0.0019), opts).blocked, true);
    assert.equal(gate.evaluateRolloverEntryGate('EURUSD', now, quote(now), opts).blocked, false);
    for (const q of [null, { ...quote(now), ts: now - 10001 }, { ...quote(now), samples: 99 }, { ...quote(now), baselineSpread: null }, { ...quote(now), baselineSpread: 0 }, { ...quote(now), ask: 1.0 }]) assert.equal(gate.evaluateRolloverEntryGate('EURUSD', now, q, opts).blocked, true);
    assert.equal(gate.evaluateRolloverEntryGate('GBPUSD', now, quote(now), opts).blocked, true, 'live cannot use fallback');
    assert.equal(gate.evaluateRolloverEntryGate('EURUSD', ms('2026-07-13T21:15:00Z'), quote(ms('2026-07-13T21:15:00Z')), opts).blocked, true);
    assert.equal(gate.evaluateRolloverEntryGate('EURUSD', now, null, { ...opts, enabled: false }).blocked, false);
});
test('calendar excludes weekends, preserves offsets, XAU UTC and baseline embargo', () => {
    const now = ms('2026-07-13T20:29:55Z');
    assert.equal(gate.getRolloverCalendar('EURUSD', now - 9 * 60000).protectionWindow, true);
    assert.equal(gate.getRolloverCalendar('EURUSD', now - 4 * 60000).widenWindow, true);
    assert.equal(gate.getRolloverCalendar('EURUSD', now - 2 * 60000).protectionWindow, false);
    assert.equal(gate.getRolloverCalendar('EURUSD', ms('2026-07-17T20:25:55Z')).widenWindow, false);
    assert.equal(gate.getRolloverCalendar('EURUSD', ms('2026-07-18T20:29:55Z')).entryWindow, false);
    assert.equal(gate.getRolloverCalendar('EURUSD', ms('2026-07-13T21:15:05Z')).restoreEligible, true);
    assert.equal(gate.getRolloverCalendar('EURUSD', ms('2026-07-13T23:45:00Z')).restoreEligible, true);
    assert.equal(gate.isRolloverBaselineWindow('EURUSD', now), true);
    assert.equal(gate.isRolloverBaselineWindow('EURUSD', ms('2026-07-13T21:30:05Z')), false);
    for (const date of ['2026-01-12', '2026-07-13']) {
        const c = gate.getRolloverCalendar('XAUUSD', ms(`${date}T21:30:00Z`));
        assert.equal(c.pauseStartMs, ms(`${date}T20:59:00Z`));
        assert.equal(c.reopenMs, ms(`${date}T22:01:00Z`));
    }
});

async function rolloverHarness(overrides: any = {}) {
    const now = ms('2026-07-13T22:00:00Z');
    const trade = { tradeId: 't1', ticker: 'EURUSD', direction: 'BUY', ctraderPositionId: '7', entryPrice: 1.1, slPrice: 1.097, journalId: 'j1' };
    let brokerSl = 1.097;
    const broker: any = { modifyStopLoss: async (_: string, sl: number) => { brokerSl = sl; return true; }, readPositionProtection: async () => ({ exists: true, stopLoss: brokerSl }), closePosition: async () => true, ...overrides.broker };
    const writes: any[] = [];
    const db = { collection: (name: string) => ({ where: () => ({ get: async () => ({ docs: [] }) }), doc: (id: string) => ({ update: async (data: any) => { writes.push({ name, id, data }); if (overrides.writeFailure) throw new Error('persist failed'); } }) }) };
    // Legacy persistence-only mocks model a completed empty journal lookup.
    const storage = overrides.dependencies?.db ?? db;
    const journalDb = { collection: (name: string) => { const collection = storage.collection(name); return { where: () => ({ get: async () => ({ docs: [] }) }), ...collection }; } };
    const globalState = { activeTrades: new Map([['t1', trade]]), assetSessionConfigs: new Map(), localRadarStates: new Map([['EURUSD', { lastPrice: 1.1 }]]), tickerLocks: new Map() };
    const text = source('src/db/trading.ts');
    const block = text.slice(text.indexOf('const rolloverBeAppliedToday'), text.indexOf('export function startWatchdog'));
    const api = isolated(block, { Date: { now: () => 0 }, ...gate, globalState, broker, getPipValue: (t: string) => /OIL|XTI|WTI|BRENT/.test(t) ? 0.01 : /JPY/.test(t) ? 0.01 : 0.0001, getAssetClass: () => 'FOREX', defaultFrictionConfig: { FOREX: { baseSpreadPips: 0.1 } }, tickFlow: { getSpreadSnapshot: () => overrides.snapshot === undefined ? quote(now) : overrides.snapshot }, getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: now }), sendTelegramAlert: async () => {}, ...overrides.dependencies, db: journalDb }, ['rolloverDWideMap', 'applyRolloverRestore', 'applyRolloverWiden', 'applyRolloverProtection', 'rolloverPipSize', 'rolloverBeAppliedToday', 'rehydrateRolloverPending', 'rolloverJournalRecoveryReady', 'rolloverJournalRecoveryInFlight', 'loadRolloverJournalPending', 'runRolloverCycle']);
    api.rolloverDWideMap.set('t1', { orig: 1.099, wide: 1.097, tries: 3, at: ms('2026-07-13T20:26:00Z'), positionId: '7', ticker: 'EURUSD', direction: 'BUY', nextRetryAt: 0 });
    if (!overrides.deferJournalLookup) await api.loadRolloverJournalPending();
    return { ...api, trade, broker, globalState, writes, now };
}
test('restore retains pending state after three failures with backoff and no abandonment deadline', async () => {
    const h = await rolloverHarness({ broker: { modifyStopLoss: async () => false } });
    await h.applyRolloverRestore(h.now);
    assert.equal(h.rolloverDWideMap.size, 1, 'must not abandon SL after three tries or after thaw cutoff');
    assert.equal(h.rolloverDWideMap.get('t1').tries, 4);
    assert.ok(h.rolloverDWideMap.get('t1').nextRetryAt > h.now);
    assert.ok(h.writes.some((w: any) => w.data.rolloverDRestoreTries === 4));
});

test('restart force does not restore while calendar frozen or spread remains wide', async () => {
    for (const [now, snapshot] of [[ms('2026-07-13T20:45:00Z'), quote(ms('2026-07-13T20:45:00Z'))], [ms('2026-07-13T22:00:00Z'), quote(ms('2026-07-13T22:00:00Z'), 0.0019)], [ms('2026-07-13T22:00:00Z'), null]] as const) {
        let calls = 0;
        const h = await rolloverHarness({ snapshot, broker: { modifyStopLoss: async () => { calls++; return true; } } });
        await h.applyRolloverRestore(now, true);
        assert.equal(calls, 0, 'restart is not evidence of normal spread');
        assert.equal(h.rolloverDWideMap.size, 1);
    }
});

test('RAM stop mismatch is not broker proof; only equivalent broker protection clears', async () => {
    let calls = 0;
    const h = await rolloverHarness({ broker: { readPositionProtection: async () => ({ exists: true, stopLoss: 1.096 }), modifyStopLoss: async () => { calls++; return false; } } });
    h.trade.slPrice = 1.098;
    await h.applyRolloverRestore(h.now);
    assert.equal(h.rolloverDWideMap.size, 1, 'RAM mismatch cannot abandon pending safety');
    assert.equal(calls, 1);
    const better = await rolloverHarness({ broker: { readPositionProtection: async () => ({ exists: true, stopLoss: 1.0995 }), modifyStopLoss: async () => { throw new Error('do not weaken better SL'); } } });
    await better.applyRolloverRestore(better.now);
    assert.equal(better.rolloverDWideMap.size, 0);
    assert.equal(better.trade.slPrice, 1.0995);
    const unknown = await rolloverHarness({ broker: { readPositionProtection: async () => null } });
    unknown.globalState.activeTrades.clear();
    await unknown.applyRolloverRestore(unknown.now);
    assert.equal(unknown.rolloverDWideMap.size, 1, 'missing RAM trade is not confirmed closed');
});
test('invalid original stop closes full position and retains state on failed close', async () => {
    for (const direction of ['BUY', 'SELL']) {
        let closed = 0;
        const h = await rolloverHarness({ broker: { readPositionProtection: async () => ({ exists: true, stopLoss: direction === 'BUY' ? 1.097 : 1.103 }), closePosition: async () => { closed++; return false; }, modifyStopLoss: async () => { throw new Error('invalid original must close'); } } });
        (h.trade as any).direction = direction;
        h.rolloverDWideMap.get('t1').orig = direction === 'BUY' ? 1.101 : 1.099;
        await h.applyRolloverRestore(h.now);
        assert.equal(closed, 1, 'use BUY Bid / SELL Ask before restoring');
        assert.equal(h.rolloverDWideMap.size, 1);
        assert.ok(h.rolloverDWideMap.get('t1').nextRetryAt > h.now);
    }
});

test('complete close rejects broker error and requires explicit absence readback', async () => {
    for (const scenario of ['reject', 'unchanged', 'closed', 'unavailable']) {
        let requests = 0;
        let reads = 0;
        let payload: any;
        const ctClient = { close: async () => {}, getState: async () => { reads++; if (scenario === 'unavailable') return {}; return { positions: scenario === 'closed' && requests > 0 ? [] : [{ positionId: 7, tradeData: { volume: 12345 }, stopLoss: 1.097 }] }; }, connection: { request: async (_: any, p: any) => { requests++; payload = p; return scenario === 'reject' ? { errorCode: 'MARKET_CLOSED' } : {}; } } };
        const names = ['closePosition', 'readPositionProtection'];
        const text = selected('src/services/ctrader.ts', names);
        const api = isolated(text, { ctClient, isCTraderReady: () => true, connectCTrader: async () => true, config: { CTRADER_ACCOUNT_ID: '99' }, PayloadType: { CLOSE_POSITION_REQ: 999 }, setTimeout: (fn: any) => { fn(); } }, ['closePosition']);
        const ok = await api.closePosition('7');
        assert.equal(ok, scenario === 'closed', `${scenario}: close must not report unverified success`);
        if (scenario !== 'unavailable') { assert.equal(requests, 1); assert.equal(payload.volume, 12345); assert.equal(payload.positionId, 7); }
        if (scenario === 'closed') assert.ok(reads >= 2);
    }
});

test('Ask-only quote keeps bilateral side ages and expires the older Bid', () => {
    const text = selected('src/services/ctrader.ts', ['ingestSpotQuote', 'getLastBidAsk', 'lastBidAsk', 'quoteSides', 'MAX_QUOTE_AGE_MS']);
    assert.ok(text.includes('function ingestSpotQuote'), 'missing bilateral SpotEvent decoder');
    const ticks: any[] = [];
    const api = isolated(text, { tickFlow: { onTick: (...args: any[]) => ticks.push(args) } }, ['ingestSpotQuote', 'getLastBidAsk']);
    const now = ms('2026-07-13T22:00:00Z');
    api.ingestSpotQuote('EURUSD', { bid: 110000, ask: 110010, timestamp: now }, now);
    api.ingestSpotQuote('EURUSD', { ask: 110020, timestamp: now + 9000 }, now + 9000);
    assert.equal(api.getLastBidAsk('EURUSD', now + 9000).ask, 1.1002);
    assert.equal(api.getLastBidAsk('EURUSD', now + 9000).ts, now, 'ask cannot refresh Bid age');
    assert.equal(ticks[1][1], now + 9000, 'TickFlow gets event timestamp');
    assert.equal(api.getLastBidAsk('EURUSD', now + 10001), null);
    api.ingestSpotQuote('EURUSD', { ask: 110020, timestamp: now + 11000 }, now + 11000);
    assert.equal(api.getLastBidAsk('EURUSD', now + 11000), null);
    assert.equal(ticks.length, 3, 'Ask-only with stale Bid must invalidate TickFlow at event timestamp');
    assert.ok(Number.isNaN(ticks[2][2]));
    assert.equal(ticks[2][3], 1.1002);
    api.ingestSpotQuote('EURUSD', { bid: 110000, timestamp: now + 12000 }, now + 12000);
    assert.equal(api.getLastBidAsk('EURUSD', now + 12000).ts, now + 11000);
    api.ingestSpotQuote('EURUSD', { bid: 109000, timestamp: now - 1 }, now + 12000);
    assert.equal(api.getLastBidAsk('EURUSD', now + 12000).bid, 1.1, 'out of order event cannot overwrite current side');
});

test('broker symbol info registers actual schedule for live calendar without guessing', async () => {
    const schedule = [{ startSecond: 79260, endSecond: 161940 }, { startSecond: 165660, endSecond: 248340 }, { startSecond: 252060, endSecond: 334740 }, { startSecond: 338460, endSecond: 421140 }, { startSecond: 424860, endSecond: 507420 }];
    const text = selected('src/services/ctrader.ts', ['getSymbolInfo', 'getSymbolDetails']);
    assert.ok(text.includes('function getSymbolInfo'), 'missing metadata-aware symbol info');
    const api = isolated(text, { ctClient: { getSymbolInfo: async () => ({ symbolId: 1, symbolName: 'GOLD', scheduleTimeZone: 'UTC', schedule }) }, isCTraderReady: () => true, connectCTrader: async () => true, mapToCTraderSymbol: () => 'GOLD', symbolToTicker: new Map([[1, 'XAUUSD']]), registerRolloverSchedule: gate.registerRolloverSchedule }, ['getSymbolInfo', 'getSymbolDetails']);
    await api.getSymbolDetails(['XAUUSD']);
    assert.equal(gate.getRolloverCalendar('XAUUSD', ms('2026-07-13T21:00:00Z')).metadataAvailable, true);
});

test('widen persists original pending safety before amend and never repeats in flight', async () => {
    const now = ms('2026-07-13T20:26:55Z');
    let calls = 0;
    const failing = await rolloverHarness({ writeFailure: true, snapshot: quote(now), broker: { modifyStopLoss: async () => { calls++; return true; } }, dependencies: { getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: now }) } });
    failing.rolloverDWideMap.clear();
    await failing.applyRolloverWiden(now);
    assert.equal(calls, 0, 'widen must not precede durable original SL');
    const h = await rolloverHarness({ snapshot: quote(now), dependencies: { getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: now }) } });
    h.rolloverDWideMap.clear();
    let unblock: () => void = () => {};
    const pending = new Promise<void>(r => { unblock = r; });
    h.broker.modifyStopLoss = async () => { calls++; assert.ok(h.writes.some((w: any) => w.data.rolloverDWidened && w.data.rolloverDSlOriginal === 1.097)); await pending; return true; };
    calls = 0;
    const a = h.applyRolloverWiden(now);
    await new Promise(r => setTimeout(r, 10));
    const b = h.applyRolloverWiden(now);
    await new Promise(r => setTimeout(r, 10));
    unblock();
    await Promise.all([a, b]);
    assert.equal(calls, 1);
    assert.equal(h.rolloverDWideMap.size, 1);
});
test('protection uses broker winter calendar, executable fresh side and oil pip cents', async () => {
    const now = ms('2026-01-12T21:22:55Z');
    let amended = 0;
    const h = await rolloverHarness({ snapshot: quote(now), dependencies: { getLastBidAsk: () => ({ bid: 1.101, ask: 1.1011, ts: now }) }, broker: { modifyStopLoss: async () => { amended++; return true; } } });
    h.rolloverDWideMap.clear();
    h.globalState.localRadarStates.get('EURUSD')!.lastPrice = 1.101;
    await h.applyRolloverProtection(now);
    assert.equal(amended, 1, 'winter NY is not 20:20 UTC');
    assert.equal(h.rolloverPipSize('USOIL'), 0.01);
});

test('getConfigForTicker preserves explicit rollover entry opt out', () => {
    const globalState = { dynamicBotConfig: {}, assetSessionConfigs: new Map([['EURUSD', { rolloverEntryBlock: false, sessions: {} }]]) };
    const api = isolated(selected('src/db/trading.ts', ['getConfigForTicker']), { globalState, getCurrentSession: () => 'ALL', validateExecutionInstrument }, ['getConfigForTicker']);
    assert.equal(api.getConfigForTicker('EURUSD').rolloverEntryBlock, false);
});
test('friction peak follows broker DST calendar and excludes weekend', () => {
    const names = ['getAssetClass', 'defaultFrictionConfig', 'getPipValue', 'evaluateNetTrade'];
    const api = isolated(selected('src/engine/FrictionModel.ts', names), { getDecimals: () => 5, ...gate }, names);
    const trade = { ticker: 'EURUSD', direction: 'BUY', entryPrice: 1.1, slPrice: 1.09, tp1Price: 1.12, tp2Price: 1.13 };
    const config = { commissionPerLot: 3, baseSpreadPips: 0.1, latencyMs: 50 };
    assert.match(api.evaluateNetTrade(trade, ms('2026-01-12T21:45:00Z'), config).frictionCostDetails, /Spread: 19.00/);
    assert.match(api.evaluateNetTrade(trade, ms('2026-07-13T21:10:00Z'), config).frictionCostDetails, /Spread: 19.00/);
    assert.match(api.evaluateNetTrade(trade, ms('2026-07-18T20:45:00Z'), config).frictionCostDetails, /Spread: 0.10/);
    assert.match(api.evaluateNetTrade(trade, ms('2026-07-13T21:10:00Z'), { ...config, rolloverPeakPips: 0 }).frictionCostDetails, /Spread: 0.10/);
});
test('new trade initial SL is immutable typed and included in journal without inventing historical values', () => {
    assert.match(source('src/engine/Types.ts'), /readonly initialSlPrice\?: number/);
    const text = source('src/db/trading.ts');
    const journal = text.slice(text.indexOf('journalId = await logTrade({'), text.indexOf("}).catch(() => 'ERR');", text.indexOf('journalId = await logTrade({')));
    assert.match(journal, /initialSlPrice:/);
    assert.doesNotMatch(text, /exTrade\.initialSlPrice\s*=/);
});

test('live entry wiring uses bilateral age and preserves closed-until-normal spread', () => {
    const text = selected('src/db/trading.ts', ['isRolloverEntryWindow', 'getRolloverLiveSnapshot']);
    const now = ms('2026-07-13T22:00:00Z');
    const deps = { ...gate, getAssetClass: () => 'FOREX', getPipValue: () => 0.0001, defaultFrictionConfig: { FOREX: { baseSpreadPips: 0.1 } }, tickFlow: { getSpreadSnapshot: () => quote(now) }, getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: now - 10001 }) };
    const stale = isolated(text, deps, ['isRolloverEntryWindow']);
    assert.equal(stale.isRolloverEntryWindow('EURUSD', now), true, 'fresh Ask cannot rescue old Bid');
    const normal = isolated(text, { ...deps, getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: now }) }, ['isRolloverEntryWindow']);
    assert.equal(normal.isRolloverEntryWindow('EURUSD', now), false);
    const wide = isolated(text, { ...deps, getLastBidAsk: () => ({ bid: 1.1, ask: 1.1019, ts: now }) }, ['isRolloverEntryWindow']);
    assert.equal(wide.isRolloverEntryWindow('EURUSD', now), true);
});
test('pending rehydration keeps retry backoff and refuses fabricated original SL', () => {
    const text = selected('src/db/trading.ts', ['rehydrateRolloverPending', 'rolloverDWideMap', 'rolloverBeAppliedToday']);
    assert.ok(text.includes('function rehydrateRolloverPending'), 'missing durable pending rehydration');
    const api = isolated(text, {}, ['rehydrateRolloverPending', 'rolloverDWideMap']);
    api.rehydrateRolloverPending('t1', { rolloverDWidened: true, rolloverDSlOriginal: 1.099, rolloverDSlWide: 1.097, rolloverDRestoreTries: 8, rolloverDNextRetryAt: 123, ctraderPositionId: '7', ticker: 'EURUSD', direction: 'BUY' });
    assert.equal(api.rolloverDWideMap.get('t1').tries, 8);
    assert.equal(api.rolloverDWideMap.get('t1').nextRetryAt, 123);
    api.rehydrateRolloverPending('unknown', { rolloverDWidened: true, rolloverDSlOriginal: null, rolloverDSlWide: 1.097 });
    assert.equal(api.rolloverDWideMap.has('unknown'), true, 'invalid original must still quarantine persisted widened trade');
    assert.equal(api.rolloverDWideMap.get('unknown').orig, null, 'do not fabricate original from widened SL');
});
test('rollover cycle serializes calls and waits shared normal ticker lock', async () => {
    assert.ok(source('src/db/trading.ts').includes('function runRolloverCycle'), 'missing serialized watchdog cycle');
    const h = await rolloverHarness();
    // Reload the same isolated rollover section exposing its cycle.
    const text = source('src/db/trading.ts');
    const block = text.slice(text.indexOf('const rolloverBeAppliedToday'), text.indexOf('export function startWatchdog'));
    let release = () => {};
    h.globalState.tickerLocks.set('EURUSD', new Promise<void>(r => { release = r; }));
    let amends = 0;
    const api = isolated(block, { Date: { now: () => h.now }, ...gate, globalState: h.globalState, db: { collection: () => ({ doc: () => ({ update: async () => {} }) }) }, broker: { readPositionProtection: async () => ({ exists: true, stopLoss: 1.097 }), modifyStopLoss: async () => { amends++; return false; } }, getPipValue: () => 0.0001, getAssetClass: () => 'FOREX', defaultFrictionConfig: { FOREX: { baseSpreadPips: 0.1 } }, tickFlow: { getSpreadSnapshot: () => quote(h.now) }, getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: h.now }), sendTelegramAlert: async () => {} }, ['runRolloverCycle', 'rolloverDWideMap']);
    api.rolloverDWideMap.set('t1', { orig: 1.099, wide: 1.097, tries: 0, at: h.now, positionId: '7', ticker: 'EURUSD', direction: 'BUY' });
    const a = api.runRolloverCycle(h.now);
    const b = api.runRolloverCycle(h.now);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(amends, 0);
    release(); await Promise.all([a, b]);
    assert.equal(amends, 1);
    assert.equal(h.globalState.tickerLocks.size, 0);
});

test('missing timezone is not valid broker metadata; non-FX has no guessed NY fallback', () => {
    assert.equal(gate.registerRolloverSchedule('BADUSD', { schedule: [{ startSecond: 0, endSecond: 600000 }] }), false);
    assert.equal(gate.getRolloverCalendar('BTCUSD', ms('2026-07-13T20:45:00Z')).scheduleTimeZone, null);
});

test('slow persistence cannot send pre-pause widen after quote and calendar expire', async () => {
    const now = ms('2026-07-13T20:26:55Z');
    let clock = now;
    let calls = 0;
    const h = await rolloverHarness({ dependencies: { Date: { now: () => clock }, getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: now }), db: { collection: () => ({ doc: () => ({ update: async () => { clock = now + 6 * 60000; } }) }) } }, broker: { modifyStopLoss: async () => { calls++; return true; } } });
    h.rolloverDWideMap.clear();
    await h.applyRolloverWiden(now);
    assert.equal(calls, 0, 'clock and quote must be rechecked immediately before amend');
    assert.equal(h.rolloverDWideMap.size, 1, 'durable pending intent retained for broker readback');
});

test('confirmed restore clears durable pending; failed persistence retains recoverable state', async () => {
    const restored = await rolloverHarness();
    await restored.applyRolloverRestore(restored.now);
    assert.equal(restored.rolloverDWideMap.size, 0);
    assert.equal(restored.trade.slPrice, 1.099);
    assert.ok(restored.writes.some((w: any) => w.data.rolloverDWidened === false));
    const failed = await rolloverHarness({ writeFailure: true });
    await failed.applyRolloverRestore(failed.now);
    assert.equal(failed.rolloverDWideMap.size, 1);
});
test('pending safety cannot be expired by seven-day orphan housekeeping', () => {
    const text = selected('src/db/trading.ts', ['canExpireOrphanTrade', 'rolloverDWideMap']);
    assert.ok(text.includes('function canExpireOrphanTrade'), 'housekeeping must preserve durable pending rollover');
    const api = isolated(text, {}, ['canExpireOrphanTrade', 'rolloverDWideMap']);
    api.rolloverDWideMap.set('pending', { orig: 1.1, wide: 1.098 });
    assert.equal(api.canExpireOrphanTrade('pending', 8 * 86400000), false);
    assert.equal(api.canExpireOrphanTrade('ordinary', 8 * 86400000), true);
    assert.equal(api.canExpireOrphanTrade('ordinary', 6 * 86400000), false);
});

test('A never weakens a better stop already present in broker despite stale RAM', async () => {
    const now = ms('2026-01-12T21:22:55Z');
    let calls = 0;
    const h = await rolloverHarness({ dependencies: { getLastBidAsk: () => ({ bid: 1.101, ask: 1.1011, ts: now }) }, broker: { readPositionProtection: async () => ({ exists: true, stopLoss: 1.1005 }), modifyStopLoss: async () => { calls++; return true; } } });
    h.rolloverDWideMap.clear();
    await h.applyRolloverProtection(now);
    assert.equal(calls, 0);
    assert.equal(h.trade.slPrice, 1.1005);
});

test('A latch survives reboot and D never widens broker BE protection from any manager', async () => {
    gate ??= await import('../src/engine/RolloverSpreadGate.js');
    const aNow = ms('2026-07-13T20:22:55Z');
    const dNow = ms('2026-07-13T20:26:55Z');
    const h = await rolloverHarness({ dependencies: { getLastBidAsk: () => ({ bid: 1.101, ask: 1.1011, ts: aNow }) } });
    h.rolloverDWideMap.clear();
    await h.applyRolloverProtection(aNow);
    const periodKey = gate.getRolloverCalendar('EURUSD', aNow).periodKey;
    const durable = h.writes.find((w: any) => w.name === 'active_trades' && w.data.rolloverBeApplied)?.data;
    assert.equal(durable?.rolloverBePeriodKey, periodKey, 'A must durably store exact broker period');
    assert.equal((h.trade as any).rolloverBePeriodKey, periodKey, 'warm RAM must carry the same latch');
    h.rolloverBeAppliedToday.clear();
    h.rehydrateRolloverPending('t1', durable);
    assert.equal(h.rolloverBeAppliedToday.has(`t1:${periodKey}`), true, 'restart must recover A latch');
    // Legacy boolean alone must not fabricate a period; broker BE excludes D independently.
    for (const direction of ['BUY', 'SELL']) {
        let calls = 0;
        const sl = direction === 'BUY' ? 1.1001 : 1.0999;
        const reboot = await rolloverHarness({ dependencies: { getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: dNow }) }, broker: { readPositionProtection: async () => ({ exists: true, stopLoss: sl }), modifyStopLoss: async () => { calls++; return true; } } });
        reboot.rolloverDWideMap.clear();
        Object.assign(reboot.trade, { direction, slPrice: sl, rolloverBeApplied: true });
        reboot.rehydrateRolloverPending('t1', reboot.trade);
        assert.equal(reboot.rolloverBeAppliedToday.size, 0, 'legacy boolean has no date evidence');
        await reboot.applyRolloverWiden(dNow);
        assert.equal(calls, 0, `${direction}: D must never undo BE or profitable broker SL`);
    }
});

test('invalid pending is quarantined across A D restore and orphan expiry without guessed close', async () => {
    let amends = 0, closes = 0, alerts = 0;
    const now = ms('2026-07-13T20:26:55Z');
    const h = await rolloverHarness({ dependencies: { getLastBidAsk: () => ({ bid: 1.101, ask: 1.1011, ts: now }), sendTelegramAlert: async () => { alerts++; } }, broker: { modifyStopLoss: async () => { amends++; return true; }, closePosition: async () => { closes++; return true; } } });
    h.rolloverDWideMap.clear();
    h.rehydrateRolloverPending('t1', { ...h.trade, rolloverDWidened: true, rolloverDSlOriginal: null, rolloverDSlWide: 1.097 });
    await h.applyRolloverProtection(now);
    await h.applyRolloverWiden(now);
    await h.applyRolloverRestore(h.now);
    await h.applyRolloverRestore(h.now + 1);
    assert.equal(amends, 0);
    assert.equal(closes, 0, 'unknown original cannot justify guessed market close');
    assert.equal(h.rolloverDWideMap.has('t1'), true);
    assert.equal(alerts, 1, 'manual recovery warning must be throttled');
    const expiry = isolated(selected('src/db/trading.ts', ['canExpireOrphanTrade']), { rolloverDWideMap: h.rolloverDWideMap }, ['canExpireOrphanTrade']);
    assert.equal(expiry.canExpireOrphanTrade('t1', 8 * 86400000), false);
    assert.equal(h.writes.some((w: any) => w.data.rolloverDWidened === false), false);
});

test('D revalidates broker SL after persistence and excludes outstanding normal amendment', async () => {
    const now = ms('2026-07-13T20:26:55Z');
    let sl = 1.097, amends = 0;
    const writes: any[] = [];
    const h = await rolloverHarness({ dependencies: { getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: now }), db: { collection: (name: string) => ({ doc: () => ({ update: async (data: any) => { writes.push({name, data}); if (data.rolloverDWidened) sl = 1.1005; } }) }) } }, broker: { readPositionProtection: async () => ({ exists: true, stopLoss: sl }), modifyStopLoss: async () => { amends++; return true; } } });
    h.rolloverDWideMap.clear();
    await h.applyRolloverWiden(now);
    assert.equal(amends, 0, 'normal manager improvement during persistence must not be undone');
    assert.equal(h.trade.slPrice, 1.1005);
    assert.equal(h.rolloverDWideMap.size, 0, 'confirmed improved protection cleans unused pending intent');
    assert.ok(writes.some(w => w.data.rolloverDWidened === false));
    const busy = await rolloverHarness({ dependencies: { getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: now }) }, broker: { modifyStopLoss: async () => { amends++; return true; } } });
    busy.rolloverDWideMap.clear();
    (busy.trade as any).slAmendInFlight = true;
    await busy.applyRolloverWiden(now);
    assert.equal(amends, 0, 'D must share normal amendment exclusion');
});

test('every ordinary SL callback holds process ticker lock until broker completion', async () => {
    const text = source('src/db/trading.ts');
    const ast = ts.createSourceFile('trading.ts', text, ts.ScriptTarget.Latest, true);
    const callbacks: string[] = [];
    const walk = (n: ts.Node) => {
        if (ts.isExpressionStatement(n) && n.getText(ast).includes("import('../services/ctrader.js').then") && n.getText(ast).includes('modifyStopLoss')) { callbacks.push(n.getText(ast)); return; }
        ts.forEachChild(n, walk);
    };
    walk(ast);
    assert.equal(callbacks.length, 3, 'exercise retry, TP1 reduction and deferred BE callbacks');
    for (const statement of callbacks) {
        let release = () => {}, calls = 0, done = false;
        const pending = new Promise<void>(r => { release = r; });
        const trade: any = { tradeId: 't1', ctraderPositionId: '7', targetSlPrice: 1.1001, targetSlPending: true };
        const api = isolated(selected('src/db/trading.ts', ['runNormalStopMutation', 'rolloverMutationInFlight']) + '\nasync function run() {' + statement + '}', { broker: { modifyStopLoss: async () => { calls++; await pending; return true; } }, trade, tradeId: 't1', sentSl: 1.1001, targetSl: 1.1001, ticker: 'EURUSD', db: null, mgmtPartialT: 0, mgmtSlModeT: 'breakeven', buildBeMsg: () => '', buildTp1Msg: () => '', sendTelegramAlert: async () => {} }, ['run']);
        const task = api.run().then(() => { done = true; });
        await new Promise(r => setTimeout(r, 10));
        assert.equal(calls, 1);
        const prematurelyReleased = done;
        release(); await task;
        assert.equal(prematurelyReleased, false, 'process must await callback before ticker unlock');
    }
});

test('confirmed closed pending tolerates deleted active document without creating ghost and keeps journal identity', async () => {
    for (const lateClose of [false, true]) {
        let exists = true;
        const writes: any[] = [];
        const db = { collection: (name: string) => ({ doc: (id: string) => ({ update: async (fields: any) => { writes.push({name, id, fields}); if (name === 'active_trades' && !exists) throw Object.assign(new Error('document deleted'), { code: 5 }); }, set: async () => { throw new Error('never recreate active ghost'); } }) }) };
        const h = await rolloverHarness({ dependencies: { db }, broker: { readPositionProtection: async () => ({ exists, stopLoss: exists ? 1.097 : null }), modifyStopLoss: async () => { exists = false; return true; } } });
        h.rolloverDWideMap.get('t1').journalId = 'j1';
        if (!lateClose) { exists = false; h.globalState.activeTrades.clear(); }
        await h.applyRolloverRestore(h.now);
        assert.equal(h.rolloverDWideMap.size, 0, 'confirmed absent position must clear tracking despite deleted active doc');
        assert.ok(writes.some(w => w.name === 'trade_journal' && w.id === 'j1' && w.fields.rolloverDClosed === true));
        const before = writes.length;
        await h.applyRolloverRestore(h.now + 30000);
        assert.equal(writes.length, before, 'no repeated missing-document update spam');
    }
    const open = await rolloverHarness({ writeFailure: true });
    await open.applyRolloverRestore(open.now);
    assert.equal(open.rolloverDWideMap.size, 1, 'storage errors while position still exists must retain pending');
});

test('D improved broker protection retains pending if clearing persistence fails', async () => {
    const now = ms('2026-07-13T20:26:55Z');
    let sl = 1.097, amends = 0;
    const h = await rolloverHarness({ dependencies: { getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: now }), db: { collection: () => ({ doc: () => ({ update: async (fields: any) => { if (fields.rolloverDWidened === true) sl = 1.1005; if (fields.rolloverDWidened === false) throw new Error('storage unavailable'); } }) }) } }, broker: { readPositionProtection: async () => ({ exists: true, stopLoss: sl }), modifyStopLoss: async () => { amends++; return true; } } });
    h.rolloverDWideMap.clear();
    await h.applyRolloverWiden(now);
    assert.equal(amends, 0);
    assert.equal(h.trade.slPrice, 1.1005);
    assert.equal(h.rolloverDWideMap.size, 1, 'broker improvement alone cannot claim durable pending cleared');
});

test('open broker position cannot discard pending on missing active document', async () => {
    const h = await rolloverHarness({ dependencies: { db: { collection: () => ({ doc: () => ({ update: async () => { throw Object.assign(new Error('not found'), {code: 5}); } }) }) } }, broker: { readPositionProtection: async () => ({ exists: true, stopLoss: 1.1005 }) } });
    h.globalState.activeTrades.clear();
    await h.applyRolloverRestore(h.now);
    assert.equal(h.rolloverDWideMap.size, 1, 'NOT_FOUND tolerance is exclusive to confirmed broker absence');
});

function nestedDeclaration(path: string, name: string): string {
    const text = source(path), ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    let found = '';
    const walk = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = `const ${node.getText(ast)};`;
        ts.forEachChild(node, walk);
    };
    walk(ast); assert.ok(found, `missing ${name}`); return found;
}
test('execution callback rechecks microstructure with wall clock after awaited killswitches', async () => {
    const initial = ms('2026-07-13T20:29:54Z');
    for (const delayed of [10001, 2000]) {
        let now = initial, checkedAt = 0;
        const api = isolated(nestedDeclaration('src/db/trading.ts', 'recheckKillswitchesBeforeExecution'), {
            Date: { now: () => now }, ticker: 'EURUSD', nowMs: initial, isBacktest: false, oteData: {},
            getConfigForTicker: () => ({ sessionEnabled: true }),
            store: { globalKillswitches: {}, streakKillswitchUntil: 0, vixKillswitchUntil: 0 },
            evaluateGlobalKillswitch: async () => { now += delayed; return false; }, evaluateAssetKillswitch: async () => false,
            tickFlow: { isSpreadAnomalous: () => false }, logBlockedSignal() {},
            isRolloverEntryWindow: (_: string, at: number) => { checkedAt = at; return at >= initial + delayed; },
        }, ['recheckKillswitchesBeforeExecution']);
        assert.equal(await api.recheckKillswitchesBeforeExecution(), 'BLOCKED_ROLLOVER', 'await crossed pause or quote expiry');
        assert.equal(checkedAt, now);
    }
});

function orderHarness(overrides: any = {}) {
    let now = ms('2026-07-13T22:00:00Z'), requests = 0;
    const events: string[] = [], payloads: any[] = [];
    const quotes = new Map([['EURUSD', quote(now)]]);
    const request = async (payload: any) => { requests++; payloads.push(payload); events.push('request'); if (overrides.rejectRange && requests === 1) { now += overrides.delay ?? 2000; return { errorCode: 'REJECTED' }; } throw new Error('isolated request reached'); };
    const params = { ticker: 'EURUSD', tradeId: 't1', direction: 'BUY', entryPrice: 1.1, slPrice: 1.09, tp1Price: 1.12, ...overrides.params };
    const api = isolated(selected('src/services/ctrader.ts', ['executeMarketOrder']), {
        Date: { now: () => now }, isCTraderReady: () => true, lastBidAsk: quotes,
        ctClient: { getState: async () => ({ positions: [] }), symbols: { resolveId: async () => { events.push('resolve'); now += overrides.delay ?? 0; return 1; } }, raw: { trading: { marketOrder: request, marketRangeOrder: request } } },
        config: { CTRADER_RISK_PERCENT: 1, CTRADER_MAX_POSITIONS: 10, CTRADER_MARKET_RANGE: overrides.range ?? false, CTRADER_MAX_SLIPPAGE_PIPS: 2 },
        getAccountInfo: async () => { events.push('account'); now += overrides.delay ?? 0; return { equity: 10000 }; },
        getSymbolInfo: async () => { events.push('symbol'); return { symbolId: overrides.noSymbolId ? undefined : 1, digits: 5, lotSize: 10000000, minVolume: 1, stepVolume: 1 }; },
        getSymbolDigits: async () => 5, calculateLotSize: () => 0.1, mapToCTraderSymbol: (t: string) => t,
        getLastBidAsk: (_: string, at: number) => { const q = quotes.get('EURUSD'); return q && at >= q.ts && at - q.ts <= 10000 ? q : null; },
        getRolloverSpreadReference: () => ({ pipSize: 0.0001, baseSpreadPrice: 0.00001 }),
        evaluateRolloverEntryGate: (_: string, at: number, snapshot: any) => ({ blocked: !snapshot || at - snapshot.ts > 10000 || overrides.blocked }),
        tickFlow: { getSpreadSnapshot: () => quote(now), getStructuralSpread: () => 0.0001, getSpread: () => 0.0001 },
    }, ['executeMarketOrder']);
    return { run: () => api.executeMarketOrder(params), params, events, payloads, quotes, get now() { return now; }, set now(v) { now = v; }, get requests() { return requests; } };
}
test('order preflight invokes awaited callback after preparation and before each raw request', async () => {
    for (const range of [true, false]) {
        const h = orderHarness({ range, noSymbolId: !range });
        h.params.beforeExecution = async () => { h.events.push('callback'); return 'BLOCKED_ROLLOVER'; };
        const result = await h.run();
        assert.equal(h.requests, 0, 'callback rejection must never reach broker or trigger fallback');
        assert.match(result.error, /BLOCKED_ROLLOVER/);
        assert.ok(h.events.indexOf('callback') > h.events.indexOf('symbol'));
        if (!range) assert.ok(h.events.indexOf('callback') > h.events.indexOf('resolve'));
    }
});

test('order freshness survives slow awaits and callback delays including rollover opt out', async () => {
    for (const rolloverEntryBlock of [true, false]) {
        for (const delayInCallback of [true, false]) {
            const h = orderHarness({ delay: delayInCallback ? 0 : 10001, params: { rolloverEntryBlock } });
            h.params.beforeExecution = async () => { if (delayInCallback) h.now += 10001; return null; };
            const result = await h.run();
            assert.equal(h.requests, 0, 'no expired arrival-price fallback even when normalized gate is disabled');
            assert.match(result.error, /quote|cotización/i);
        }
    }
});
test('range arrival uses fresh quote after callback and fallback rechecks callback', async () => {
    const h = orderHarness({ range: true });
    h.params.beforeExecution = async () => { h.now += 100; h.quotes.set('EURUSD', { ...quote(h.now), bid: 1.101, ask: 1.1011 }); return null; };
    await h.run();
    assert.equal(h.requests, 1);
    assert.equal(h.payloads[0].baseSlippagePrice, 1.1011, 'arrival must be recaptured after final awaited callback');
    const fallback = orderHarness({ range: true, rejectRange: true });
    let callbacks = 0;
    fallback.params.beforeExecution = async () => ++callbacks === 2 ? 'BLOCKED_PAUSE' : null;
    const result = await fallback.run();
    assert.equal(callbacks, 2); assert.equal(fallback.requests, 1);
    assert.match(result.error, /BLOCKED_PAUSE/);
});
test('rollover opt out skips normalized gate only, not independent broker stop validity', async () => {
    const normal = orderHarness({ blocked: true, params: { rolloverEntryBlock: false } });
    await normal.run(); assert.equal(normal.requests, 1);
    const gated = orderHarness({ blocked: true });
    await gated.run(); assert.equal(gated.requests, 0);
    const invalid = orderHarness({ params: { rolloverEntryBlock: false } });
    invalid.params.beforeExecution = async () => { invalid.quotes.set('EURUSD', { ...quote(invalid.now), bid: 1.08, ask: 1.0801 }); return null; };
    await invalid.run(); assert.equal(invalid.requests, 0, 'quote moved through SL during awaited callback');
});

test('open position lifecycle differentiates unavailable state from confirmed empty broker list', async () => {
    for (const state of [null, {}, { positions: null }, { positions: [null] }, { positions: [{}] }, { positions: [], errorCode: 'TIMEOUT' }, { errorCode: 'TIMEOUT' }, 'throw', 'disconnected']) {
        const api = isolated(selected('src/services/ctrader.ts', ['getOpenPositions']), {
            ctClient: { getState: async () => { if (state === 'throw') throw new Error('network'); return state; } },
            isCTraderReady: () => state !== 'disconnected', symbolToTicker: new Map(),
        }, ['getOpenPositions']);
        let failed = false;
        try { failed = await api.getOpenPositions() === null; } catch { failed = true; }
        assert.equal(failed, true, `${JSON.stringify(state)} cannot prove absence`);
    }
    const empty = isolated(selected('src/services/ctrader.ts', ['getOpenPositions']), { ctClient: { getState: async () => ({ positions: [] }) }, isCTraderReady: () => true }, ['getOpenPositions']);
    assert.equal((await empty.getOpenPositions()).length, 0);
});

test('reconcile unavailable broker leaves pending RAM and storage intact and retries without throttle', async () => {
    for (const unavailable of [null, 'throw']) {
        const trade = { tradeId: 't1', ctraderPositionId: '7', ticker: 'EURUSD', timestamp: 1, rolloverDWidened: true };
        const globalState = { activeTrades: new Map([['t1', trade]]) };
        let reads = 0, writes = 0;
        const api = isolated(selected('src/db/trading.ts', ['lastReconcileTs', 'reconcileCTraderPositions']), {
            Date: { now: () => 1e9 }, globalState, db: { collection: () => { writes++; throw new Error('must not write'); } },
            broker: { isCTraderReady: () => true, getOpenPositions: async () => { reads++; if (unavailable === 'throw') throw new Error('network'); return unavailable; } },
        }, ['reconcileCTraderPositions']);
        await api.reconcileCTraderPositions(); await api.reconcileCTraderPositions();
        assert.equal(globalState.activeTrades.get('t1'), trade); assert.equal(writes, 0);
        assert.equal(reads, 2, 'failed broker read is not a completed reconciliation');
    }
});

test('pending durable fields survive normal full active serialization and retry updates both stores', async () => {
    gate ??= await import('../src/engine/RolloverSpreadGate.js');
    const now = ms('2026-07-13T20:26:55Z');
    gate.registerRolloverSchedule('EURUSD', { scheduleTimeZone: 'America/New_York', schedule: Array.from({ length: 5 }, (_, i) => ({ startSecond: 61205 + i * 86400, endSecond: 145795 + i * 86400 })) });
    const h = await rolloverHarness({ dependencies: { getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: now }) } });
    h.rolloverDWideMap.clear();
    await h.applyRolloverWiden(now);
    const serialized = JSON.parse(JSON.stringify(h.trade));
    assert.equal(serialized.rolloverDWidened, true, 'ordinary active_trades.set(trade) must carry pending fields');
    assert.equal(serialized.rolloverDSlOriginal, 1.097);
    assert.equal(serialized.rolloverDPositionId, '7');
    const retry = await rolloverHarness({ broker: { modifyStopLoss: async () => false } });
    retry.rolloverDWideMap.get('t1').journalId = 'j1';
    await retry.applyRolloverRestore(retry.now);
    for (const name of ['active_trades', 'trade_journal']) assert.ok(retry.writes.some((w: any) => w.name === name && w.data.rolloverDRestoreTries === 4), `${name} must retain retry backoff`);
});

test('failed clear persistence cannot erase pending from a later normal full active write', async () => {
    gate ??= await import('../src/engine/RolloverSpreadGate.js');
    const h = await rolloverHarness({ writeFailure: true, broker: { readPositionProtection: async () => ({ exists: true, stopLoss: 1.1005 }) } });
    Object.assign(h.trade, { rolloverDWidened: true, rolloverDSlOriginal: 1.099, rolloverDSlWide: 1.097 });
    await h.applyRolloverRestore(h.now);
    assert.equal((h.trade as any).rolloverDWidened, true, 'failed clear must not leak into normal full-document writes');
    assert.equal((h.trade as any).rolloverDSlOriginal, 1.099);
});

test('boot recovers journal-only pending safety without recreating active or closed trades', async () => {
    const text = selected('src/db/trading.ts', ['rolloverJournalRecoveryReady', 'rolloverJournalRecoveryInFlight', 'loadRolloverJournalPending', 'rehydrateRolloverPending', 'rolloverDWideMap', 'rolloverBeAppliedToday']);
    assert.ok(text.includes('function loadRolloverJournalPending'), 'missing journal pending recovery');
    const pending = { tradeId: 'lost', ticker: 'EURUSD', direction: 'BUY', ctraderPositionId: '7', rolloverDWidened: true, rolloverDSlOriginal: 1.099, rolloverDSlWide: 1.097, rolloverDRestoreTries: 8, rolloverDNextRetryAt: 123 };
    const docs = [{ id: 'j1', data: () => pending }, { id: 'closed', data: () => ({ result: 'WIN', ticker: 'EURUSD', ctraderPositionId: '8', rolloverDWidened: false }) }, { id: 'closed-pending', data: () => ({ ...pending, tradeId: 'closed-pending', result: 'WIN', ctraderPositionId: '9' }) }];
    const globalState = { activeTrades: new Map() }, queries: any[] = [];
    const api = isolated(text, { globalState, db: { collection: (name: string) => ({ where: (...args: any[]) => { queries.push([name, ...args]); return { get: async () => ({ docs }) }; } }) } }, ['rolloverJournalRecoveryReady', 'rolloverJournalRecoveryInFlight', 'loadRolloverJournalPending', 'rolloverDWideMap']);
    await api.loadRolloverJournalPending();
    assert.equal(globalState.activeTrades.size, 0, 'journal is safety evidence, not proof of an open position');
    assert.equal(api.rolloverDWideMap.get('lost').journalId, 'j1');
    assert.equal(api.rolloverDWideMap.get('lost').tries, 8);
    assert.equal(api.rolloverDWideMap.get('lost').nextRetryAt, 123);
    assert.equal(api.rolloverDWideMap.has('closed'), false);
    assert.equal(api.rolloverDWideMap.get('closed-pending').positionId, '9', 'pending must await broker absence readback, never reopen a journal trade');
    assert.deepEqual(queries[0], ['trade_journal', 'rolloverDWidened', '==', true]);
    const boot = source('src/db/trading.ts').slice(source('src/db/trading.ts').indexOf("db.collection('active_trades').get()"), source('src/db/trading.ts').indexOf("unsubscribers.push(db.collection('app_settings')"));
    assert.ok(boot.indexOf('await loadRolloverJournalPending()') >= 0 && boot.indexOf('await loadRolloverJournalPending()') < boot.indexOf('runRolloverCycle'));
});

test('broker adoption merges journal pending into active without overwriting durable safety', async () => {
    const journal: any = { ticker: 'EURUSD', direction: 'BUY', ctraderPositionId: '7', rolloverDWidened: true, rolloverDSlOriginal: 1.099, rolloverDSlWide: 1.097, rolloverDRestoreTries: 8, rolloverDNextRetryAt: 123 };
    const writes: any[] = [];
    const makeDoc = (name: string, id: string): any => ({ id, data: () => name === 'trade_journal' ? journal : undefined, get: async () => makeDoc(name, id), update: async (fields: any) => { writes.push({ name, id, fields }); Object.assign(journal, fields); }, set: async (fields: any, options: any) => { writes.push({ name, id, fields, options }); if (name === 'trade_journal') { if (!options?.merge) for (const k of Object.keys(journal)) delete journal[k]; Object.assign(journal, fields); } }, delete: async () => { throw new Error('must not delete'); } });
    const db = { collection: (name: string) => ({ doc: (id: string) => makeDoc(name, id), where: (key: string) => ({ limit: () => ({ get: async () => ({ docs: key === 'result' ? [] : [makeDoc(name, 'j1')] }) }), get: async () => ({ docs: [makeDoc(name, 'j1')] }) }) }) };
    const globalState = { activeTrades: new Map() };
    const api = isolated(selected('src/db/trading.ts', ['lastReconcileTs', 'reconcileCTraderPositions', 'rolloverDWideMap', 'rolloverBeAppliedToday', 'rehydrateRolloverPending', 'rolloverJournalRecoveryReady', 'rolloverJournalRecoveryInFlight', 'loadRolloverJournalPending']), {
        Date, db, globalState, capTp2Price: (_: any, __: any, ___: any, ____: any, tp: number) => tp,
        broker: { isCTraderReady: () => true, getOpenPositions: async () => [{ positionId: 7, ticker: 'EURUSD', stopLoss: 1.097, takeProfit: 1.12, tradeData: { tradeSide: 1, openPrice: 1.1 } }] },
    }, ['reconcileCTraderPositions', 'rolloverDWideMap']);
    await api.reconcileCTraderPositions();
    assert.equal(journal.rolloverDWidened, true, 'adoption must merge, not replace an existing journal');
    assert.equal(journal.rolloverDSlOriginal, 1.099);
    const trade: any = globalState.activeTrades.get('j1');
    assert.equal(trade.rolloverDWidened, true); assert.equal(trade.journalId, 'j1');
    assert.equal(api.rolloverDWideMap.get('j1').orig, 1.099);
    assert.equal(api.rolloverDWideMap.get('j1').tries, 8);
    assert.ok(writes.some(w => w.name === 'active_trades' && w.fields.rolloverDSlOriginal === 1.099));
});

test('live entry and restore use independent rollover price references rather than global friction', async () => {
    gate ??= await import('../src/engine/RolloverSpreadGate.js');
    const reference = { pipSize: 0.01, baseSpreadPrice: 0.04, cleanBaseline: 0.04 };
    let options: any;
    const api = isolated(selected('src/db/trading.ts', ['isRolloverEntryWindow', 'getRolloverLiveSnapshot']), {
        ...gate, getRolloverSpreadReference: () => reference, getPipValue: () => 0.0001, getAssetClass: () => 'FOREX', defaultFrictionConfig: { FOREX: { baseSpreadPips: 0.1 } },
        tickFlow: { getSpreadSnapshot: () => quote(1000) }, getLastBidAsk: () => quote(1000),
        evaluateRolloverEntryGate: (_: any, __: any, ___: any, opts: any) => { options = opts; return { blocked: false }; },
    }, ['isRolloverEntryWindow']);
    api.isRolloverEntryWindow('USOIL', 1000);
    assert.equal(options.pipSize, reference.pipSize); assert.equal(options.baseSpreadPrice, reference.baseSpreadPrice);
    const seen: any[] = [];
    const h = await rolloverHarness({ dependencies: { getRolloverSpreadReference: () => reference, getRolloverCalendar: () => ({ metadataAvailable: true, restoreEligible: true }), isSpreadNormalized: (_: any, __: any, base: number, pip: number) => { seen.push({ base, pip }); return true; } } });
    await h.applyRolloverRestore(h.now);
    assert.ok(seen.length >= 2);
    for (const { base, pip } of seen) { assert.equal(base, reference.baseSpreadPrice); assert.equal(pip, reference.pipSize); }
});

test('D excludes broker index crypto aliases with rollover-only classification and A keeps known thresholds', async () => {
    const helper = await import('../src/engine/RolloverSpreadReference.js');
    const api = isolated(selected('src/db/trading.ts', ['rolloverIsOtcFx', 'rolloverPipSize', 'rolloverMinFloat', 'rolloverBeBuffer']), {
        ...helper, getAssetClass: () => 'FOREX', getPipValue: () => 0.0001,
    }, ['rolloverIsOtcFx', 'rolloverPipSize', 'rolloverMinFloat', 'rolloverBeBuffer']);
    for (const ticker of ['JP225', 'GER40', 'USTECH100', 'NETHERLANDS25', 'BTCUSD', 'ETHUSD']) assert.equal(api.rolloverIsOtcFx(ticker), false, `${ticker}: D must not widen indices/crypto`);
    for (const ticker of ['EURUSD', 'GBPJPY', 'USOIL', 'XAUUSD', 'XPTUSD']) assert.equal(api.rolloverIsOtcFx(ticker), true);
    for (const [ticker, pip, minimum, buffer] of [['EURUSD', .0001, .0002, .0001], ['GBPJPY', .01, .02, .01], ['USOIL', .01, .05, .03], ['XAUUSD', .1, 1, .5], ['US100', 1, 5, 5], ['BTCUSD', 0, 250, 0]] as const) {
        assert.equal(api.rolloverPipSize(ticker), pip); assert.equal(api.rolloverMinFloat(ticker, 50000), minimum); assert.equal(api.rolloverBeBuffer(ticker), buffer);
    }
});

test('filtered broker absence cannot be confirmed from an unmapped open symbol', async () => {
    const api = isolated(selected('src/services/ctrader.ts', ['getOpenPositions']), { isCTraderReady: () => true, ctClient: { getState: async () => ({ positions: [{ positionId: 7, tradeData: { symbolId: 55 } }] }) }, symbolToTicker: new Map() }, ['getOpenPositions']);
    await assert.rejects(api.getOpenPositions('EURUSD'), /symbol|símbolo/i);
});

test('reconcile orphan sweep preserves pending whose position link survives only in safety state', async () => {
    const trade = { tradeId: 't1', ticker: 'EURUSD', timestamp: 1, rolloverDWidened: true };
    const globalState = { activeTrades: new Map([['t1', trade]]) };
    let deletes = 0;
    const db = { collection: () => ({ doc: () => ({ delete: async () => { deletes++; }, update: async () => {} }), where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }) };
    const api = isolated(selected('src/db/trading.ts', ['lastReconcileTs', 'reconcileCTraderPositions']), {
        Date: { now: () => 1e9 }, globalState, db, loadRolloverJournalPending: async () => {}, rolloverDWideMap: new Map([['t1', { positionId: '7' }]]),
        broker: { isCTraderReady: () => true, getOpenPositions: async () => [] },
    }, ['reconcileCTraderPositions']);
    await api.reconcileCTraderPositions();
    assert.equal(globalState.activeTrades.get('t1'), trade); assert.equal(deletes, 0);
});

test('legacy pending never fabricates journal identity from a distinct trade id', async () => {
    const h = await rolloverHarness({ broker: { modifyStopLoss: async () => false }, dependencies: { getRolloverCalendar: () => ({ metadataAvailable: true, restoreEligible: true }) } });
    delete (h.trade as any).journalId;
    await h.applyRolloverRestore(h.now);
    assert.equal(h.writes.some((w: any) => w.name === 'trade_journal' && w.id === 't1'), false, 'unknown journal identity cannot be inferred from tradeId');
    assert.ok(h.writes.some((w: any) => w.name === 'active_trades' && w.id === 't1' && w.data.rolloverDRestoreTries === 4));
});

test('legacy pending restores with normal evidence when real broker metadata has no intraday pause', async () => {
    gate ??= await import('../src/engine/RolloverSpreadGate.js');
    gate.registerRolloverSchedule('EURUSD-CONTINUOUS-LEGACY', { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }] });
    const h = await rolloverHarness();
    const ticker = 'EURUSD-CONTINUOUS-LEGACY';
    const calendar = gate.getRolloverCalendar(ticker, h.now);
    assert.equal(calendar.metadataAvailable, true); assert.equal(calendar.marketOpen, true);
    assert.equal(calendar.pauseStartMs, null); assert.equal(calendar.restoreEligible, true);
    h.trade.ticker = ticker;
    h.rolloverDWideMap.clear();
    h.rehydrateRolloverPending('t1', { ...h.trade, rolloverDWidened: true, rolloverDSlOriginal: 1.099, rolloverDSlWide: 1.097, rolloverDWidenedAt: h.now - 8 * 86400000, rolloverDRestoreTries: 12 });
    await h.applyRolloverRestore(h.now);
    assert.equal(h.trade.slPrice, 1.099); assert.equal(h.rolloverDWideMap.size, 0, 'legacy safety has no abandonment deadline');
});
test('normal stop mutation rejects overlap and releases amendment exclusion even on broker rejection', async () => {
    const api = isolated(selected('src/db/trading.ts', ['runNormalStopMutation', 'rolloverMutationInFlight']), {}, ['runNormalStopMutation', 'rolloverMutationInFlight']);
    const trade: any = {};
    let release = () => {}, calls = 0;
    const pending = new Promise<void>(r => { release = r; });
    const task = api.runNormalStopMutation('t1', trade, async () => { calls++; await pending; throw new Error('broker rejected'); });
    const rejected = assert.rejects(task, /broker rejected/);
    await api.runNormalStopMutation('t1', trade, async () => { calls++; });
    assert.equal(calls, 1); assert.equal(trade.slAmendInFlight, true);
    release(); await rejected;
    assert.equal(trade.slAmendInFlight, false); assert.equal(api.rolloverMutationInFlight.size, 0);
    await api.runNormalStopMutation('t1', trade, async () => { calls++; });
    assert.equal(calls, 2);
});

test('journal recovery failure cannot adopt an untracked widened broker stop as a fresh original', async () => {
    const globalState = { activeTrades: new Map() };
    let writes = 0;
    const db = { collection: () => ({ where: () => ({ get: async () => { throw new Error('storage unavailable'); }, limit: () => ({ get: async () => { throw new Error('storage unavailable'); } }) }), doc: () => ({ set: async () => { writes++; } }) }) };
    const api = isolated(selected('src/db/trading.ts', ['lastReconcileTs', 'reconcileCTraderPositions', 'rolloverJournalRecoveryReady', 'rolloverJournalRecoveryInFlight', 'loadRolloverJournalPending', 'rehydrateRolloverPending', 'rolloverDWideMap', 'rolloverBeAppliedToday']), {
        globalState, db, Date, capTp2Price: () => 1.12,
        broker: { isCTraderReady: () => true, getOpenPositions: async () => [{ positionId: 7, ticker: 'EURUSD', stopLoss: 1.097, tradeData: { tradeSide: 1, openPrice: 1.1 } }] },
    }, ['reconcileCTraderPositions']);
    await api.reconcileCTraderPositions();
    assert.equal(globalState.activeTrades.size, 0, 'wait for durable safety lookup rather than starting a second D widen');
    assert.equal(writes, 0);
});

test('journal recovery attaches pending to an existing RAM trade before ordinary full-document writes', async () => {
    const trade: any = { tradeId: 'active', ctraderPositionId: '7', ticker: 'EURUSD', direction: 'BUY', entryPrice: 1.1, slPrice: 1.097 };
    const data = { tradeId: 'lost', ctraderPositionId: '7', ticker: 'EURUSD', direction: 'BUY', rolloverDWidened: true, rolloverDSlOriginal: 1.099, rolloverDSlWide: 1.097, rolloverDRestoreTries: 8 };
    const api = isolated(selected('src/db/trading.ts', ['rolloverJournalRecoveryReady', 'rolloverJournalRecoveryInFlight', 'loadRolloverJournalPending', 'rehydrateRolloverPending', 'rolloverDWideMap', 'rolloverBeAppliedToday']), {
        globalState: { activeTrades: new Map([['active', trade]]) },
        db: { collection: () => ({ where: () => ({ get: async () => ({ docs: [{ id: 'j1', data: () => data }] }) }) }) },
    }, ['rolloverJournalRecoveryReady', 'rolloverJournalRecoveryInFlight', 'loadRolloverJournalPending', 'rolloverDWideMap']);
    assert.equal(await api.loadRolloverJournalPending(), true);
    assert.equal(trade.rolloverDWidened, true); assert.equal(trade.rolloverDSlOriginal, 1.099); assert.equal(trade.journalId, 'j1');
    assert.equal(api.rolloverDWideMap.has('lost'), false); assert.equal(api.rolloverDWideMap.get('active').tries, 8);
});

test('real modifyStopLoss final guard rejects expired D after slow getState and retains pending', async () => {
    const now = ms('2026-07-13T20:26:55Z');
    let clock = now, requests = 0;
    const api = isolated(selected('src/services/ctrader.ts', ['modifyStopLoss', 'amendSltpChecked']), {
        isCTraderReady: () => true, symbolToTicker: new Map([[1, 'EURUSD']]), getSymbolDigits: async () => 5,
        ctClient: { getState: async () => { clock += 4 * 60000; return { positions: [{ positionId: 7, tradeData: { symbolId: 1 } }] }; }, connection: { request: async () => { requests++; return {}; } } },
        config: { CTRADER_ACCOUNT_ID: '99' }, PayloadType: { AMEND_POSITION_SLTP_REQ: 999 }, verifyPositionProtection: async () => true,
    }, ['modifyStopLoss']);
    const h = await rolloverHarness({ dependencies: { Date: { now: () => clock }, getLastBidAsk: () => ({ bid: 1.1, ask: 1.1001, ts: now }) }, broker: { modifyStopLoss: api.modifyStopLoss } });
    h.rolloverDWideMap.clear();
    await h.applyRolloverWiden(now);
    assert.equal(requests, 0, 'real broker prep crossed D phase and quote expiry before AMEND');
    assert.equal(h.rolloverDWideMap.size, 1);
    assert.equal(h.trade.slPrice, 1.097);
});

test('real modifyStopLoss A D restore guards recheck executable SL after slow symbol digits', async () => {
    for (const phase of ['A', 'D', 'restore']) {
        const now = ms(phase === 'A' ? '2026-07-13T20:22:55Z' : phase === 'D' ? '2026-07-13T20:26:55Z' : '2026-07-13T22:00:00Z');
        let moved = false, requests = 0;
        const api = isolated(selected('src/services/ctrader.ts', ['modifyStopLoss', 'amendSltpChecked']), {
            isCTraderReady: () => true, symbolToTicker: new Map([[1, 'EURUSD']]),
            getSymbolDigits: async () => { moved = true; return 5; },
            ctClient: { getState: async () => ({ positions: [{ positionId: 7, tradeData: { symbolId: 1 } }] }), connection: { request: async () => { requests++; return {}; } } },
            config: { CTRADER_ACCOUNT_ID: '99' }, PayloadType: { AMEND_POSITION_SLTP_REQ: 999 }, verifyPositionProtection: async () => true,
        }, ['modifyStopLoss']);
        const h = await rolloverHarness({ snapshot: quote(now), dependencies: {
            Date: { now: () => now }, getLastBidAsk: () => ({ bid: moved ? 1.09 : phase === 'A' ? 1.101 : 1.1, ask: moved ? 1.0901 : phase === 'A' ? 1.1011 : 1.1001, ts: now }),
        }, broker: { modifyStopLoss: api.modifyStopLoss } });
        if (phase !== 'restore') h.rolloverDWideMap.clear();
        if (phase === 'A') await h.applyRolloverProtection(now);
        else if (phase === 'D') await h.applyRolloverWiden(now);
        else await h.applyRolloverRestore(now);
        assert.equal(requests, 0, `${phase}: SL must remain valid against current Bid after all prep awaits`);
        if (phase !== 'A') assert.equal(h.rolloverDWideMap.size, 1);
    }
});

test('ordinary real modifyStopLoss preserves unused third argument and amends without callback', async () => {
    let requests = 0;
    const api = isolated(selected('src/services/ctrader.ts', ['modifyStopLoss', 'amendSltpChecked']), {
        isCTraderReady: () => true, symbolToTicker: new Map(), getSymbolDigits: async () => 5,
        ctClient: { getState: async () => ({ positions: [{ positionId: 7, tradeData: { symbolId: 1 }, takeProfit: 1.12 }] }), connection: { request: async (_: any, payload: any) => { requests++; assert.equal(payload.takeProfit, 1.12); return {}; } } },
        config: { CTRADER_ACCOUNT_ID: '99' }, PayloadType: { AMEND_POSITION_SLTP_REQ: 999 }, verifyPositionProtection: async () => true,
    }, ['modifyStopLoss']);
    assert.equal(await api.modifyStopLoss('7', 1.099, 1.1), true); assert.equal(requests, 1);
});

test('A D stay closed while initial journal lookup is incomplete and resume only after success', async () => {
    for (const phase of ['A', 'D']) {
        const now = ms(phase === 'A' ? '2026-07-13T20:22:55Z' : '2026-07-13T20:26:55Z');
        let release = () => {}, amends = 0;
        const waiting = new Promise<void>(r => { release = r; });
        const h = await rolloverHarness({ deferJournalLookup: true, dependencies: { Date: { now: () => now }, getLastBidAsk: () => ({ bid: phase === 'A' ? 1.101 : 1.1, ask: phase === 'A' ? 1.1011 : 1.1001, ts: now }), db: { collection: () => ({ where: () => ({ get: async () => { await waiting; return { docs: [] }; } }), doc: () => ({ update: async () => {} }) }) } }, broker: { modifyStopLoss: async () => { amends++; return true; } } });
        h.rolloverDWideMap.clear();
        const lookup = h.loadRolloverJournalPending();
        const apply = phase === 'A' ? h.applyRolloverProtection : h.applyRolloverWiden;
        await apply(now);
        assert.equal(amends, 0, `${phase}: initial lookup has not completed`);
        release(); assert.equal(await lookup, true);
        await apply(now); assert.equal(amends, 1, `${phase}: successful lookup opens readiness`);
    }
});

test('cycle retries failed journal lookup and permits A D only after later lookup success', async () => {
    for (const phase of ['A', 'D']) {
        const now = ms(phase === 'A' ? '2026-07-13T20:22:55Z' : '2026-07-13T20:26:55Z');
        let available = false, reads = 0, amends = 0;
        const h = await rolloverHarness({ deferJournalLookup: true, dependencies: { Date: { now: () => now }, getLastBidAsk: () => ({ bid: phase === 'A' ? 1.101 : 1.1, ask: phase === 'A' ? 1.1011 : 1.1001, ts: now }), db: { collection: () => ({ where: () => ({ get: async () => { reads++; if (!available) throw new Error('journal down'); return { docs: [] }; } }), doc: () => ({ update: async () => {} }) }) } }, broker: { modifyStopLoss: async () => { amends++; return true; } } });
        h.rolloverDWideMap.clear();
        assert.equal(await h.loadRolloverJournalPending(), false);
        await h.runRolloverCycle(now);
        assert.equal(amends, 0, `${phase}: failed recovery cannot create a fresh original`);
        assert.ok(reads >= 2, 'cycle must retry failed lookup');
        available = true; await h.runRolloverCycle(now);
        // Lookup is nonblocking for known restores; A may wait for the next cycle.
        assert.equal(await h.loadRolloverJournalPending(), true);
        await h.runRolloverCycle(now);
        assert.equal(amends, 1, `${phase}: a later successful lookup must release fail-closed flag`);
    }
});

test('failed journal readiness never suspends known pending restore or invalid-original emergency close', async () => {
    for (const invalid of [false, true]) {
        let amends = 0, closes = 0;
        const h = await rolloverHarness({ dependencies: { db: { collection: () => ({ where: () => ({ get: async () => { throw new Error('lookup failed'); } }), doc: () => ({ update: async () => {} }) }) } }, broker: { modifyStopLoss: async () => { amends++; return false; }, closePosition: async () => { closes++; return false; } } });
        if (invalid) h.rolloverDWideMap.get('t1').orig = 1.101;
        assert.equal(await h.loadRolloverJournalPending(), false);
        await h.runRolloverCycle(h.now);
        assert.equal(amends, invalid ? 0 : 1); assert.equal(closes, invalid ? 1 : 0);
        assert.equal(h.rolloverDWideMap.size, 1);
    }
});

test('journal merge fills existing pending identity preserves newer safety and restore clears only j1', async () => {
    const data = { tradeId: 't1', ctraderPositionId: '7', ticker: 'EURUSD', direction: 'BUY', rolloverDWidened: true, rolloverDSlOriginal: 1.098, rolloverDSlWide: 1.096, rolloverDRestoreTries: 1, rolloverDNextRetryAt: 0, rolloverDWidenedAt: 1 };
    const writes: any[] = [];
    const h = await rolloverHarness({ deferJournalLookup: true, dependencies: { db: { collection: (name: string) => ({ where: () => ({ get: async () => ({ docs: [{ id: 'j1', data: () => data }] }) }), doc: (id: string) => ({ update: async (fields: any) => { writes.push({ name, id, fields }); } }) }) } } });
    delete (h.trade as any).journalId;
    const entry = h.rolloverDWideMap.get('t1');
    Object.assign(entry, { tries: 8, nextRetryAt: h.now - 1 });
    for (const key of ['positionId', 'ticker', 'direction']) delete entry[key];
    Object.assign(h.trade, { rolloverDWidened: true, rolloverDSlOriginal: entry.orig, rolloverDSlWide: entry.wide, rolloverDRestoreTries: entry.tries, rolloverDNextRetryAt: entry.nextRetryAt });
    const safety = { orig: entry.orig, wide: entry.wide, tries: entry.tries, nextRetryAt: entry.nextRetryAt, at: entry.at };
    assert.equal(await h.loadRolloverJournalPending(), true);
    assert.equal(h.rolloverDWideMap.get('t1'), entry, 'existing pending identity must not be replaced');
    assert.equal(entry.journalId, 'j1'); assert.equal(entry.positionId, '7'); assert.equal(entry.ticker, 'EURUSD'); assert.equal(entry.direction, 'BUY');
    for (const [key, value] of Object.entries(safety)) assert.equal(entry[key], value, `${key}: stale journal cannot overwrite newer pending`);
    assert.equal(h.trade.journalId, 'j1');
    const active: any = h.trade;
    assert.equal(active.rolloverDSlOriginal, safety.orig); assert.equal(active.rolloverDSlWide, safety.wide);
    assert.equal(active.rolloverDRestoreTries, safety.tries); assert.equal(active.rolloverDNextRetryAt, safety.nextRetryAt);
    await h.applyRolloverRestore(h.now);
    assert.equal(h.rolloverDWideMap.size, 0);
    assert.ok(writes.some(w => w.name === 'trade_journal' && w.id === 'j1' && w.fields.rolloverDWidened === false));
    assert.equal(writes.some(w => w.name === 'trade_journal' && w.id === 't1'), false, 'never clear a phantom t1 journal');
});

test('journal merge fills missing active position ticker direction using existing pending trade id', async () => {
    const h = await rolloverHarness({ deferJournalLookup: true, dependencies: { db: { collection: () => ({ where: () => ({ get: async () => ({ docs: [{ id: 'j1', data: () => ({ tradeId: 't1', ctraderPositionId: '7', ticker: 'EURUSD', direction: 'BUY', rolloverDWidened: true, rolloverDSlOriginal: 1.099, rolloverDSlWide: 1.097 }) }] }) }) }) } } });
    for (const key of ['journalId', 'ctraderPositionId', 'ticker', 'direction']) delete (h.trade as any)[key];
    assert.equal(await h.loadRolloverJournalPending(), true);
    assert.equal(h.trade.journalId, 'j1'); assert.equal(h.trade.ctraderPositionId, '7'); assert.equal(h.trade.ticker, 'EURUSD'); assert.equal(h.trade.direction, 'BUY');
});

test('incomplete journal lookup never stalls known pending restore in the rollover cycle', async () => {
    let release = () => {}, amends = 0;
    const waiting = new Promise<void>(r => { release = r; });
    const h = await rolloverHarness({ deferJournalLookup: true, dependencies: { db: { collection: () => ({ where: () => ({ get: async () => { await waiting; return { docs: [] }; } }), doc: () => ({ update: async () => {} }) }) } }, broker: { modifyStopLoss: async () => { amends++; return false; } } });
    const task = h.runRolloverCycle(h.now);
    await new Promise(r => setTimeout(r, 10));
    const beforeLookupCompletes = amends;
    release(); await task;
    assert.equal(beforeLookupCompletes, 1, 'known original must remain recoverable while journal lookup is incomplete');
    assert.equal(h.rolloverDWideMap.size, 1);
});

let failures = 0, executed = 0;
for (const [name, fn] of tests) {
    if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) continue;
    executed++;
    try { await fn(); console.log(`PASS ${name}`); }
    catch (e) { failures++; console.error(`FAIL ${name}`, e); }
}
console.log(`RESULT ${tests.length} registered; executed=${executed}; failures=${failures}`);
process.exitCode = failures ? 1 : 0;
