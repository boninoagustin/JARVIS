import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as contextApi from '../../src/engine/ExecutionContext.js';
import * as executionMath from '../../src/engine/ExecutionMicrostructure.js';
import * as executionCosts from '../../src/engine/ExecutionCosts.js';
import { getAdrPrice, capTp2Price } from '../../src/engine/tp2Cap.js';
import { classifyExecutionRegime, validateExecutionInstrument } from '../../src/engine/ExecutionCosts.js';
import { appendExecutionEnvelope, parseExecutionEnvelope, buildExecutionObservation, ingestExecutionContext, getExecutionSnapshot } from '../../src/engine/ExecutionContext.js';
import type { ExecutionBar } from '../../src/engine/ExecutionTypes.js';
import type { RadarState } from '../../src/engine/Types.js';
const step = 300000, start = 1700000100000;
function bar(i:number, close=100):ExecutionBar { return {tf:'5',openTimeMs:start+i*step,closeTimeMs:start+(i+1)*step,availableAtMs:start+(i+1)*step,open:100,high:102,low:99,close,closed:true}; }
const legacy='PING_PRICE | EURUSD | TF: 15 | Precio: 100 | TS: 1700001000000 🧪';
const obs=buildExecutionObservation({ticker:'EURUSD',tf:'M5',observedAtMs:bar(0).closeTimeMs,bar:bar(0)});
const encoded=appendExecutionEnvelope(legacy,obs);
assert.equal(parseExecutionEnvelope(encoded,obs.observedAtMs).text,legacy);
assert.deepEqual(parseExecutionEnvelope(encoded,obs.observedAtMs).observation,obs);
assert.equal(obs.tf,'5');
assert.equal(parseExecutionEnvelope(legacy,obs.observedAtMs).text,legacy);
console.log('PASS EX1 portable Unicode roundtrip and legacy identity');
const state={} as RadarState;
for(let i=1;i<=14;i++) {
 const current=bar(i); const observation=buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:current.closeTimeMs,previousClosedBar:bar(i-1),bar:current});
 assert.equal(ingestExecutionContext(state,observation,current.closeTimeMs).accepted,true);
 if(i<14) assert.equal(getExecutionSnapshot(state,'5',current.closeTimeMs)?.atr14,undefined);
}
const last=bar(14), now=last.closeTimeMs;
assert.equal(getExecutionSnapshot(state,'M5',now)?.atr14,3);
const saved=JSON.stringify(state);
assert.equal(ingestExecutionContext(state,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:now,bar:last}),now).accepted,true);
assert.equal(JSON.stringify(state),saved);
const conflict=buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:now,bar:{...last,close:101},quote:{bid:100,ask:101,timestampMs:now,source:'broker'}});
assert.equal(ingestExecutionContext(state,conflict,now).accepted,false);
assert.equal(JSON.stringify(state),saved,'conflict must be atomic');
assert.equal(getExecutionSnapshot(state,'15',now),undefined);
assert.equal(getExecutionSnapshot(state,'5',now+step*3),undefined);
const gap={...bar(15),open:110,high:112,low:109,close:110};
assert.equal(ingestExecutionContext(state,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:gap.closeTimeMs,bar:gap}),gap.closeTimeMs).accepted,true);
assert.equal(getExecutionSnapshot(state,'5',gap.closeTimeMs)?.atr14,(13*3+12)/14);
console.log('PASS actual previous close TR, Wilder14, duplicate atomicity, explicit TF and stale guard');
// Finite OHLC does not imply a finite accumulated seed. Check the raw state,
// before JSON could hide Infinity as null, and preserve the entire old object.
function assertFiniteNumbers(value:unknown):void {
 if(typeof value==='number') assert.ok(Number.isFinite(value),`persisted nonfinite number: ${value}`);
 else if(value && typeof value==='object') for(const v of Object.values(value)) assertFiniteNumbers(v);
}
function hugeBar(k:number):ExecutionBar {
 return {tf:'5',openTimeMs:k*step,closeTimeMs:(k+1)*step,availableAtMs:(k+1)*step,open:1,high:1e308,low:1,close:1,closed:true};
}
const hugeState={} as RadarState;
let seedRejections=0;
for(let k=0;k<=15;k++) {
 const b=hugeBar(k), before=hugeState.executionContext, savedBefore=JSON.stringify(before);
 const result=ingestExecutionContext(hugeState,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:b.availableAtMs,bar:b,quote:{bid:1,ask:2,timestampMs:b.availableAtMs,source:'modeled'}}),b.availableAtMs);
 assertFiniteNumbers(hugeState.executionContext);
 if(!result.accepted) {
  seedRejections++;
  assert.match(result.reason,/nonfinite_atr/);
  assert.equal(hugeState.executionContext,before,'seed overflow must keep the old object');
  assert.equal(JSON.stringify(hugeState.executionContext),savedBefore,'seed overflow rolls back quote, bar, fingerprints and counters');
 }
 const atr=getExecutionSnapshot(hugeState,'5',b.availableAtMs)?.atr14;
 assert.ok(atr===undefined || Math.abs(atr/1e308-1)<1e-12,`never publish a finite wrong ATR: ${atr}`);
}
assert.ok(seedRejections>0,'sum-based ATR must fail closed on overflow');
const seedBatch={} as RadarState;
const hugeFirst=hugeBar(0), hugeThird=hugeBar(2);
ingestExecutionContext(seedBatch,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:hugeFirst.availableAtMs,bar:hugeFirst}),hugeFirst.availableAtMs);
const seedBatchBefore=seedBatch.executionContext, seedBatchSaved=JSON.stringify(seedBatch);
assert.equal(ingestExecutionContext(seedBatch,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:hugeThird.availableAtMs,previousClosedBar:hugeBar(1),bar:hugeThird,quote:{bid:1,ask:2,timestampMs:hugeThird.availableAtMs,source:'modeled'}}),hugeThird.availableAtMs).accepted,false);
assert.equal(seedBatch.executionContext,seedBatchBefore);
assert.equal(JSON.stringify(seedBatch),seedBatchSaved,'second close overflow rolls back the first close in the same observation');
console.log('PASS 16 extreme finite closed bars: seed overflow rejected atomically, including batched closes');
for(const batched of [false,true]) {
 const recurrenceState={} as RadarState;
 for(let k=0;k<=14;k++) {
  const b=bar(k);
  assert.equal(ingestExecutionContext(recurrenceState,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:b.availableAtMs,bar:b}),b.availableAtMs).accepted,true);
 }
 assert.equal(getExecutionSnapshot(recurrenceState,'5',bar(14).availableAtMs)?.atr14,3);
 const firstLarge={...bar(15),open:1,high:1e308,low:1,close:1}, secondLarge={...bar(16),open:1,high:1e308,low:1,close:1};
 if(!batched) {
  assert.equal(ingestExecutionContext(recurrenceState,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:firstLarge.availableAtMs,bar:firstLarge}),firstLarge.availableAtMs).accepted,true);
  assert.equal(getExecutionSnapshot(recurrenceState,'5',firstLarge.availableAtMs)?.atr14,1e308/14);
 }
 const before=recurrenceState.executionContext, savedBefore=JSON.stringify(recurrenceState);
 const result=ingestExecutionContext(recurrenceState,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:secondLarge.availableAtMs,...(batched?{previousClosedBar:firstLarge}:{}),bar:secondLarge,quote:{bid:1,ask:2,timestampMs:secondLarge.availableAtMs,source:'modeled'}}),secondLarge.availableAtMs);
 assert.equal(result.accepted,false,'overflow of 13*ATR+TR must reject, including when both terms are finite');
 assert.equal(result.reason,'nonfinite_atr_recurrence');
 assert.equal(recurrenceState.executionContext,before);
 assert.equal(JSON.stringify(recurrenceState),savedBefore,'recurrence overflow rolls back all closes and quote updates');
 assertFiniteNumbers(recurrenceState.executionContext);
}
console.log('PASS recurrence numerator overflow rejects atomically, sequential and batched');
for(const invalidAtr of [
 {atrSeed:Infinity},{atrSeed:NaN},{atrSeed:null},{atrSeed:-1},
 {atr14:Infinity},{atr14:NaN},{atr14:null},{atr14:undefined},
 {atrSamples:null},{atrSamples:15},{atrSamples:-1},{previousClose:null},
]) {
 const corrupted=structuredClone(state), stored=corrupted.executionContext!.byTf['5'];
 Object.assign(stored,invalidAtr);
 assert.equal(getExecutionSnapshot(corrupted,'5',gap.availableAtMs),undefined,'invalid persisted ATR state must not publish a snapshot');
 const old=corrupted.executionContext, before=structuredClone(corrupted);
 const next=bar(16);
 const result=ingestExecutionContext(corrupted,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:next.availableAtMs,bar:next,quote:{bid:100,ask:101,timestampMs:next.availableAtMs,source:'modeled'}}),next.availableAtMs);
 assert.equal(result.accepted,false,`never coerce persisted bad ATR fields: ${JSON.stringify(invalidAtr)}`);
 assert.equal(result.reason,'invalid_atr_state');
 assert.equal(corrupted.executionContext,old);
 assert.deepEqual(corrupted,before,'invalid persisted ATR state must remain untouched, not repaired/coerced');
}
const corruptedQuote=structuredClone(state);
corruptedQuote.executionContext!.quote={bid:100,ask:Infinity,timestampMs:now,source:'modeled'};
const corruptedBefore=structuredClone(corruptedQuote), corruptedRef=corruptedQuote.executionContext;
const corruptResult=ingestExecutionContext(corruptedQuote,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:bar(16).availableAtMs,bar:bar(16)}),bar(16).availableAtMs);
assert.equal(corruptResult.accepted,false,'JSON copy must reject any pre-existing nonfinite number, never coerce it to null');
assert.equal(corruptResult.reason,'nonfinite_execution_context');
assert.equal(corruptedQuote.executionContext,corruptedRef);
assert.deepEqual(corruptedQuote,corruptedBefore);
console.log('PASS invalid persisted seed/ATR/counters reject without null coercion or mutation');
// Execute the actual bridge source, replacing imports only (never services).
function bridgeHarness(source:string) {
 const sf=ts.createSourceFile('bridge.ts',source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
 const body=sf.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getFullText(sf)).join('\n');
 const code=ts.transpileModule(body+'\n;globalThis.hooks={handleSpotTick,handleEngineEvents,buildSyncAlert,heartbeatTick};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const messages:string[]=[];
 const sandbox:any={...contextApi,exports:{},Date:class extends Date {static now(){return now;}},process:{env:{}},console,fetch:()=>Promise.resolve(),setTimeout:()=>0,clearTimeout:()=>{},AbortController,smcManager:{getEngines:()=>new Map(),getEngine:()=>({getState:()=>({})})}};
 vm.runInNewContext(code,sandbox);
 return {hooks:sandbox.hooks,messages,send:async(text:string)=>{messages.push(text);}};
}
const source=fs.readFileSync(new URL('../../src/engine/smc/SMCBridge.ts',import.meta.url),'utf8');
const live=bridgeHarness(source);
const candle={timestamp:now,open:100,high:102,low:99,close:101,volume:4};
live.hooks.handleSpotTick(live.send,'EURUSD',candle,{...candle,timestamp:candle.timestamp-step},'M5');
const ping=parseExecutionEnvelope(live.messages[0],now);
assert.equal(ping.observation?.tf,'5','spot context must use actual source TF, not legacy TF15');
assert.equal(ping.text,`PING_PRICE | EURUSD | TF: 15 | Precio: 101 | High: 102 | Low: 99 | PrevHigh: 102 | PrevLow: 99 | TS: ${now}`);
assert.equal(ping.observation?.bar?.open,100);
assert.equal(ping.observation?.bar?.closed,false);
assert.equal(ping.observation?.previousClosedBar?.closed,true);
live.hooks.handleEngineEvents(live.send,'EURUSD:M5',{...candle,timestamp:now-step},[{type:'EVENT_BOS',direction:'Bullish',origin:99}],false);
const bos=parseExecutionEnvelope(live.messages[1],now);
assert.equal(bos.observation?.breakBar?.closed,true);
assert.equal(bos.observation?.impulse?.origin,99);
assert.equal(bos.observation?.fvgs,undefined,'no causal impulse linkage in source means omit FVG');
console.log('PASS actual bridge native source TF/OHLC, causal closed break and unchanged legacy text');
// Producer -> EX1 -> persisted context -> actual live setup adapter. No service imports.
const nativeState={zones:[],marketBias:{}} as unknown as RadarState;
for(let k=0;k<14;k++) {
 const b=bar(k);
 assert.equal(ingestExecutionContext(nativeState,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:b.availableAtMs,bar:b}),b.availableAtMs).accepted,true);
}
assert.ok(bos.observation);
assert.equal(ingestExecutionContext(nativeState,bos.observation,now).accepted,true);
const nativeSnapshot=getExecutionSnapshot(nativeState,'5',now)!;
assert.equal(nativeSnapshot.impulse?.createdAtMs,now,'native creation is event observation, not bar start');
assert.ok(nativeSnapshot.breakBar!.openTimeMs<nativeSnapshot.impulse!.createdAtMs);
assert.equal(nativeSnapshot.breakBar?.openTimeMs,nativeSnapshot.closedBar?.openTimeMs);
assert.equal(nativeSnapshot.atr14,3);
const tradingFile=ts.createSourceFile('trading.ts',fs.readFileSync(new URL('../../src/db/trading.ts',import.meta.url),'utf8'),ts.ScriptTarget.ES2022,true);
const routeDecl=tradingFile.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='routeExecutionSetup');
assert.ok(routeDecl,'must execute the real routeExecutionSetup');
const routingSandbox:any={exports:{},...contextApi,...executionMath,...executionCosts,getAdrPrice,capTp2Price};
vm.runInNewContext(ts.transpileModule(routeDecl.getText(tradingFile)+'\n;globalThis.route=routeExecutionSetup;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,routingSandbox);
const nativeLeg:any={dir:'BUY',origin:nativeSnapshot.impulse!.origin,extreme:nativeSnapshot.impulse!.extreme,createdAt:nativeSnapshot.impulse!.createdAtMs,executionSnapshot:nativeSnapshot};
const nativeDecision=routingSandbox.route(nativeState,nativeLeg,{executionPolicy:{profile:'microstructure_v1',targets:false}},'5',now,101,100,103);
assert.equal(nativeDecision.mode,'OTE_STANDARD',`native closed event must reach the real policy: ${JSON.stringify(nativeDecision)}`);
assert.equal(nativeDecision.reason,'STANDARD_FIB_NO_DIRECT_EVIDENCE');
assert.equal(nativeLeg.executionSnapshot.impulse.createdAtMs,now,'never rewrite event identity to get past the router');
const nativeBefore=JSON.stringify(nativeState);
for(const bad of [
 {...bos.observation,observedAtMs:now+1},
 {...bos.observation,impulse:{...bos.observation.impulse!,createdAtMs:now+1}},
 {...bos.observation,breakBar:{...bos.observation.breakBar!,availableAtMs:now+1}},
]) {
 assert.equal(ingestExecutionContext(nativeState,bad,now).accepted,false);
 assert.equal(JSON.stringify(nativeState),nativeBefore,'future native metadata must roll back');
}
assert.equal(routingSandbox.route(nativeState,{...nativeLeg},{executionPolicy:{profile:'microstructure_v1',targets:false}},'5',now-1,101,100,103).mode,'WAIT_DATA');
const futureImpulse=executionMath.evaluateSmartEntryRouting({ticker:'EURUSD',direction:'BUY',nowMs:now,currentPrice:101,originPrice:99,extremePrice:101,riskDist:1,atr14:3,impulseCreatedAtMs:now+1,breakBar:nativeSnapshot.breakBar,plannedTp2Price:103});
assert.equal(futureImpulse.mode,'WAIT_DATA');
console.log('PASS actual native bridge -> EX1 -> context -> real route: observed event identity accepted, future data rejected');
const causal={} as RadarState;
const firstBreak=buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:bar(1).closeTimeMs,bar:bar(1),previousClosedBar:bar(0),breakBar:bar(1)});
ingestExecutionContext(causal,firstBreak,firstBreak.observedAtMs);
assert.equal(getExecutionSnapshot(causal,'5',firstBreak.observedAtMs)?.breakBar?.openTimeMs,bar(1).openTimeMs);
ingestExecutionContext(causal,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:bar(2).closeTimeMs,bar:bar(2)}),bar(2).closeTimeMs);
assert.equal(getExecutionSnapshot(causal,'5',bar(2).closeTimeMs)?.breakBar,undefined,'never normalize historic break with a later ATR');
console.log('PASS breakBar only at same closed-bar ATR vintage');
// cTrader boundary: AST-select actual functions/cache declarations, no module import.
const ctSource=fs.readFileSync(new URL('../../src/services/ctrader.ts',import.meta.url),'utf8');
const ctFile=ts.createSourceFile('ctrader.ts',ctSource,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
const ctNames=new Set(['clearSubscriptionState','executionSymbolMetadata','executionAssetNames','executionExitCosts','cacheExecutionSymbol','captureExecutionExitCosts','executionUsdRate','getLiveExecutionInstrument']);
const selected=ctFile.statements.filter(n=>ts.isFunctionDeclaration(n)?ctNames.has(n.name?.text??''):ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&ctNames.has(d.name.text))).map(n=>n.getFullText(ctFile)).join('\n');
const ctCode=ts.transpileModule(selected+'\n;globalThis.ctHooks={getLiveExecutionInstrument,captureExecutionExitCosts,cacheExecutionSymbol,executionAssetNames,clearSubscriptionState};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const quotes=new Map([['XAGUSD',{bid:30,ask:30.01,ts:now}],['USDJPY',{bid:150,ask:150.01,ts:now}],['EURJPY',{bid:160,ask:160.02,ts:now}]]);
const ctSandbox:any={exports:{},Date:class extends Date{static now(){return now;}},executionAccountCurrencyVerified:true,accountCurrency:'USD',subscribedSymbols:new Map(),subscribedSpots:new Set(),subscribedTrendbars:new Set(),scannerProcessed:new Set(),ctClient:{symbols:{idToSymbol:new Map([[1,{baseAssetId:1,quoteAssetId:2}],[2,{baseAssetId:3,quoteAssetId:4}],[3,{baseAssetId:2,quoteAssetId:4}]])}},symbolToTicker:new Map([[1,'XAGUSD'],[2,'EURJPY'],[3,'USDJPY']]),getLastBidAsk:(ticker:string)=>quotes.get(ticker)??null,tickFlow:{getStructuralSpread:()=>0.01},classifyExecutionRegime,validateExecutionInstrument};
vm.runInNewContext(ctCode,ctSandbox);
const ct=ctSandbox.ctHooks;
ct.executionAssetNames.set(1,'XAG'); ct.executionAssetNames.set(2,'USD'); ct.executionAssetNames.set(3,'EUR'); ct.executionAssetNames.set(4,'JPY');
assert.equal(ct.getLiveExecutionInstrument('XAGUSD'),undefined);
ct.cacheExecutionSymbol('XAGUSD',{symbolId:1,digits:3,pipPosition:2,lotSize:500000,slDistance:10,distanceSetIn:1});
assert.equal(ct.getLiveExecutionInstrument('XAGUSD'),undefined,'absent observed exit costs cannot become zero');
ct.captureExecutionExitCosts({executionType:3,deal:{dealStatus:2,executionTimestamp:now,executionPrice:30,volume:500000,tradeSide:2,commission:-250,moneyDigits:2,closePositionDetail:{}},position:{tradeData:{symbolId:1}}});
const silver=ct.getLiveExecutionInstrument('XAGUSD');
assert.equal(silver?.pipValuePerLotUsd,50,'actual silver lot is 5000 oz, not universal $10');
assert.equal(silver?.commissionPerLotSideUsd,2.5);
assert.equal(silver?.minStopDistance,0.01);
assert.equal(silver?.source,'broker_metadata');
ct.cacheExecutionSymbol('EURJPY',{symbolId:2,digits:3,pipPosition:2,lotSize:10000000,slDistance:10,distanceSetIn:1});
ct.cacheExecutionSymbol('USDJPY',{symbolId:3,digits:3,pipPosition:2,lotSize:10000000,slDistance:10,distanceSetIn:1});
ct.captureExecutionExitCosts({executionType:3,deal:{dealStatus:2,executionTimestamp:now,executionPrice:160,volume:10000000,tradeSide:2,commission:-350,moneyDigits:2,closePositionDetail:{}},position:{tradeData:{symbolId:2}}});
assert.equal(ct.getLiveExecutionInstrument('EURJPY')?.pipValuePerLotUsd,1000/150);
quotes.delete('USDJPY');
assert.equal(ct.getLiveExecutionInstrument('EURJPY'),undefined,'no cached FX conversion, no fabricated pip USD value');
console.log('PASS actual cTrader cached silver/JPY unit conversion and fail-closed missing costs/FX');
assert.match(ctSource,/spotTickListener\?\.\(baseTicker, lastCandle, prevCandle \?\? undefined, periodStr\)/);
console.log('PASS cTrader source period passes through optional fourth listener argument');
// Adverse native data cannot be upgraded to execution evidence.
live.hooks.handleEngineEvents(live.send,'EURUSD:M5',{...candle,timestamp:now-step},[{type:'EVENT_CHOCH',direction:'Bearish',origin:103,breakTimestamp:now-step*2}],false);
const delayed=parseExecutionEnvelope(live.messages[2],now);
assert.equal(delayed.observation?.breakBar,undefined,'delayed break has no OHLC vintage at current candle');
assert.equal(delayed.observation?.impulse,undefined,'do not attach current-candle geometry to delayed break');
assert.throws(()=>buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:now,bar:{...bar(14),closed:false,availableAtMs:now}}),/forming/);
console.log('PASS delayed native breaks and expired forming bars fail closed');
ctSandbox.accountCurrency=null;
ct.captureExecutionExitCosts({deal:{dealStatus:2,executionTimestamp:now,executionPrice:30,volume:500000,tradeSide:2,commission:-9999,moneyDigits:2,closePositionDetail:{}},position:{tradeData:{symbolId:1}}});
assert.equal(ct.getLiveExecutionInstrument('XAGUSD'),undefined,'unverified deposit currency must never acquire fallback USD authority');
console.log('PASS unverified account currency fails closed');
assert.equal(bos.observation?.impulse?.extreme,candle.close,'native impulse uses the signal close, matching the real leg caller');
ctSandbox.accountCurrency='USD';
assert.ok(ct.getLiveExecutionInstrument('XAGUSD'));
ct.clearSubscriptionState();
assert.equal(ct.getLiveExecutionInstrument('XAGUSD'),undefined,'disconnect invalidates cached broker metadata');
console.log('PASS disconnect cannot reuse metadata from a previous broker connection');
// Invalid transports always strip the suffix, even when context is rejected.
for (const suffix of ['', '!!!', 'A'.repeat(16385), 'e30', btoa(JSON.stringify({...obs,schema:2})).replace(/=+$/,'')]) {
 const parsed=parseExecutionEnvelope(legacy+' | EX1: '+suffix,now);
 assert.equal(parsed.text,legacy); assert.equal(parsed.observation,undefined); assert.ok(parsed.reason);
}
assert.equal(parseExecutionEnvelope(encoded,obs.observedAtMs-1).reason,'future_observation');
for (const invalid of [NaN,Infinity,0,-1]) assert.throws(()=>buildExecutionObservation({...obs,bar:{...bar(0),open:invalid}}));
assert.throws(()=>buildExecutionObservation({...obs,bar:{...bar(0),high:98}}),/ohlc/);
assert.throws(()=>buildExecutionObservation({...obs,bar:{...bar(0),tf:'15'}}),/timeframe/);
assert.throws(()=>buildExecutionObservation({...obs,bar:{...bar(0),availableAtMs:obs.observedAtMs+1}}),/availability/);
assert.throws(()=>buildExecutionObservation({...obs,quote:{bid:101,ask:100,timestampMs:obs.observedAtMs,source:'broker'}}),/quote/);
assert.throws(()=>buildExecutionObservation({...obs,quote:{bid:100,ask:101,timestampMs:obs.observedAtMs+1,source:'broker'}}),/quote/);
assert.throws(()=>buildExecutionObservation({...obs,fvgs:[{id:'wrong-leg',direction:'BUY',top:101,bottom:100,createdAtMs:obs.observedAtMs,availableAtMs:obs.observedAtMs,impulseCreatedAtMs:0,active:true,tf:'5'}]}),/unlinked/);
const older=JSON.stringify(state);
assert.equal(ingestExecutionContext(state,{...obs,observedAtMs:now,bar:{...bar(1),close:101}},now).reason,'conflicting_closed_bar');
assert.equal(JSON.stringify(state),older);
const untouched={} as RadarState;
assert.equal(ingestExecutionContext(untouched,{...obs,observedAtMs:now+1},now).accepted,false);
assert.equal(untouched.executionContext,undefined);
const formingState={} as RadarState;
const forming={...bar(15),closed:false,availableAtMs:now+1,open:100,high:1000,low:1,close:100};
ingestExecutionContext(formingState,buildExecutionObservation({ticker:'EURUSD',tf:'5',observedAtMs:now+1,bar:forming,previousClosedBar:bar(14)}),now+1);
assert.equal(getExecutionSnapshot(formingState,'5',now+1)?.atr14,undefined,'forming range cannot seed ATR');
console.log('PASS malformed/oversize/future/OHLC/quote/FVG data and closed-only ATR guards');

// No Buffer, process, require, or Node codec: execute the pure module in a browser-like VM.
const contextSource=fs.readFileSync(new URL('../../src/engine/ExecutionContext.ts',import.meta.url),'utf8');
const browser:any={exports:{},TextEncoder,TextDecoder,btoa,atob};
vm.runInNewContext(ts.transpileModule(contextSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,browser);
const browserLine=browser.exports.appendExecutionEnvelope(legacy,obs);
assert.equal(browser.exports.parseExecutionEnvelope(browserLine,now).text,legacy);
assert.equal(browser.exports.parseExecutionEnvelope(browserLine,now).observation.tf,'5');
console.log('PASS browser-like codec VM without Node globals or imports');
const utfObservation=buildExecutionObservation({...obs,impulse:{direction:'BUY',origin:99,extreme:102,createdAtMs:obs.observedAtMs},fvgs:[{id:'Δ-🧪',direction:'BUY',top:101,bottom:100,createdAtMs:obs.observedAtMs,availableAtMs:obs.observedAtMs,impulseCreatedAtMs:obs.observedAtMs,active:true,tf:'5'}]});
assert.equal(browser.exports.parseExecutionEnvelope(browser.exports.appendExecutionEnvelope(legacy,utfObservation),now).observation.fvgs[0].id,'Δ-🧪');
assert.throws(()=>appendExecutionEnvelope(legacy,{...utfObservation,fvgs:Array.from({length:100},()=>({...utfObservation.fvgs![0],id:'x'.repeat(128)}))}),/too_large/);
console.log('PASS UTF8 JSON payload and outgoing 16KB size guard');

const preBridge=process.env.JARVIS_EXECUTION_PRE_BRIDGE;
if (preBridge) {
 const before=bridgeHarness(fs.readFileSync(preBridge,'utf8')), after=bridgeHarness(source);
 const fixtures=[
  {type:'EVENT_CHOCH',direction:'Bullish',origin:99}, {type:'EVENT_BOS',direction:'Bearish',origin:103},
  {type:'EVENT_SWEEP',direction:'Bullish',sweepType:'LIQ_GRAB',price:100}, {type:'EVENT_SWEEP',direction:'Bearish',sweepType:'CRT',price:100},
  {type:'EVENT_DIVERGENCE',direction:'Bullish'}, {type:'ZONE_TOUCHED',direction:'Bullish',medal:'Oro',score:4,top:102,bottom:99},
  {type:'ZONE_BROKEN',direction:'Bearish',medal:'Plata',score:3,top:102,bottom:99}, {type:'EVENT_OB_CREATED',ob:{}}
 ];
 for (const h of [before,after]) {
  for (const period of ['M5','M15','H1','H4','D1','W1']) {
   const durations:any={M5:step,M15:900000,H1:3600000,H4:14400000,D1:86400000,W1:604800000};
   const closed={...candle,timestamp:now-durations[period]};
   h.hooks.handleEngineEvents(h.send,`EURUSD:${period}`,closed,fixtures,false);
   h.hooks.handleEngineEvents(h.send,`EURUSD:${period}`,closed,fixtures,true);
  }
  h.hooks.handleSpotTick(h.send,'EURUSD',candle,{...candle,timestamp:now-step},'M5');
  h.hooks.handleSpotTick(h.send,'EURUSD',candle,undefined,'H1'); // same-ticker throttle remains unchanged
  assert.equal(h.hooks.buildSyncAlert('EURUSD','M15'),null);
  h.hooks.heartbeatTick(h.send);
 }
 assert.deepEqual(after.messages.map(line=>parseExecutionEnvelope(line,now).text),before.messages);
 console.log(`PASS PRE/native exact legacy bytes and event density: ${before.messages.length} messages`);
}
const preCtrader=process.env.JARVIS_EXECUTION_PRE_CTRADER;
if (preCtrader) {
 const oldFile=ts.createSourceFile('old.ts',fs.readFileSync(preCtrader,'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
 const names=['getLotSizeCents','isIndexTicker','calculateLotSize','executeMarketOrder','modifyStopLoss','closePosition','readPositionProtection','closePartial','ingestSpotQuote','getLastBidAsk','subscribeToLiveTrendbars','getHistoricalCandles'];
 for (const name of names) {
  const get=(file:ts.SourceFile)=>file.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)?.getText(file);
  assert.equal(get(ctFile),get(oldFile),`legacy cTrader function changed: ${name}`);
 }
 console.log(`PASS PRE exact cTrader legacy execution/quote/rollover functions: ${names.length}`);
}
