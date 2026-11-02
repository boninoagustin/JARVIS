import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as actual from '../../src/engine/MLFilter.js';

const model = JSON.parse(fs.readFileSync('scripts/hyperopt/models/ml_model.json', 'utf8'));
const state: any = {zUp: 2, zDn: .3, atr14: .0012, lastPrice: 1.1, vwapStatus: {'15':'UNDER'}, marketBias: {'15':'BUY','60':'SELL'}, zones: [{dir:'BUY'}]};
const now = Date.UTC(2026, 9, 12, 13, 30);
const input = [state, 'BUY', now, 4, 9, '15'] as const;
const key = 'ATOMIC';
const absent = actual.predict(...input,'NO-MODEL');
assert.equal(absent?.probability,1);assert.equal(absent?.approved,true);assert.equal(absent?.features.length,12);
assert.equal(actual.loadModelFromJSON(model, key), true);
const declared=structuredClone(model);
declared.meta.feature_schema={version:1,names:[...declared.meta.feature_names],n_features:12,type:'finite_numeric',order:'runtime'};
declared.meta.inference_profile='MLFilter.ts/array-trees/zero-margin/base_weights/v1';
for(const base of [.9,'9E-1','[9E-1]',[.9]]) {
 declared.xgboost_model.learner.learner_model_param.base_score=base;
 assert.equal(actual.loadModelFromJSON(declared,'DECLARED'),true,'current trainer metadata and base_score representation supported without training');
 assert.equal(actual.predict(...input,'DECLARED')?.probability,actual.predict(...input,key)?.probability,'legacy ignores valid base_score exactly');
}
const good = actual.predict(...input, key);
const bad = structuredClone(model); delete bad.meta.accuracy;
assert.equal(actual.loadModelFromJSON(bad, key), false);
assert.deepEqual(actual.predict(...input, key), good, 'failed metadata load must not install a new model');
// Distinct tree value exposes mutation-before-log even when threshold matches.
const poison = structuredClone(bad); poison.xgboost_model.learner.gradient_booster.model.trees[0].base_weights.fill(200);
assert.equal(actual.loadModelFromJSON(poison, key), false);
assert.deepEqual(actual.predict(...input, key), good, 'old valid model must survive failed load');
for (const mutate of [
  (m:any) => m.meta.feature_names.reverse(),
  (m:any) => m.xgboost_model.learner.learner_model_param.num_feature = '14',
  (m:any) => m.xgboost_model.learner.objective.name = 'reg:squarederror',
  (m:any) => m.xgboost_model.learner.gradient_booster.model.trees[0].left_children[0] = 0,
  (m:any) => m.xgboost_model.learner.gradient_booster.model.trees[0].right_children[0] = 999999,
  (m:any) => m.xgboost_model.learner.gradient_booster.model.trees[0].split_conditions.pop(),
  (m:any) => m.xgboost_model.learner.gradient_booster.model.trees[0].split_indices[0] = 14,
  (m:any) => m.meta.threshold = NaN,
  (m:any) => m.meta.feature_schema = 'jarvis/regime14/causal/v1',
  (m:any) => m.meta.feature_schema = {version:1,names:[...m.meta.feature_names].reverse(),n_features:12,type:'finite_numeric',order:'runtime'},
]) {
  const malformed = structuredClone(model); mutate(malformed);
  assert.equal(actual.loadModelFromJSON(malformed, key), false, 'malformed artifact rejected');
  assert.deepEqual(actual.predict(...input, key), good);
}
const preSource = fs.readFileSync('/tmp/jarvis-final-implementation/ml/MLFilter.ts','utf8');
const preModule = {exports: {} as any};
vm.runInNewContext(ts.transpileModule(preSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
  {exports:preModule.exports,module:preModule,console:{log(){},error(){}},Date,Map,Set,Math,Number,JSON});
const pre = preModule.exports;
let comparisons = 0;
const modelFiles=fs.readdirSync('scripts/hyperopt/models').filter(f => /^ml_model(?:_[A-Z0-9]+)?\.json$/.test(f));
for (const file of modelFiles) {
  const artifact = fs.readFileSync(`scripts/hyperopt/models/${file}`,'utf8');
  assert.equal(actual.loadModelFromJSON(artifact, 'PARITY'), true, file);
  assert.equal(pre.loadModelFromJSON(artifact, 'PARITY'), true);
  for (const direction of ['BUY','SELL'] as const) for (const tf of ['15','60','D']) for (const offset of [0, 36000000]) {
    const a = actual.predict(state,direction,now+offset,4,0,tf,'PARITY');
    const b = pre.predict(state,direction,now+offset,4,0,tf,'PARITY');
    assert.equal(JSON.stringify(a),JSON.stringify(b),`${file}/${direction}/${tf}`); comparisons++;
  }
}
for (const ticker of ['USOIL','OFF','ON']) {
  if(ticker!=='USOIL') for(const m of [actual,pre]) m.setMLGateOverride(ticker,ticker==='ON');
  for(const auditOnly of [false,true]) assert.equal(JSON.stringify(actual.predict(...input,ticker,{auditOnly})),JSON.stringify(pre.predict(...input,ticker,{auditOnly})));
}
for(const m of [actual,pre]) m.setMLWindowStart(now+1);
assert.equal(actual.predict(...input,key),null); assert.equal(pre.predict(...input,key),null);
for(const m of [actual,pre]) m.setMLWindowStart(0);
// Freeze-by-value legacy training snapshot: subsequent Radar mutation cannot rewrite it.
const mutable = structuredClone(state);
const snapshot = actual.extractFeatures(mutable,'BUY',now,4,9,'15');
const snapshotJSON = JSON.stringify(snapshot); mutable.zUp=999;mutable.zones.push({dir:'SELL'});
assert.equal(JSON.stringify(snapshot),snapshotJSON);
const ast = (source:string) => ts.createSourceFile('MLFilter.ts',source,ts.ScriptTarget.Latest,true);
const before = ast(preSource), after=ast(fs.readFileSync('src/engine/MLFilter.ts','utf8'));
let unchangedBodies=0;
for(const name of ['walkTree','sigmoid','predictProba','extractFeatures','predict','setMLWindowStart','setMLGateOverride']) {
 const find=(root:ts.SourceFile)=>root.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name) as ts.FunctionDeclaration;
 assert.equal(find(after).getText(after),find(before).getText(before),name+' source body must remain byte-identical');unchangedBodies++;
}
console.log(JSON.stringify({test:'ml-safety',models:modelFiles.length,comparisons,unchangedBodies,status:'PASS'}));
