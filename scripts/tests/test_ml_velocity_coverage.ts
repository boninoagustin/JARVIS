import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as regime from '../../src/engine/MLRegimeFeatures.js';
import {NATIVE_INFERENCE_PROFILE} from '../../src/engine/MLModelValidation.js';
import {tickFlow} from '../../src/engine/TickFlow.js';
import {context} from './test_ml_regime.js';
// Synthetic constant-leaf candidate, memory-only; never trained or promoted.
const now=context().nowMs;
assert.equal(regime.loadRegimeModelFromJSON({meta:{feature_names:[...regime.REGIME_FEATURE_NAMES],n_features:14,
 feature_schema:regime.REGIME_FEATURE_SCHEMA,inference_profile:NATIVE_INFERENCE_PROFILE,threshold:.65,accuracy:.5,f1:.5,train_samples:0,
 ticker:'EURUSD',artifact_id:'coverage-fixture-ram-only',artifact_status:'candidate',
 context_profile:{momentum_profile:'radar-z-difference/v1',calendar_id:'UTC-day',velocity_profile:regime.REGIME_VELOCITY_PROFILE},
 provenance:{source:'observed-asof',dataset_sha256:'a'.repeat(64),train_end_ms:now-20000,available_at_ms:now-10000}},
 xgboost_model:{learner:{learner_model_param:{num_feature:'14',base_score:'[5E-1]'},objective:{name:'binary:logistic'},
 gradient_booster:{name:'gbtree',model:{tree_info:[0],trees:[{left_children:[-1],right_children:[-1],split_indices:[0],
 split_conditions:[1],base_weights:[1],default_left:[0],split_type:[0]}]}}}}},'EURUSD'),true);
for(const [name,change] of [
 ['missing velocity',(c:any)=>delete c.velocity],
 ['missing samples',(c:any)=>delete c.velocity.samples],
 ['zero samples',(c:any)=>c.velocity.samples=0],
 ['one sample',(c:any)=>c.velocity.samples=1],
 ['50 samples',(c:any)=>c.velocity.samples=50],
 ['fractional samples',(c:any)=>c.velocity.samples=51.5],
 ['NaN samples',(c:any)=>c.velocity.samples=NaN],
 ['string samples',(c:any)=>c.velocity.samples='51'],
 ['missing variance',(c:any)=>delete c.velocity.baselineVarianceMs2],
 ['zero variance',(c:any)=>c.velocity.baselineVarianceMs2=0],
 ['negative variance',(c:any)=>c.velocity.baselineVarianceMs2=-1],
 ['NaN variance',(c:any)=>c.velocity.baselineVarianceMs2=NaN],
 ['infinite variance',(c:any)=>c.velocity.baselineVarianceMs2=Infinity],
 ['string variance',(c:any)=>c.velocity.baselineVarianceMs2='100'],
 ['wrong UTC hour',(c:any)=>c.velocity.baselineHourUtc=14],
 ['wrong profile',(c:any)=>c.velocity.profile='legacy'],
 ['missing provenance',(c:any)=>delete c.velocity.provenance],
 ['future observation',(c:any)=>c.velocity.availableAtMs=now+1],
 ['stale observation',(c:any)=>{c.velocity.observedAtMs=now-10001;c.velocity.maxAgeMs=20000;}],
] as const) test(`context14 unavailable: ${name}; no fabricated probability`,()=>{
 const c=context();change(c);
 assert.equal(regime.buildRegimeContext(c).status,'UNAVAILABLE',name);
 assert.equal(regime.extractRegimeFeatures(c).status,'UNAVAILABLE',name);
 const result=regime.predictRegime(c);assert.equal(result.status,'UNAVAILABLE',name);
 assert.equal('probability' in result,false);assert.equal('approved' in result,false);
});
test('valid snapshot coverage propagates into immutable context14 and real prediction',()=>{
 const ticker='EURUSD-CONTEXT-COVERAGE';let last=now-6000;
 tickFlow.onTick(ticker,last,1.1,NaN);
 for(let i=0;i<51;i++){last+=i%2?110:90;tickFlow.onTick(ticker,last,1.1,NaN);}
 const snap=tickFlow.getTickVelocitySnapshot(ticker,now);assert.ok(snap);
 const c=context();c.velocity={value:{zScore:snap.zScore},observedAtMs:snap.observedAtMs,
 availableAtMs:snap.availableAtMs,maxAgeMs:10000,provenance:'synthetic-real-TickFlow-snapshot',
 profile:regime.REGIME_VELOCITY_PROFILE,baselineHourUtc:snap.baselineHourUtc,
 samples:snap.samples,baselineVarianceMs2:snap.baselineVarianceMs2};
 const built=regime.buildRegimeContext(c);assert.equal(built.status,'AVAILABLE');
 if(built.status!=='AVAILABLE')throw Error('missing context');
 assert.equal(built.context.velocity.samples,51);assert.ok(built.context.velocity.baselineVarianceMs2>0);
 assert.ok(Object.isFrozen(built.context.velocity));
 c.velocity.samples=0;c.velocity.baselineVarianceMs2=0;
 assert.equal(built.context.velocity.samples,51);assert.ok(built.context.velocity.baselineVarianceMs2>0);
 const result=regime.predictRegime(built.context);assert.equal(result.status,'PREDICTED');
 if(result.status==='PREDICTED')assert.equal(result.approved,true);
});
