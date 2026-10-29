import assert from 'node:assert/strict';
import {parseCSV,runBacktest} from '../../jarvis-os/src/services/backtestEngine';
import {context} from './test_ml_regime';
import {loadRegimeModelFromJSON,REGIME_FEATURE_SCHEMA,REGIME_FEATURE_NAMES,REGIME_VELOCITY_PROFILE} from '../../src/engine/MLRegimeFeatures';
import {NATIVE_INFERENCE_PROFILE} from '../../src/engine/MLModelValidation';
const now=Date.parse('2026-10-12T15:00:00Z');
const entries=parseCSV(`PING_PRICE | TF: 5 | Precio: 1.1 | TS: ${now-100}
EVENTO_CHOCH | TF: 5 | BUY | ORIGIN: 1.099 | Precio: 1.1 | TS: ${now}
PING_PRICE | TF: 5 | Precio: 1.1 | TS: ${now+60000}`).lines;
const base:any={ticker:'EURUSD',minBuyPoints:1,minSellPoints:1,oteEntryPercent:70,entryTrigger:'CHOCH'};
const run=(cfg:any)=>{const random=Math.random;Math.random=()=>.25;try{return runBacktest(new Map(),cfg,undefined,entries);}finally{Math.random=random;}};
const legacy=run({...base});assert.equal(legacy.trades.length,1);
const trade=legacy.trades[0],c=context();c.nowMs=now;c.tf='5';c.atr.tf='5';
for(const v of [...Object.values(c),...Object.values(c.biases)] as any[])if(v?.observedAtMs!==undefined){v.observedAtMs=now-100;v.availableAtMs=now-50;}
c.sweeps.value[0].eventAtMs=now-500;c.sweeps.value[0].availableAtMs=now-400;c.sweeps.coverageStartMs=now-60000;c.velocity.baselineHourUtc=15;
c.entry.value={entryPrice:trade.entryPrice,initialSL:trade.slPrice};c.score.value={points:trade.points,minRequired:1};
const fixture:any={meta:{feature_names:[...REGIME_FEATURE_NAMES],n_features:14,feature_schema:REGIME_FEATURE_SCHEMA,inference_profile:NATIVE_INFERENCE_PROFILE,
 threshold:.65,accuracy:.5,f1:.5,train_samples:10,ticker:'EURUSD',artifact_id:'wiring-memory-fixture-only',artifact_status:'candidate',context_profile:{momentum_profile:'radar-z-difference/v1',calendar_id:'UTC-day',velocity_profile:REGIME_VELOCITY_PROFILE},provenance:{source:'observed-asof',dataset_sha256:'a'.repeat(64),train_end_ms:now-20000,available_at_ms:now-10000}},
 xgboost_model:{learner:{feature_names:[...REGIME_FEATURE_NAMES],learner_model_param:{num_feature:'14',num_class:'0',base_score:'0.8'},objective:{name:'binary:logistic'},gradient_booster:{name:'gbtree',model:{tree_info:[0],trees:[{left_children:[-1],right_children:[-1],split_indices:[0],split_conditions:[.7],base_weights:[.7],default_left:[1],split_type:[0]}]}}}}};
assert.equal(loadRegimeModelFromJSON(fixture,'EURUSD'),true);
const cfg={...base,mlRegimeShadow:true,mlRegimeContexts:{[`EURUSD:5:BUY:${now}`]:c}};
const positive:any=run(cfg);assert.equal(positive.trades[0].mlRegimeShadow.status,'PREDICTED');assert.equal(positive.trades[0].mlRegimeShadow.vector.length,14);assert.equal(Object.keys(positive.trades[0].mlFeatures).length,12);
assert.deepEqual(cfg.mlRegimeContexts[`EURUSD:5:BUY:${now}`],c,'input observations are not retimed');
assert.equal(positive.researchReport?.schema,1,'research run reports versioned effective config hash');
assert.match(positive.researchReport.configSha256,/^[a-f0-9]{64}$/);assert.equal(positive.researchReport.applyEligible,false);
for(const mutation of [(v:any)=>v.quote.availableAtMs=now+1,(v:any)=>v.nowMs=now+1,(v:any)=>v.entry.value.initialSL-=.001]){
 const bad=structuredClone(cfg);mutation(bad.mlRegimeContexts[`EURUSD:5:BUY:${now}`]);const result:any=run(bad);
 assert.equal(result.trades[0].mlRegimeShadow.status,'UNAVAILABLE');assert.equal(result.trades[0].rMultiple,legacy.trades[0].rMultiple);assert.notEqual(result.researchReport.configSha256,positive.researchReport.configSha256);
}
console.log('PASS actual BT PREDICTED observed sidecar shadow only; invalid/future evidence unavailable, config hash isolated');
