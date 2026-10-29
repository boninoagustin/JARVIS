import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const path = 'src/db/trading.ts';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const names = ['freezeExecutionFill', 'manageExecutionPosition', 'routeExecutionSetup'];
const declarations = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? ''));
assert.equal(declarations.length, 3, 'live must use isolated real fill/routing/management boundary functions');
const micro = await import('../../src/engine/ExecutionMicrostructure.js');
const context = await import('../../src/engine/ExecutionContext.js');
const costs = await import('../../src/engine/ExecutionCosts.js');
const targets = await import('../../src/engine/tp2Cap.js');
const exports: any = {};
const body = declarations.map(n => n.getFullText(ast)).join('\n');
vm.runInNewContext(ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, console, ...micro, ...context, ...costs, ...targets });
for (const name of names) assert.ok(source.split(`${name}(`).length >= 3, `${name} must be called by the real live path`);
const policy = micro.resolveExecutionPolicy({ profile: 'microstructure_v1', targets: false });
const instrument = { ticker: 'EURUSD', regime: 'FOREX', pipSize: .0001, tickSize: .00001, pipValuePerLotUsd: 10, baseSpreadPips: 1, exitSlippagePips: .1, commissionPerLotSideUsd: 3.5, minStopDistance: 0, source: 'explicit_model' };
const at = 1_000_000_000;
const quote = { bid: 1.1000, ask: 1.1001, timestampMs: at, source: 'broker' };
const trade: any = { tradeId: 'TEST', ticker: 'EURUSD', direction: 'BUY', entryPrice: 1.1, initialSlPrice: 1.099, slPrice: 1.099, tp1Price: 1.1011, tp2Price: 1.103, tp1Hit: false, timestamp: at, ctraderPositionId: 'offline' };
assert.equal(exports.freezeExecutionFill(trade, { policy, instrument, executedPrice: 1.1001, filledAtMs: at, lots: 1, quote }), true);
assert.equal(trade.executionState.mfePriceDist, 0);
assert.ok(Math.abs(trade.executionState.initialRiskDist - .0011) < 1e-12);
policy.management = false; instrument.commissionPerLotSideUsd = 900;
assert.equal(trade.executionPolicy.management, true, 'freeze policy, do not alias mutable root config');
assert.equal(trade.executionInstrument.commissionPerLotSideUsd, 3.5);
const historical = { ...trade }; delete historical.initialSlPrice; delete historical.executionState; delete historical.executionPolicy;
assert.equal(exports.freezeExecutionFill(historical, { policy, instrument, executedPrice: 1.1, filledAtMs: at, lots: 1, quote }), false, 'unknown historical initial SL never auto-adopted');
const calls: string[] = []; let brokerSl = trade.slPrice; let partialSuccess = false; let amendSuccess = true; let readbackSuccess = true; let persistSuccess = true; let remaining = 1; let blocked = false;
let q = { ...quote, bid: 1.1012, ask: 1.1013, timestampMs: at + 1000 };
const boundary = {
 now: () => q.timestampMs, quote: () => q, rolloverBlocked: () => blocked,
 accounting: async () => ({ lots: 1, remainingLots: remaining, paidCostsUsd: 0 }),
 partial: async () => { calls.push('partial'); if (partialSuccess) remaining = .3; return partialSuccess ? { status: 'confirmed' as const } : { status: 'rejected' as const }; },
 readProtection: async () => { calls.push('read'); return { exists: true, stopLoss: readbackSuccess ? brokerSl : 1.099 }; },
 amend: async (_price: number, before: () => boolean) => { calls.push('amend'); if (!before() || !amendSuccess) return false; brokerSl = _price; return true; },
 persist: async (_fields: any) => { calls.push('persist'); if (!persistSuccess) throw new Error('offline persistence rejected'); },
};
const run = async () => exports.manageExecutionPosition(trade, { ticker: 'EURUSD', tf: '5', observedAtMs: q.timestampMs, quote: q, atr14: .0002 }, q.timestampMs, .7, boundary);
await run();
assert.equal(trade.executionState.partialConfirmed, false, 'failed broker partial cannot unlock management');
assert.equal(trade.executionState.stage, 'NONE');
partialSuccess = true; q = { ...q, timestampMs: q.timestampMs + 1000 };
await run();
assert.equal(trade.executionState.partialConfirmed, true, 'successful broker partial + persisted state latch');
assert.equal(trade.executionState.stage, 'DEFENSIVE_MIDPOINT', 'TP1 partial only gives breathing room before max trigger');
assert.equal(trade.slPrice, brokerSl);
q = { ...q, bid: 1.106, ask: 1.1061, timestampMs: q.timestampMs + 1000 }; readbackSuccess = false;
await run();
assert.equal(trade.executionState.stage, 'DEFENSIVE_MIDPOINT', 'accepted amend without matching readback must not advance stage');
readbackSuccess = true; q = { ...q, timestampMs: q.timestampMs + 1000 };
await run();
assert.equal(trade.executionState.stage, 'NET_PROTECTION_ESTIMATE');
const preserved = trade.slPrice; blocked = true; q = { ...q, bid: 1.107, ask: 1.1071, timestampMs: q.timestampMs + 1000 };
const amends = calls.filter(x => x === 'amend').length; await run();
assert.equal(calls.filter(x => x === 'amend').length, amends, 'rollover blocks new discretionary amendments');
assert.equal(trade.slPrice, preserved, 'blocked BE never undoes existing protection');
assert.ok(trade.executionState.mfePriceDist < .007, 'MFE uses post-fill quote, no historical bar peaks');
const preservedState = JSON.stringify(trade.executionState);
const goodInstrument = trade.executionInstrument;
trade.executionInstrument = undefined;
assert.equal(await run(), 'UNKNOWN_COST_METADATA');
assert.equal(JSON.stringify(trade.executionState), preservedState, 'unknown units/costs cannot mutate execution state');
trade.executionInstrument = goodInstrument;
const old = { ...trade }; delete old.executionState;
const before = calls.length; await exports.manageExecutionPosition(old, undefined, q.timestampMs, .7, boundary);
assert.equal(calls.length, before, 'historical position without version remains legacy');
const breakBar = { tf: '5', openTimeMs: at - 300000, closeTimeMs: at, availableAtMs: at, open: 1.1, high: 1.101, low: 1.0999, close: 1.1009, closed: true };
const setup: any = { zones: [], marketBias: { '240': 'BUY', '60': 'BUY', D: 'BUY' }, biasTs: { '240': at, '60': at, D: at }, executionContext: { schema: 1, ticker: 'EURUSD', lastObservedAtMs: at,
    byTf: { '5': { atrSeed: 0, atrSamples: 14, atr14: .001, lastClosedBar: breakBar, breakBar,
        impulse: { direction: 'BUY', origin: 1.099, extreme: 1.101, createdAtMs: at - 600000 } } } } };
const newLeg: any = { dir: 'BUY', origin: 1.099, extreme: 1.101, createdAt: at, executionSnapshot: context.getExecutionSnapshot(setup, '5', at) };
const decision = exports.routeExecutionSetup(setup, newLeg, { executionPolicy: { profile: 'microstructure_v1', targets: false } }, '5', at, 1.1009, 1.0999, 1.1029);
assert.equal(decision.mode, 'OTE_STANDARD', 'unknown tick activity cannot justify DIRECT; actual HTF supports 50');
assert.equal(decision.recommendedOtePercent, 50);
assert.equal(newLeg.executionSnapshot.tf, '5');
setup.executionContext.byTf['5'].lastClosedBar = { ...breakBar, openTimeMs: at, closeTimeMs: at + 300000, availableAtMs: at + 300000 };
setup.executionContext.lastObservedAtMs = at + 300000;
assert.equal(exports.routeExecutionSetup(setup, newLeg, { executionPolicy: { profile: 'microstructure_v1', targets: false } }, '5', at + 300000, 1.1009, 1.0999, 1.1029).mode, 'WAIT_DATA', 'old break cannot use latest ATR vintage');
setup.executionContext.byTf['5'].lastClosedBar = breakBar; setup.executionContext.lastObservedAtMs = at;
const noSourceSetup = { dir: 'BUY', origin: 1.099, extreme: 1.101, createdAt: at + 1 };
assert.equal(exports.routeExecutionSetup(setup, noSourceSetup, { executionPolicy: { profile: 'microstructure_v1', targets: false } }, '5', at + 1, 1.1009, 1.0999, 1.1029).mode, 'WAIT_DATA', 'a new leg cannot reuse an old cached setup without source break linkage');
// Execute the actual alert entry point through its early killswitch boundary: zero services/imports.
const processNode = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'processTradingAlert')!;
const alertExports: any = {}; const rawSignals: any[] = [];
const alertStore: any = { tickerLocks: new Map(), globalKillswitches: { GLOBAL_SYSTEM: true } };
vm.runInNewContext(ts.transpileModule(processNode.getFullText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: alertExports, console: { log: () => {}, warn: () => {} }, db: {}, globalState: alertStore, parseTF: (v: string) => v+'M', scheduleRawSignalSave: (v: any) => rawSignals.push(v) });
const native = 'EVENTO_CHOCH | EURUSD | TF: 5 | BUY | ORIGIN: 1.099';
await alertExports.processTradingAlert(native+' | EX1: malformed SELL TF: 240', alertStore);
assert.equal(rawSignals[0].alertText, native, 'actual alert caller strips even malformed EX1 before legacy text processing');
const preSource = fs.readFileSync('/tmp/jarvis-execution-verification/C-PRE-trading.ts', 'utf8');
const preAst = ts.createSourceFile(path, preSource, ts.ScriptTarget.Latest, true);
for (const name of ['applyRolloverProtection','applyRolloverWiden','applyRolloverRestore','runNormalStopMutation','getRolloverLiveSnapshot','loadRolloverJournalPending']) {
    const original = preAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text===name);
    const current = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text===name);
    assert.equal(current?.getText(ast), original?.getText(preAst), `${name}: PRE rollover protection must remain byte-identical`);
}
const retryTrade: any = { tradeId:'RETRY', ticker:'EURUSD', direction:'BUY', entryPrice:1.1001, initialSlPrice:1.099, slPrice:1.099, tp1Price:1.1011, tp2Price:1.103, timestamp:at, tp1Hit:false };
exports.freezeExecutionFill(retryTrade, { policy:micro.resolveExecutionPolicy({profile:'microstructure_v1',targets:false}), instrument:goodInstrument, executedPrice:1.1001,filledAtMs:at,lots:1,quote });
blocked=false; remaining=1; partialSuccess=true; brokerSl=1.099;
let rejectConfirmation=true;
const retryBoundary={...boundary, persist:async (fields:any)=>{if(rejectConfirmation && fields.executionState?.partialConfirmed) throw new Error('persist confirmation rejected');}};
const countBefore=calls.filter(x=>x==='partial').length;
await assert.rejects(()=>exports.manageExecutionPosition(retryTrade,{ticker:'EURUSD',tf:'5',observedAtMs:q.timestampMs,quote:q,atr14:.0002},q.timestampMs,.7,retryBoundary));
assert.equal(retryTrade.executionState.partialConfirmed,false,'persistence failure cannot set partial latch');
rejectConfirmation=false;
await exports.manageExecutionPosition(retryTrade,{ticker:'EURUSD',tf:'5',observedAtMs:q.timestampMs,quote:q,atr14:.0002},q.timestampMs,.7,retryBoundary);
assert.equal(calls.filter(x=>x==='partial').length,countBefore+1,'persistence recovery must not duplicate broker partial');
assert.equal(retryTrade.executionState.partialConfirmed,true);
// Whole processTradingAlert body: root configuration controls NEW entries, not frozen positions.
const contextAt = Date.parse('2026-07-14T15:00:00Z');
const frozenPolicy = micro.resolveExecutionPolicy({ profile: 'microstructure_v1' });
const frozenPosition = { ticker: 'EURUSD', executionPolicy: frozenPolicy, executionState: { schema: 1, profile: 'microstructure_v1' } };
const contextStore: any = { tickerLocks: new Map(), globalKillswitches: {}, tickerLastSeen: new Map(), localRadarStates: new Map([['EURUSD', { zones: [], marketBias: {} }]]), activeTrades: new Map([['frozen', frozenPosition]]) };
let rootExperimental = true;
let contextIngestions = 0;
const contextApi: any = {};
vm.runInNewContext(ts.transpileModule(processNode.getFullText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: contextApi, db: {}, globalState: contextStore, ...context, ...micro,
    ingestExecutionContext: (...args: Parameters<typeof context.ingestExecutionContext>) => { contextIngestions++; return context.ingestExecutionContext(...args); },
    Date: class extends Date { static now() { return contextAt; } }, console: { log() {}, warn() {}, error() {} },
    parseTF: (v: string) => v+'M', getFxDayStartMs: () => contextAt, scheduleRawSignalSave() {},
    getConfigForTicker: () => ({ executionPolicy: rootExperimental ? { profile: 'microstructure_v1' } : undefined }),
    gcScore: () => { throw new Error('OFFLINE_STOP_AFTER_INGEST'); }
});
const observe = async (atMs: number) => {
    const observation: any = { schema: 1, ticker: 'EURUSD', tf: '5', observedAtMs: atMs,
        bar: { tf: '5', openTimeMs: atMs-300000, closeTimeMs: atMs, availableAtMs: atMs, open: 1.103, high: 1.104, low: 1.101, close: 1.103, closed: true } };
    await contextApi.processTradingAlert(context.appendExecutionEnvelope(`PING_PRICE | EURUSD | TF: 15 | Precio: 1.103 | TS: ${atMs}`, observation), contextStore);
};
// Seed real closed-bar ATR causally without traversing historical service-import paths.
for (let i = 15; i >= 1; i--) {
    const closedAt = contextAt-i*300000;
    const observation: any = { schema: 1, ticker: 'EURUSD', tf: '5', observedAtMs: closedAt,
        bar: { tf: '5', openTimeMs: closedAt-300000, closeTimeMs: closedAt, availableAtMs: closedAt, open: 1.103, high: 1.104, low: 1.101, close: 1.103, closed: true } };
    assert.equal(context.ingestExecutionContext(contextStore.localRadarStates.get('EURUSD'), observation, closedAt).accepted, true);
}
await observe(contextAt);
assert.equal(contextStore.localRadarStates.get('EURUSD').executionContext.lastObservedAtMs, contextAt);
assert.ok(context.getExecutionSnapshot(contextStore.localRadarStates.get('EURUSD'), '5', contextAt)?.atr14);
rootExperimental = false;
// Concurrent PINGs still pass through the production ticker lock and ingest each closed bar once.
await Promise.all([observe(contextAt+300000), observe(contextAt+600000)]);
assert.equal(contextStore.localRadarStates.get('EURUSD').executionContext.lastObservedAtMs, contextAt+600000, 'BUG_LIVE_ROOT_CONFIG_INTERRUPTS_FROZEN_CONTEXT');
const continuedSnapshot = context.getExecutionSnapshot(contextStore.localRadarStates.get('EURUSD'), '5', contextAt+600000);
assert.ok(continuedSnapshot?.atr14, 'frozen management keeps valid closed-bar ATR after root reverts to legacy');
assert.equal(continuedSnapshot.closedBar?.closeTimeMs, contextAt+600000);
assert.equal(rootExperimental, false, 'existing positions never reactivate the root entry profile');
assert.equal(frozenPosition.executionPolicy, frozenPolicy, 'do not replace frozen policy');
const ingestedBeforeNegatives = contextIngestions;
for (const position of [undefined,
    { ...frozenPosition, ticker: 'GBPUSD' }, { ...frozenPosition, isBacktest: true },
    { ...frozenPosition, executionPolicy: micro.resolveExecutionPolicy() },
    { ...frozenPosition, executionState: undefined },
    { ...frozenPosition, executionState: { schema: 1, profile: 'legacy_v1' } },
    { ...frozenPosition, executionPolicy: micro.resolveExecutionPolicy({ profile: 'microstructure_v1', management: false, trailing: false }) }
]) {
    contextStore.activeTrades.clear(); if (position) contextStore.activeTrades.set('negative', position);
    await observe(contextAt+900000);
}
assert.equal(contextIngestions, ingestedBeforeNegatives, 'pure legacy / unrelated / backtest / unversioned / no-management positions must not ingest EX1');
console.log('PASS BUG_LIVE_ROOT_CONFIG_INTERRUPTS_FROZEN_CONTEXT: whole alert, concurrent PINGs, root legacy, negative gates');
console.log('PASS live actual VM boundaries: immutable fill, partial/readback/persist retry, SL amend/readback, rollover PRE identity, legacy alert EX1 strip, routing and break vintage');
