import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as regime from '../../src/engine/MLRegimeFeatures.js';
import { loadModelFromJSON } from '../../src/engine/MLFilter.js';
import { validateModel, predictNativeVector, LEGACY_FEATURE_NAMES, LEGACY_INFERENCE_PROFILE, NATIVE_INFERENCE_PROFILE } from '../../src/engine/MLModelValidation.js';
import { context } from './test_ml_regime.js';
const api:any=regime;
assert.equal(typeof api.loadRegimeModelFromJSON,'function','separate model14 candidate loader must exist');
const now=context().nowMs;
const fixture:any={meta:{feature_names:[...regime.REGIME_FEATURE_NAMES],n_features:14,feature_schema:regime.REGIME_FEATURE_SCHEMA,inference_profile:NATIVE_INFERENCE_PROFILE,
 threshold:.65,accuracy:.5,f1:.5,train_samples:10,ticker:'EURUSD',artifact_id:'fixture-only',artifact_status:'candidate',
 context_profile:{momentum_profile:'radar-z-difference/v1',calendar_id:'UTC-day',velocity_profile:regime.REGIME_VELOCITY_PROFILE},
 provenance:{source:'observed-asof',dataset_sha256:'a'.repeat(64),train_end_ms:now-20000,available_at_ms:now-10000}},
 xgboost_model:{learner:{feature_names:[...regime.REGIME_FEATURE_NAMES],learner_model_param:{num_feature:'14',num_class:'0',num_target:'1',base_score:'[8E-1]'},objective:{name:'binary:logistic'},gradient_booster:{name:'gbtree',model:{tree_info:[0],trees:[{left_children:[1,-1,-1],right_children:[2,-1,-1],split_indices:[0,0,0],split_conditions:[1,-.4,.7],base_weights:[0,-.4,.7],default_left:[0,0,0],split_type:[0,0,0]}]}}}}};
assert.equal(loadModelFromJSON(fixture,'REGIME-REJECT'),false,'legacy loader must never accept14');
const legacy=JSON.parse(fs.readFileSync('scripts/hyperopt/models/ml_model.json','utf8'));
assert.equal(api.loadRegimeModelFromJSON(legacy,'EURUSD'),false,'native14 loader must never accept12');
assert.equal(api.predictRegime(context()).status,'UNAVAILABLE','no implicit approval or legacy fallback');
assert.equal(api.loadRegimeModelFromJSON(fixture,'EURUSD'),true);
const p=api.predictRegime(context());assert.equal(p.status,'PREDICTED');assert.equal(p.schema,regime.REGIME_FEATURE_SCHEMA);
assert.equal(p.inferenceProfile,NATIVE_INFERENCE_PROFILE);assert.equal(p.features.smc_score_excess,-6);
assert.ok(Math.abs(p.probability-1/(1+Math.exp(-(Math.log(4)+.7))))<1e-12,'native base_score intercept included');
for(const mutate of [
 (m:any)=>m.meta.feature_names.reverse(),
 (m:any)=>m.meta.feature_schema='legacy12',
 (m:any)=>delete m.meta.inference_profile,
 (m:any)=>delete m.meta.provenance,
 (m:any)=>m.meta.provenance.source='unknown',
 (m:any)=>m.meta.context_profile.momentum_profile='unknown',
 (m:any)=>delete m.xgboost_model.learner.gradient_booster.model.trees[0].default_left,
 (m:any)=>m.xgboost_model.learner.learner_model_param.base_score='[0.3,0.7]',
 (m:any)=>m.meta.accuracy='oops',
]) { const bad=structuredClone(fixture);mutate(bad);assert.equal(api.loadRegimeModelFromJSON(bad,'EURUSD'),false);assert.deepEqual(api.predictRegime(context()),p,'bad loads preserve old model'); }
const huge=context();huge.momentum.value.zUp=1e100;
assert.equal(api.predictRegime(huge).status,'UNAVAILABLE','unrepresentable float32 features remain explicit unavailable');
const missing=context();delete missing.quote;assert.equal(api.predictRegime(missing).status,'UNAVAILABLE');
const smc=context();smc.momentum={...smc.momentum,profile:'smc-directional-impulse/v1',value:{signedZ:2}};assert.equal(api.predictRegime(smc).status,'UNAVAILABLE','do not mix momentum profiles');
const model=validateModel(fixture,regime.REGIME_FEATURE_NAMES,NATIVE_INFERENCE_PROFILE);
const vec=new Array(14).fill(0);vec[0]=NaN;
assert.ok(Math.abs(predictNativeVector(model,vec)-1/(1+Math.exp(-(Math.log(4)+.7))))<1e-12,'NaN follows default_right');
vec[0]=0;assert.ok(Math.abs(predictNativeVector(model,vec)-1/(1+Math.exp(-(Math.log(4)-.4))))<1e-12);
vec[0]=1;assert.ok(Math.abs(predictNativeVector(model,vec)-p.probability)<1e-12,'split equality takes right');
const leftFixture=structuredClone(fixture);leftFixture.xgboost_model.learner.gradient_booster.model.trees[0].default_left[0]=1;
const leftModel=validateModel(leftFixture,regime.REGIME_FEATURE_NAMES,NATIVE_INFERENCE_PROFILE);
vec[0]=NaN;assert.ok(Math.abs(predictNativeVector(leftModel,vec)-1/(1+Math.exp(-(Math.log(4)-.4))))<1e-12,'NaN follows declared default_left');
assert.throws(()=>predictNativeVector(model,new Array(12).fill(0)));
assert.throws(()=>predictNativeVector(model,new Array(14).fill(Infinity)));
assert.throws(()=>predictNativeVector(model,new Array(14)), 'holes are not explicit NaN');
assert.throws(()=>predictNativeVector(model,new Array(14).fill(1e100)), 'float32 overflow is not a valid native input');
assert.throws(()=>predictNativeVector(validateModel(legacy,LEGACY_FEATURE_NAMES,LEGACY_INFERENCE_PROFILE),new Array(12).fill(0)),'native evaluator must refuse legacy profile');
const future=structuredClone(fixture);future.meta.provenance.available_at_ms=now+100;assert.equal(api.loadRegimeModelFromJSON(future,'EURUSD'),true);assert.equal(api.predictRegime(context()).status,'UNAVAILABLE','candidate unavailable before artifact availability');
assert.equal(api.loadRegimeModelFromJSON(fixture,'EURUSD'),true);
fixture.xgboost_model.learner.gradient_booster.model.trees[0].split_conditions[2]=200;
assert.deepEqual(api.predictRegime(context()),p,'input mutation cannot poison the registry');
console.log(JSON.stringify({test:'ml-native14',status:'PASS'}));
