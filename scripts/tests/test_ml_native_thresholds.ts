import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateModel,predictNativeVector,LEGACY_FEATURE_NAMES,LEGACY_INFERENCE_PROFILE,NATIVE_INFERENCE_PROFILE} from '../../src/engine/MLModelValidation.js';
// Untrained synthetic tree built only in RAM; active artifact is read-only metadata seed.
const source=JSON.parse(fs.readFileSync('scripts/hyperopt/models/ml_model.json','utf8'));
const tree={left_children:[1,-1,-1],right_children:[2,-1,-1],split_indices:[0,0,0],
 split_conditions:[.300000012,-.4,.7],base_weights:[0,99,-99],default_left:[0,0,0],split_type:[0,0,0]};
source.xgboost_model.learner.gradient_booster.model.trees=[tree];
source.xgboost_model.learner.gradient_booster.model.tree_info=[0];
source.xgboost_model.learner.gradient_booster.model.gbtree_model_param.num_trees='1';
source.xgboost_model.learner.learner_model_param.base_score='[8E-1]';
const before=structuredClone(source);
const legacy=validateModel(source,LEGACY_FEATURE_NAMES,LEGACY_INFERENCE_PROFILE);
assert.deepEqual(legacy.trees,[tree],'legacy thresholds, leaves and weights frozen');
assert.equal(legacy.intercept,0);
source.meta.inference_profile=NATIVE_INFERENCE_PROFILE;
const native=validateModel(source,LEGACY_FEATURE_NAMES,NATIVE_INFERENCE_PROFILE);
assert.deepEqual(native.trees,[{...tree,split_conditions:[Math.fround(.300000012),-.4,.7]}],
 'canonicalize internal thresholds only, preserving topology, missing directions and leaves');
assert.deepEqual(source.xgboost_model,before.xgboost_model,'caller artifact not mutated');
const intercept=Math.log(.8/(1-.8));
assert.equal(native.intercept,intercept);
const vector=new Array(12).fill(0);vector[0]=.3;
const right=1/(1+Math.exp(-(intercept+.7)));
assert.equal(predictNativeVector(native,vector),right);
vector[0]=NaN;assert.equal(predictNativeVector(native,vector),right);
source.xgboost_model.learner.gradient_booster.model.trees[0].default_left[0]=1;
const left=validateModel(source,LEGACY_FEATURE_NAMES,NATIVE_INFERENCE_PROFILE);
assert.equal(predictNativeVector(left,vector),1/(1+Math.exp(-(intercept-.4))));
source.xgboost_model.learner.gradient_booster.model.trees[0].split_conditions[0]=1e100;
assert.throws(()=>validateModel(source,LEGACY_FEATURE_NAMES,NATIVE_INFERENCE_PROFILE),/float32 threshold/);
console.log(JSON.stringify({test:'native-threshold-snapshot-preservation',status:'PASS',synthetic_ram_only:true}));
