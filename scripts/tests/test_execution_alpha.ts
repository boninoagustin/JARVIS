import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const path = 'src/engine/AlphaModel.ts';
const source = fs.readFileSync(path, 'utf8');
assert.match(source, /resolveExecutionPolicy\(config.executionPolicy\)/, 'actual Alpha caller must resolve the opt-in execution policy');
const micro = await import('../../src/engine/ExecutionMicrostructure.js');
const context = await import('../../src/engine/ExecutionContext.js');
const costs = await import('../../src/engine/ExecutionCosts.js');
const targets = await import('../../src/engine/tp2Cap.js');
const types = await import('../../src/engine/Types.js');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const stripped = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getFullText(ast)).join('\n');
const exports: any = {};
vm.runInNewContext(ts.transpileModule(stripped, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, console, process: { env: {} }, ...micro, ...context, ...costs, ...targets, ...types,
      telemetry: new Proxy({}, { get: () => () => {} }), mlPredict: () => null, isMLActive: () => false });
const now = 1_000_000_000;
const bar = { tf: '5', openTimeMs: now, closeTimeMs: now + 300_000, availableAtMs: now, open: 1.103, high: 1.104, low: 1.102, close: 1.103, closed: false };
const quote = { bid: 1.1029, ask: 1.103, timestampMs: now, source: 'broker' };
const state = exports.emptyState();
state.previousPrice = 100; // must not be treated as experimental candle open
state.executionContext = { schema: 1, ticker: 'EURUSD', byTf: { '5': { atrSeed: 0, atrSamples: 14, atr14: .003, currentBar: bar,
    lastClosedBar: { ...bar, openTimeMs: now - 600_000, closeTimeMs: now - 300_000, availableAtMs: now - 300_000, closed: true, high: 1.104, low: 1.101 } } }, quote, lastObservedAtMs: now };
const leg = () => ({ dir: 'BUY', origin: 1.100, extreme: 1.110, createdAt: now - 600_000, isValidated: true, chochPoints: 12, chochEvents: ['CHoCH_5M'],
    executionDecision: { mode: 'OTE_STANDARD', takeDirectNow: false, recommendedOtePrice: 1.104, recommendedOtePercent: 62, effectiveOtePercent: 60, requiresCloseConfirmation: false, reason: 'fixture_saved_decision' },
    executionSnapshot: { ticker: 'EURUSD', tf: '5', observedAtMs: now - 1000 }, executionDecisionAtMs: now - 1000 });
const cfg = { entryTrigger: 'SMART', oteEntryPercent: 1, slBufferPercent: 0, fixedRR: 2, executionPolicy: { profile: 'microstructure_v1', smart: true, targets: false } };
const evaluate = (l: any, config = cfg) => { state.scoreBuy.events = []; state.scoreBuy.points = 0; return exports.evaluateImpulseCore(l, 1.103, 1.120, .9, 'EURUSD', state, now, { config, currentSession: 'NY' }); };
let result = evaluate(leg());
assert.equal(result.triggerOte, true, 'saved OTE price + actual current OHLC must trigger despite unrelated old extreme input');
assert.equal(result.newTrade.entryPrice, quote.ask, 'BUY candidate fill is current ask, not the retracement limit');
assert.equal(result.oteData.executionTouchPrice, quote.ask);
state.executionContext.quote = { ...quote, ask: 1.106, bid: 1.1059 };
assert.equal(evaluate(leg()).triggerOte, undefined, 'old bar lows cannot trigger when current ask is away');
state.executionContext.quote = quote;
const adverse = leg(); adverse.executionDecision.requiresCloseConfirmation = true;
assert.equal(evaluate(adverse).triggerOte, undefined, 'broken bar / old close cannot confirm adverse arrival');
state.executionContext.byTf['5'].lastClosedBar = { ...bar, openTimeMs: now - 300_000, closed: true, closeTimeMs: now, availableAtMs: now };
assert.equal(evaluate(adverse).triggerOte, true, 'subsequent available closed bar confirms arrival');
delete state.executionContext.quote;
assert.equal(evaluate(leg()).triggerOte, undefined, 'missing executable quote fails closed');
state.executionContext.quote = quote;
state.executionContext.byTf['5'].currentBar = { ...bar, openTimeMs: now, closeTimeMs: now+300000, high:1.102, low:1.104 };
assert.equal(evaluate(leg()).triggerOte, undefined, 'invalid current OHLC geometry must fail closed');
state.executionContext.byTf['5'].currentBar = { ...bar, openTimeMs:now,closeTimeMs:now+300000,open:1.102,low:1.102,close:1.1021 };
state.executionContext.quote = {...quote,ask:1.1035,bid:1.1034};
assert.equal(evaluate(leg()).triggerOte,undefined,'candle quality uses full actual OHLC close, not the execution quote');
state.executionContext.quote = quote;
state.executionContext.byTf['5'].currentBar = { ...bar, openTimeMs:now,closeTimeMs:now+300000 };
const missingInstrumentLeg: ReturnType<typeof leg> & {oteScored?:boolean}=leg();
assert.equal(evaluate(missingInstrumentLeg,{...cfg,executionPolicy:{...cfg.executionPolicy,targets:true}}).triggerOte,undefined);
assert.notEqual(missingInstrumentLeg.oteScored,true,'WAIT_DATA target metadata must not consume the OTE setup');
// Closed-only historical EX1 format: no forming bar, real Wilder ATR, explicit modeled quote.
const originalContext = state.executionContext;
for (let i=0;i<15;i++) {
    const openTimeMs = now - (15-i)*300_000;
    const closed = { ...bar, openTimeMs, closeTimeMs:openTimeMs+300_000, availableAtMs:openTimeMs+300_000, closed:true };
    if(i===0) delete state.executionContext;
    const o=context.buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:closed.availableAtMs,bar:closed});
    assert.equal(context.ingestExecutionContext(state,o,closed.availableAtMs).accepted,true);
}
state.executionContext.quote={...quote,source:'modeled'};
assert.equal(context.getExecutionSnapshot(state,'5',now)?.bar?.closed,true);
assert.ok(context.getExecutionSnapshot(state,'5',now)!.atr14!>0);
result=evaluate(leg());
assert.equal(result.triggerOte,true,'closed-only historical bar must not overlap itself as its own predecessor');
assert.equal(result.newTrade.entryPrice,quote.ask,'historical BUY fills only at explicit current modeled ask');
state.executionContext.quote={...quote,source:'modeled',ask:1.106,bid:1.1059};
assert.equal(evaluate(leg()).triggerOte,undefined,'closed historical low is not an executable touch');
const stretchLeg=leg();stretchLeg.extreme=1.1038;
evaluate(stretchLeg,{...cfg,executionPolicy:{...cfg.executionPolicy,smart:false}});
assert.equal(stretchLeg.extreme,1.104,'closed-only non-SMART stretch uses the genuine latest closed high');
const savedLeg=leg();evaluate(savedLeg);
assert.equal(savedLeg.extreme,1.110,'saved SMART geometry must not be stretched by historical extrema');
state.executionContext.byTf['5'].lastClosedBar.high=1.101;
assert.equal(evaluate(leg()).triggerOte,undefined,'closed-only OHLC still validates instead of pretending to be forming');
state.executionContext=JSON.parse(JSON.stringify(originalContext));
state.executionContext.byTf['5'].currentBar={...bar,openTimeMs:now-100_000,closeTimeMs:now+200_000};
state.executionContext.byTf['5'].lastClosedBar={...bar,openTimeMs:now-300_000,closeTimeMs:now,availableAtMs:now,closed:true};
assert.equal(evaluate(leg()).triggerOte,undefined,'distinct-time predecessor overlapping current bar must still reject');
state.executionContext=originalContext;
// PRE behavioral comparison runs the real archived caller, not a duplicated model.
const preSource = fs.readFileSync('/tmp/jarvis-execution-verification/C-PRE-AlphaModel.ts', 'utf8');
const preAst = ts.createSourceFile(path, preSource, ts.ScriptTarget.Latest, true);
const preExports: any = {};
vm.runInNewContext(ts.transpileModule(preAst.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getFullText(preAst)).join('\n'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: preExports, console, process: { env: {} }, ...types, telemetry: new Proxy({}, { get: () => () => {} }), mlPredict: () => null, isMLActive: () => false });
const canonical = (value: any) => JSON.parse(JSON.stringify(value, (key, v) => key === 'tradeId' ? 'DETERMINISTIC_ID' : v));
let parityCases = 0;
for (const direction of ['BUY','SELL']) for (const entryTrigger of ['OTE','SMART','BOTH','CHOCH']) for (const depth of [38.2,50,62,79]) {
    const makeState = () => { const s = preExports.emptyState(); s.atr14 = .003; s.previousPrice = 1.104; return s; };
    const makeLeg = () => ({ dir: direction, origin: direction==='BUY'?1.1:1.11, extreme: direction==='BUY'?1.11:1.1,
        createdAt: now-600000, chochEvents:['CHoCH_5M'], chochPoints:12, isValidated:true });
    const config = { entryTrigger, oteEntryPercent:depth, slBufferPercent:0, fixedRR:2 };
    const old = preExports.evaluateImpulseCore(makeLeg(),1.105,1.106,1.104,'EURUSD',makeState(),now,{ config,currentSession:'NY' });
    const next = exports.evaluateImpulseCore(makeLeg(),1.105,1.106,1.104,'EURUSD',makeState(),now,{ config,currentSession:'NY' });
    assert.deepEqual(canonical(next), canonical(old), `legacy parity ${direction}/${entryTrigger}/${depth}`);
    parityCases++;
}
console.log(`PASS Alpha actual VM caller: saved depth, real OHLC/open, executable fill, no stale touch, subsequent close, missing quote; PRE legacy parity ${parityCases} cases`);
