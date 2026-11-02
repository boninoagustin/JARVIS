import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionInstrument, ExecutionPositionState, SmartRoutingInput } from '../../src/engine/ExecutionTypes.ts';
import * as executionMath from '../../src/engine/ExecutionMicrostructure.ts';
// Runtime-invalid fixtures intentionally cross the typed boundary.
const math:any=executionMath;
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const instrument:ExecutionInstrument={ticker:'EURUSD',regime:'FOREX',pipSize:.01,tickSize:.01,pipValuePerLotUsd:10,baseSpreadPips:1,exitSlippagePips:.2,commissionPerLotSideUsd:3,minStopDistance:0,source:'explicit_model'};
const quote={bid:102,ask:102.01,timestampMs:1000000,source:'modeled' as const};
const routing:SmartRoutingInput={ticker:'EURUSD',direction:'BUY',nowMs:900000,currentPrice:109,originPrice:100,extremePrice:110,riskDist:1,atr14:1,impulseCreatedAtMs:0,plannedTp2Price:111,breakBar:{tf:'15',openTimeMs:0,closeTimeMs:900000,availableAtMs:900000,open:100,low:100,high:110,close:109,closed:true},tickActivity:{ratio:1,direction:'UP',sampleCount:20,timestampMs:900000,source:'broker_ticks'}};

test('SMART direct requires real closed displacement, actual gross room and measured fresh ticks',()=>{
  assert.equal(typeof math.evaluateSmartEntryRouting,'function');
  assert.equal(math.evaluateSmartEntryRouting(routing).mode,'DIRECT');
  assert.equal(math.evaluateSmartEntryRouting({...routing,plannedTp2Price:110.5}).mode,'DIRECT');
  for(const input of [
    {...routing,tickActivity:undefined}, {...routing,tickActivity:{...routing.tickActivity!,sampleCount:19}},
    {...routing,tickActivity:{...routing.tickActivity!,timestampMs:889999}},
    {...routing,tickActivity:{...routing.tickActivity!,timestampMs:900001}},
    {...routing,tickActivity:{...routing.tickActivity!,source:'alerts'}},
    {...routing,plannedTp2Price:undefined},{...routing,plannedTp2Price:110.49},
    {...routing,rewardToOppositeZone:1},{...routing,breakBar:{...routing.breakBar!,open:109.5}},
  ]) { const r=math.evaluateSmartEntryRouting(input); assert.notEqual(r.mode,'DIRECT'); assert.equal(r.takeDirectNow,false); }
  for(const bad of [{atr14:undefined},{atr14:NaN},{atr14:0},{riskDist:Infinity},{riskDist:0},{originPrice:110},{extremePrice:99},{currentPrice:NaN},{breakBar:undefined},{breakBar:{...routing.breakBar!,closed:false}},{breakBar:{...routing.breakBar!,tf:'H1'}},{breakBar:{...routing.breakBar!,high:NaN}},{breakBar:{...routing.breakBar!,availableAtMs:900001}},{breakBar:{...routing.breakBar!,closeTimeMs:800000}}]) {
    const r=math.evaluateSmartEntryRouting({...routing,...bad}); assert.equal(r.mode,'WAIT_DATA'); assert.ok(r.reason);
  }
  const sell={...routing,direction:'SELL',currentPrice:101,originPrice:110,extremePrice:100,plannedTp2Price:99,breakBar:{...routing.breakBar!,open:110,close:101},tickActivity:{...routing.tickActivity!,direction:'DOWN'}};
  assert.equal(math.evaluateSmartEntryRouting(sell).mode,'DIRECT');
  const fallback=math.evaluateSmartEntryRouting({...routing,tickActivity:undefined}); assert.equal(fallback.mode,'OTE_STANDARD'); near(fallback.recommendedOtePrice,103.8);
});

test('SMART rejects explicit unfavorable TP2 even with enough opposite-zone room',()=>{
  for(const direction of ['BUY','SELL'] as const) {
    const input=direction==='BUY'?routing:{...routing,direction,currentPrice:101,originPrice:110,extremePrice:100,plannedTp2Price:99,breakBar:{...routing.breakBar!,open:110,close:101},tickActivity:{...routing.tickActivity!,direction:'DOWN' as const}};
    assert.equal(math.evaluateSmartEntryRouting({...input,rewardToOppositeZone:2}).mode,'DIRECT','favorable control must reach DIRECT');
    for(const plannedTp2Price of [input.currentPrice,input.currentPrice+(direction==='BUY'?-1:1)]) {
      const decision=math.evaluateSmartEntryRouting({...input,plannedTp2Price,rewardToOppositeZone:2});
      assert.equal(decision.mode,'WAIT_DATA',`${direction} invalid TP2 must not be omitted: ${JSON.stringify(decision)}`);
      assert.equal(decision.takeDirectNow,false);
      assert.equal(decision.reason,'UNFAVORABLE_PLANNED_TP2');
    }
    for(const plannedTp2Price of [0,NaN,Infinity,-Infinity]) assert.equal(math.evaluateSmartEntryRouting({...input,plannedTp2Price,rewardToOppositeZone:2}).mode,'WAIT_DATA');
    assert.equal(math.evaluateSmartEntryRouting({...input,plannedTp2Price:undefined,rewardToOppositeZone:2}).mode,'DIRECT','genuinely absent target retains observed-zone policy');
  }
});

test('SMART prioritizes overextension, measured correlation and adverse ticks before shallow/CE routing',()=>{
  const evalRoute=(override:any)=>math.evaluateSmartEntryRouting({...routing,...override});
  const deep=evalRoute({breakBar:{...routing.breakBar!,close:106}});
  assert.equal(deep.mode,'OTE_DEEP'); assert.equal(deep.recommendedOtePercent,79); near(deep.recommendedOtePrice,102.1); assert.equal(deep.requiresCloseConfirmation,true);
  assert.equal(evalRoute({riskDist:1.6}).recommendedOtePercent,62);
  assert.equal(evalRoute({riskDist:1.86}).recommendedOtePercent,79);
  assert.equal(evalRoute({correlation:{rho:.7,activeCluster:true,asOfMs:900000}}).recommendedOtePercent,79);
  assert.notEqual(evalRoute({correlation:{rho:.9,activeCluster:false,asOfMs:900000}}).recommendedOtePercent,79);
  assert.notEqual(evalRoute({correlation:{rho:.9,activeCluster:true,asOfMs:900001}}).recommendedOtePercent,79);
  const adverse=evalRoute({tickActivity:{...routing.tickActivity!,ratio:1.66,direction:'DOWN'}});
  assert.equal(adverse.recommendedOtePercent,79); assert.equal(adverse.requiresCloseConfirmation,true);
  assert.notEqual(evalRoute({tickActivity:{...routing.tickActivity!,ratio:1.66,direction:'UP'}}).recommendedOtePercent,79);
  assert.equal(evalRoute({riskDist:1.3}).recommendedOtePercent,38.2);
  assert.equal(evalRoute({riskDist:1.5}).mode,'OTE_SHALLOW');
  assert.equal(evalRoute({htfAligned:3,tickActivity:undefined}).recommendedOtePercent,50);
  assert.equal(evalRoute({htfAligned:undefined,tickActivity:undefined}).recommendedOtePercent,62);
  assert.equal(evalRoute({htfAligned:3,riskDist:1.6}).recommendedOtePercent,62);
  const fvg={id:'same-leg',direction:'BUY',tf:'15',top:105.5,bottom:104.5,createdAtMs:0,availableAtMs:900000,impulseCreatedAtMs:0,active:true};
  const ce=evalRoute({tickActivity:undefined,fvgs:[fvg]}); near(ce.recommendedOtePrice,105); assert.equal(ce.anchorFvgId,'same-leg'); assert.equal(ce.recommendedOtePercent,50); near(ce.effectiveOtePercent,50);
  const exact=evalRoute({tickActivity:undefined,fvgs:[{...fvg,top:106,bottom:105}]}); near(exact.recommendedOtePrice,105.5); near(exact.effectiveOtePercent,45);
  for(const bad of [{active:false},{direction:'SELL'},{tf:'60'},{impulseCreatedAtMs:1},{createdAtMs:-1},{availableAtMs:900001},{top:112},{bottom:108},{bottom:NaN}]) assert.equal(evalRoute({tickActivity:undefined,fvgs:[{...fvg,...bad}]}).anchorFvgId,undefined);
  const sell=evalRoute({direction:'SELL',originPrice:110,extremePrice:100,currentPrice:101,plannedTp2Price:99,breakBar:{...routing.breakBar!,open:110,close:104},tickActivity:undefined}); near(sell.recommendedOtePrice,107.9); assert.equal(sell.requiresCloseConfirmation,true);
});

test('position state preserves immutable initial R and confirmed stages, tracking postfill executable MFE only',()=>{
  assert.equal(typeof math.createExecutionPositionState,'function'); assert.equal(typeof math.advanceExecutionPositionState,'function');
  const create={direction:'BUY',entryPrice:100,initialSlPrice:99,entryTimestampMs:900000};
  const state=math.createExecutionPositionState(create);
  assert.equal(state.initialRiskDist,1); assert.equal(state.lastConfirmedSlPrice,99); assert.equal(state.stage,'NONE'); assert.equal(state.mfePriceDist,0);
  for(const bad of [{initialSlPrice:101},{initialSlPrice:100},{initialSlPrice:NaN},{entryPrice:0},{entryTimestampMs:NaN}]) assert.throws(()=>math.createExecutionPositionState({...create,...bad}));
  const advance={direction:'BUY',entryPrice:100,quote,nowMs:1000000,tp1Touched:true,partialConfirmed:true};
  const next=math.advanceExecutionPositionState(state,advance); assert.notEqual(next,state); near(next.mfePriceDist,2); assert.equal(next.partialConfirmed,true); assert.equal(next.tp1Touched,true);
  assert.equal(state.partialConfirmed,false); assert.equal(state.mfePriceDist,0); assert.equal(next.initialRiskDist,1); assert.equal(next.initialSlPrice,99); assert.equal(next.stage,'NONE'); assert.equal(next.lastConfirmedSlPrice,99);
  for(const q of [{...quote,bid:110,ask:110.01,timestampMs:900000},{...quote,bid:110,ask:110.01,timestampMs:1000000},{...quote,timestampMs:1000001},{...quote,bid:NaN},{...quote,bid:103,ask:102}]) assert.equal(math.advanceExecutionPositionState(next,{...advance,quote:q,tp1Touched:false,partialConfirmed:false}).mfePriceDist,2);
  const stale=math.advanceExecutionPositionState(state,{...advance,nowMs:1010001}); assert.equal(stale.mfePriceDist,0);
  const retreat=math.advanceExecutionPositionState(next,{...advance,quote:{...quote,bid:101,ask:101.01,timestampMs:1000001},nowMs:1000001,tp1Touched:false,partialConfirmed:false}); assert.equal(retreat.mfePriceDist,2); assert.equal(retreat.partialConfirmed,true); assert.equal(retreat.tp1Touched,true);
  const sell=math.createExecutionPositionState({...create,direction:'SELL',initialSlPrice:101});
  near(math.advanceExecutionPositionState(sell,{...advance,direction:'SELL',quote:{...quote,bid:97.99,ask:98}}).mfePriceDist,2);
});

test('dynamic BE proposes defensive then net-cost protection without advancing broker-confirmed state',()=>{
  assert.equal(typeof math.evaluateDynamicBreakeven,'function');
  const state:ExecutionPositionState={...math.createExecutionPositionState({direction:'BUY',entryPrice:100,initialSlPrice:99,entryTimestampMs:900000}),tp1Touched:true,partialConfirmed:true,mfePriceDist:2,lastObservationMs:1000000};
  const input={ticker:'EURUSD',direction:'BUY',entryPrice:100,currentSlPrice:99,currentQuote:quote,instrument,state,atr14:1,adr:10,nowMs:1000000,pendingCostPrice:.02,rolloverBlocked:false};
  const net=math.evaluateDynamicBreakeven(input); assert.equal(net.shouldUpdateSl,true); assert.equal(net.stage,'NET_PROTECTION_ESTIMATE'); near(net.lockOffsetPrice,.10); near(net.requiredTriggerDist,1.4); near(net.newSlPrice,100.10); assert.equal(state.stage,'NONE'); assert.equal(state.lastConfirmedSlPrice,99);
  const defensive=math.evaluateDynamicBreakeven({...input,state:{...state,mfePriceDist:1}}); assert.equal(defensive.stage,'DEFENSIVE_MIDPOINT'); near(defensive.newSlPrice,99.55);
  const sell=math.evaluateDynamicBreakeven({...input,direction:'SELL',currentSlPrice:101,currentQuote:{...quote,bid:97.99,ask:98},state:{...state,initialSlPrice:101,lastConfirmedSlPrice:101}}); assert.equal(sell.shouldUpdateSl,true); near(sell.newSlPrice,99.9);
  const widened=math.evaluateDynamicBreakeven({...input,currentQuote:{...quote,ask:102.02}}); near(widened.lockOffsetPrice,.1025); near(widened.newSlPrice,100.10);
  for(const bad of [{rolloverBlocked:true},{atr14:undefined},{atr14:NaN},{adr:NaN},{pendingCostPrice:NaN},{pendingCostPrice:-1},{currentSlPrice:100.5},{nowMs:1010001},{currentQuote:{...quote,timestampMs:1000001}},{currentQuote:{...quote,ask:102.03}},{currentQuote:{...quote,bid:100.05,ask:100.06}},{instrument:{...instrument,pipValuePerLotUsd:undefined}},{ticker:'XAUUSD'},{state:{...state,tp1Touched:false}},{state:{...state,partialConfirmed:false}},{state:{...state,initialRiskDist:2}},{state:{...state,stage:'NET_PROTECTION_ESTIMATE',mfePriceDist:1}}]) { const r=math.evaluateDynamicBreakeven({...input,...bad}); assert.equal(r.shouldUpdateSl,false,JSON.stringify(bad)); assert.equal(r.stage,'NONE'); assert.ok(r.reason); }
  assert.equal(math.evaluateDynamicBreakeven({...input,instrument:{...instrument,baseSpreadPips:0}}).shouldUpdateSl,false);
  const costly=math.evaluateDynamicBreakeven({...input,pendingCostPrice:1}); assert.equal(costly.stage,'DEFENSIVE_MIDPOINT'); near(costly.requiredTriggerDist,3.78);
});

test('trailing waits for persisted net stage, uses directional postfill MFE and exact asset policies',()=>{
  assert.equal(typeof math.computeMultiAssetTrailingSl,'function');
  const state:ExecutionPositionState={...math.createExecutionPositionState({direction:'BUY',entryPrice:100,initialSlPrice:99,entryTimestampMs:900000}),tp1Touched:true,partialConfirmed:true,mfePriceDist:2,lastObservationMs:1000000,stage:'NET_PROTECTION_ESTIMATE',lastConfirmedSlPrice:100.1};
  const input={ticker:'EURUSD',direction:'BUY',entryPrice:100,currentSlPrice:100.1,tp2Price:104,currentQuote:quote,instrument,state,atr14:1,nowMs:1000000,rolloverBlocked:false};
  near(math.computeMultiAssetTrailingSl(input),100.75);
  near(math.computeMultiAssetTrailingSl({...input,tp2Price:102.5}),101.1);
  const sell={...input,direction:'SELL',currentSlPrice:99.9,tp2Price:96,currentQuote:{...quote,bid:97.99,ask:98},state:{...state,initialSlPrice:101,lastConfirmedSlPrice:99.9}}; near(math.computeMultiAssetTrailingSl(sell),99.25);
  for(const bad of [{rolloverBlocked:true},{atr14:NaN},{atr14:undefined},{tp2Price:0},{tp2Price:99},{tp2Price:NaN},{currentSlPrice:100.7},{currentQuote:{...quote,timestampMs:1000001}},{nowMs:1010001},{currentQuote:{...quote,bid:100.5,ask:100.51}},{state:{...state,partialConfirmed:false}},{state:{...state,tp1Touched:false}},{state:{...state,stage:'DEFENSIVE_MIDPOINT'}}]) near(math.computeMultiAssetTrailingSl({...input,...bad}),bad.currentSlPrice??100.1);
  for(const [ticker,regime,base,tight] of [['XAUUSD','METALS',2.1,1.05],['USOIL','ENERGY',1.75,1],['BTCUSD','CRYPTO',2,1.1]] as const) {
    const model={...instrument,ticker,regime};
    const x={...input,ticker,instrument:model,currentSlPrice:99};
    near(math.computeMultiAssetTrailingSl(x),Math.floor((102-base)*100+1e-7)/100);
    near(math.computeMultiAssetTrailingSl({...x,tp2Price:2/.75+100}),Math.floor((102-(base+tight)/2)*100+1e-7)/100);
    near(math.computeMultiAssetTrailingSl({...x,tp2Price:102}),Math.floor((102-tight)*100+1e-7)/100);
  }
  const index={...input,ticker:'US500',instrument:{...instrument,ticker:'US500',regime:'INDICES'},latestStructuralOrigin:{price:101.5,direction:'BUY',tf:'5',eventAtMs:950000,availableAtMs:950000}};
  near(math.computeMultiAssetTrailingSl(index),100.9);
  for(const bad of [undefined,{...index.latestStructuralOrigin,direction:'SELL'},{...index.latestStructuralOrigin,tf:'60'},{...index.latestStructuralOrigin,eventAtMs:900000},{...index.latestStructuralOrigin,availableAtMs:1000001},{...index.latestStructuralOrigin,price:NaN}]) near(math.computeMultiAssetTrailingSl({...index,latestStructuralOrigin:bad}),100.1);
});

test('targets apply every regime RR/ADR cap and eligible structural objective without inverting targets',()=>{
  assert.equal(typeof math.computeExecutionTargets,'function');
  for(const [regime,tp1,tp2,partial] of [['FOREX',1,1.5,.7],['METALS',1.1,2.4,.5],['INDICES',1.2,3.5,.35],['ENERGY',1.05,1.8,.6],['CRYPTO',1.15,2.5,.5]] as const) {
    const buy=math.computeExecutionTargets({direction:'BUY',entryPrice:100,initialSlPrice:99,regime}); assert.equal(buy.valid,true); near(buy.tp1Price,100+tp1); near(buy.tp2Price,100+tp2); near(buy.partialClosePct,partial);
    const sell=math.computeExecutionTargets({direction:'SELL',entryPrice:100,initialSlPrice:101,regime}); near(sell.tp1Price,100-tp1); near(sell.tp2Price,100-tp2);
  }
  const input={direction:'BUY',entryPrice:100,initialSlPrice:99,regime:'FOREX',adr:2};
  const adr=math.computeExecutionTargets(input); near(adr.tp1Price,100.5); near(adr.tp2Price,100.9);
  const structure=math.computeExecutionTargets({...input,structuralTp1Price:100.3,requestedTp2Price:100.8}); near(structure.tp1Price,100.3); near(structure.tp2Price,100.8);
  near(math.computeExecutionTargets({...input,structuralTp1Price:102}).tp1Price,100.5);
  near(math.computeExecutionTargets({...input,structuralTp1Price:99}).tp1Price,100.5);
  for(const bad of [{initialSlPrice:101},{initialSlPrice:100},{initialSlPrice:NaN},{adr:0},{adr:NaN},{regime:'UNKNOWN'},{requestedTp2Price:99},{requestedTp2Price:NaN},{requestedTp2Price:100.4},{structuralTp1Price:NaN}]) {const r=math.computeExecutionTargets({...input,...bad}); assert.equal(r.valid,false,JSON.stringify(bad)); assert.ok(r.reason);}
});

test('SMART rejects overflowed ratios instead of treating them as measured deep or direct signals',()=>{
  assert.equal(math.evaluateSmartEntryRouting({...routing,atr14:Number.MIN_VALUE}).mode,'WAIT_DATA');
  assert.equal(math.evaluateSmartEntryRouting({...routing,riskDist:Number.MIN_VALUE}).mode,'WAIT_DATA');
});

test('correlation uses measured active rho without imposing tick freshness on a different observation',()=>{
  const decision=math.evaluateSmartEntryRouting({...routing,correlation:{rho:.70,activeCluster:true,asOfMs:0}});
  assert.equal(decision.recommendedOtePercent,79);
});

test('invalid supplied policy or room metadata never masquerades as missing/default data',()=>{
  assert.throws(()=>math.resolveExecutionPolicy({profile:null}));
  for(const bad of [{plannedTp2Price:NaN},{plannedTp2Price:Infinity},{rewardToOppositeZone:NaN},{rewardToOppositeZone:Infinity}]) assert.equal(math.evaluateSmartEntryRouting({...routing,...bad}).mode,'WAIT_DATA');
});

test('resolver defaults to inert legacy and validates every ablation and exact frozen profiles',()=>{
  assert.equal(typeof math.resolveExecutionPolicy,'function');
  assert.deepEqual(math.resolveExecutionPolicy(),{profile:'legacy_v1',smart:false,management:false,trailing:false,targets:false});
  assert.deepEqual(math.resolveExecutionPolicy({profile:'microstructure_v1',smart:false}),{profile:'microstructure_v1',smart:false,management:true,trailing:true,targets:true});
  assert.deepEqual(math.resolveExecutionPolicy({profile:'legacy_v1',smart:true}),{profile:'legacy_v1',smart:false,management:false,trailing:false,targets:false});
  for(const bad of [{profile:'x'},{smart:'yes'},{profile:'microstructure_v1',targets:1}]) assert.throws(()=>math.resolveExecutionPolicy(bad));
  const keys=['tp1RR','tp1MaxAdrFrac','partialClosePct','tp2MaxRR','tp2MaxAdrFrac','beTriggerR','beTriggerAtrMult','beTriggerAdrFrac','beMinNetR','trailMode','baseTrailAtrMult','tightTrailAtrMult','ratchetStepAtrMult'];
  const table={
    FOREX:[1,.25,.70,1.5,.45,1.15,1.20,.14,.06,'CHANDELIER_TIGHT',1.25,.90,.20],
    METALS:[1.10,.30,.50,2.40,.60,1.30,1.60,.16,.08,'ADAPTIVE_DECAY',2.10,1.05,.30],
    INDICES:[1.20,.35,.35,3.50,.85,1.20,1.35,.15,.06,'STRUCTURAL_SWING',1.85,1.15,.25],
    ENERGY:[1.05,.28,.60,1.80,.50,1.20,1.40,.15,.07,'ADAPTIVE_DECAY',1.75,1,.25],
    CRYPTO:[1.15,.32,.50,2.50,.65,1.25,1.50,.15,.08,'ADAPTIVE_DECAY',2,1.10,.25],
  };
  for(const [regime,values] of Object.entries(table)) { assert.deepEqual(keys.map(k=>math.REGIME_PROFILES[regime][k]),values); assert.equal(Object.isFrozen(math.REGIME_PROFILES[regime]),true); }
  assert.equal(Object.isFrozen(math.REGIME_PROFILES),true);
});
