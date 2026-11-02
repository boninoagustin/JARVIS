// Synthetic/offline fixtures only. No market-performance assertion.
import assert from 'node:assert/strict';
import {assessFollowup, evaluateFollowup} from './weekly_followup.js';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {configFingerprint} from '../hyperopt/evaluation_protocol.js';
import {RpcWorker} from './eval_production.js';
import {createHash} from 'node:crypto';
import {LEGACY_FEATURE_NAMES} from '../../src/engine/MLModelValidation.js';
import {mapAssetConfig} from './selection_context.js';
const eight = (r:number) => Array(8).fill(r);
assert.equal(assessFollowup({beforeReturns:eight(0.3), appliedReturns:eight(0.19)}).decision,'ROLLBACK');
assert.equal(assessFollowup({beforeReturns:eight(0.3), appliedReturns:eight(0.2)}).decision,'KEEP');
assert.equal(assessFollowup({beforeReturns:eight(0), appliedReturns:eight(0.1)}).decision,'KEEP');
assert.equal(assessFollowup({beforeReturns:eight(0.3), appliedReturns:[-1]}).decision,'PENDING');
assert.equal(assessFollowup({beforeReturns:eight(NaN), appliedReturns:eight(0)}).decision,'PENDING');
assert.equal(assessFollowup({beforeReturns:eight(0), appliedReturns:eight(Infinity)}).decision,'PENDING');
assert.equal(assessFollowup({beforeReturns:[0], appliedReturns:[-1], minTrades:1}).decision,'ROLLBACK');
assert.equal(assessFollowup({beforeReturns:[], appliedReturns:[], minTrades:0}).decision,'PENDING');
console.log('PASS pure policy: strict >0.10 R/trade, finite evidence, configurable minimum (default 8)');

const dir=mkdtempSync(path.join(tmpdir(),'weekly-followup-synthetic-'));
const start=Date.parse('2026-07-14T15:00:00Z');
const asset={entryTrigger:'CHOCH',minBuyPoints:1,minSellPoints:1,oteEntryPercent:70,
  maxTradesPerDay:0,maxTradesPerSession:0,sessionWarmupMin:0,mlGateEnabled:false};
const ping=(t:number,p=1.1)=>`PING_PRICE | TF: 5 | Precio: ${p} | High: ${p+0.0002} | Low: ${p-0.0002} | TS: ${t}`;
const setup=(t:number)=>[ping(t),`EVENTO_CHOCH | TF: 5 | BUY | ORIGIN: 1.099 | Precio: 1.1 | TS: ${t+1}`];
try {
  const lines=[...setup(start-300000)];
  for(let i=0;i<8;i++)lines.push(...setup(start+i*300000),ping(start+i*300000+60000,1.105),ping(start+i*300000+120000));
  lines.push(ping(start+8*300000));
  writeFileSync(path.join(dir,'M5.csv'),lines.join('\n'));
  // Future HTF observations are context, not an extension of tradable M5 coverage.
  writeFileSync(path.join(dir,'D1.csv'),`PING_PRICE | TF: D | Precio: 1.1 | TS: ${start+86400000}`);
  const rpc=new RpcWorker();
  let initial:any;
  try {initial=await rpc.call('init',{ticker:'EURUSD',log_dir:dir});}finally{rpc.close();}
  const input={ticker:'EURUSD',appliedAt:start-1000,priorEvaluatedEndMs:start,beforeAsset:asset,
    expectedSourceFiles:initial.provenance.source_files,
    appliedAsset:structuredClone(asset),logsDir:dir,outputDir:path.join(dir,'evidence'),
    minIntervalMs:1,minContextObservations:{'5':1},warmupDays:0};
  const missing=await evaluateFollowup({...input,priorEvaluatedEndMs:undefined});
  assert.equal(missing.decision,'PENDING');assert.match(missing.reason,/prior.*(cutoff|end|history)/i);
  const result=await evaluateFollowup(input);
  assert.equal(result.decision,'KEEP',result.reason);
  assert.equal(result.window.from_ms,start);
  assert.equal(result.window.to_ms,start+8*300000+1);
  assert.ok(result.before.closedTrades.length>=8,'real synthetic engine must close >=8 trades');
  assert.ok(result.applied.closedTrades.length>=8);
  assert.equal(result.before.replayDiagnostics.boundarySnapshot.orders,0);
  assert.equal(result.before.replayDiagnostics.boundarySnapshot.activeTrades,0);
  assert.equal(result.before.replayDiagnostics.boundarySnapshot.dailyStats.tradeCount,0);
  assert.ok(result.before.closedTrades.every((t:any)=>t.timestamp>=start&&t.closeTimestamp<result.window.to_ms));
  assert.equal(result.before.assetFingerprint,configFingerprint(asset));
  assert.equal(result.before.configFingerprint,configFingerprint(result.before.effectiveConfig));
  assert.equal(result.evidenceFingerprint,configFingerprint(result.evidence));
  assert.deepEqual(JSON.parse(readFileSync(result.evidencePath,'utf8')),result.evidence);
  assert.deepEqual(asset,input.appliedAsset,'input not mutated');
  const worse=await evaluateFollowup({...input,worker:{call:async()=>initial},appliedAsset:{...asset,commissionPerLot:15}});
  assert.equal(worse.decision,'ROLLBACK',worse.reason);
  assert.ok(worse.deteriorationRPerTrade>0.10,'real engine measured costs, not a fabricated result');
  console.log('SYNTHETIC measured paired replay',JSON.stringify({beforeCount:worse.beforeCount,appliedCount:worse.appliedCount,
    beforeRPerTrade:worse.beforeRPerTrade,appliedRPerTrade:worse.appliedRPerTrade,deteriorationRPerTrade:worse.deteriorationRPerTrade,decision:worse.decision}));
  const frozenApplied={...mapAssetConfig('EURUSD',asset),commissionPerLot:15};
  const frozen=await evaluateFollowup({...input,worker:{call:async()=>initial},evaluatedAppliedConfig:frozenApplied});
  assert.equal(frozen.decision,'ROLLBACK','explicit evaluated config, not rebuilt asset, is replayed');
  assert.deepEqual(frozen.evidence.frozenInputs.appliedConfig,frozenApplied);
  const pending=await evaluateFollowup({...input,minTrades:100});
  assert.equal(pending.decision,'PENDING');assert.equal(pending.reason,'insufficient_trades');
  const weekly=await evaluateFollowup({...input,minIntervalMs:undefined});
  assert.equal(weekly.decision,'PENDING');assert.match(weekly.reason,/interval/);
  const operationalChange=initial.provenance.source_files.map((f:any)=>f.path.endsWith('/PeriodicOptPanel.tsx')?{...f,sha256:'0'.repeat(64)}:f);
  const operational=await evaluateFollowup({...input,expectedSourceFiles:operationalChange,worker:{call:async()=>initial}});
  assert.equal(operational.decision,'KEEP','UI-only source changes must not veto engine replay');
  const runtimeChange=initial.provenance.source_files.map((f:any)=>f.path.endsWith('/backtestEngine.ts')?{...f,sha256:'0'.repeat(64)}:f);
  const runtime=await evaluateFollowup({...input,expectedSourceFiles:runtimeChange,worker:{call:async()=>initial}});
  assert.equal(runtime.decision,'PENDING');assert.match(runtime.reason,/source/);
  const noSources=await evaluateFollowup({...input,expectedSourceFiles:undefined});
  assert.equal(noSources.decision,'PENDING');assert.match(noSources.reason,/source/);
  const injected={call:async()=>initial};
  const notReady=await evaluateFollowup({...input,worker:injected,minContextObservations:{'5':60,'D':60}});
  assert.equal(notReady.decision,'PENDING');assert.equal(notReady.reason,'warmup_context_not_ready');
  const later=await evaluateFollowup({...input,worker:injected,appliedAt:start+300000});
  assert.equal(later.window.from_ms,start+300000,'application time never rounded backwards');
  const badInit=await evaluateFollowup({...input,worker:{call:async()=>({...initial,evaluation_fingerprint:'wrong'})}});
  assert.equal(badInit.decision,'PENDING');assert.match(badInit.reason,/provenance/);
  const noDatasetProvenance={...initial.provenance,dataset_files:[]};
  const noDataset=await evaluateFollowup({...input,worker:{call:async()=>({...initial,provenance:noDatasetProvenance,evaluation_fingerprint:configFingerprint(noDatasetProvenance)})}});
  assert.equal(noDataset.decision,'PENDING');assert.match(noDataset.reason,/dataset/);
  const gap=await evaluateFollowup({...input,worker:injected,maxM5GapMs:1000});
  assert.equal(gap.decision,'PENDING');assert.match(gap.reason,/M5_gap/);
  const failed=await evaluateFollowup({...input,worker:{call:async()=>{throw new Error('synthetic RPC failure');}}});
  assert.equal(failed.decision,'PENDING');assert.match(failed.reason,/RPC failure/);
  const modelPath=path.join(dir,'model.json');
  const model={meta:{threshold:0.65,accuracy:0.7,f1:0.7,train_samples:1,n_features:12,feature_names:[...LEGACY_FEATURE_NAMES],
    train_end_ms:start-600000,available_at_ms:start-300000},xgboost_model:{learner:{objective:{name:'binary:logistic'},
    learner_model_param:{num_feature:'12',num_class:'0',base_score:'0.5'},gradient_booster:{name:'gbtree',model:{tree_info:[0],trees:[{
    left_children:[-1],right_children:[-1],split_indices:[0],split_conditions:[10],base_weights:[10],default_left:[1],split_type:[0]}]}}}}};
  writeFileSync(modelPath,JSON.stringify(model));
  const modelIdentity={path:modelPath,sha256:createHash('sha256').update(readFileSync(modelPath)).digest('hex')};
  const mlAsset={...asset,mlGateEnabled:true};
  const mlInput={...input,beforeAsset:mlAsset,appliedAsset:mlAsset,worker:injected,expectedModelFiles:[modelIdentity],
    evaluatedBeforeConfig:mapAssetConfig('EURUSD',mlAsset),evaluatedAppliedConfig:mapAssetConfig('EURUSD',mlAsset)};
  const ml=await evaluateFollowup(mlInput);
  assert.equal(ml.decision,'KEEP',ml.reason);
  assert.equal(ml.before.effectiveConfig.mlGate.modelPath,modelPath);
  const unknownModel=await evaluateFollowup({...mlInput,expectedModelFiles:undefined});
  assert.equal(unknownModel.decision,'PENDING');assert.match(unknownModel.reason,/model_identity/);
  writeFileSync(modelPath,JSON.stringify({...model,changed:true}));
  const retrained=await evaluateFollowup(mlInput);
  assert.equal(retrained.decision,'PENDING');assert.match(retrained.reason,/model/);
  writeFileSync(modelPath,JSON.stringify({...model,meta:{...model.meta,available_at_ms:start-500}}));
  const tooLate={path:modelPath,sha256:createHash('sha256').update(readFileSync(modelPath)).digest('hex')};
  const lateModel=await evaluateFollowup({...mlInput,expectedModelFiles:[tooLate]});
  assert.equal(lateModel.decision,'PENDING');assert.match(lateModel.reason,/model_temporal/);
  const cachePath=path.join(dir,'forecasts.jsonl');
  const forecast=(ts:number)=>({ts,ticker:'EURUSD',tf:5,horizon:1,q10:[1.104],q50:[1.105],q90:[1.106],
    schema_version:2,timestamp_convention:'context_close_ms_v2',contextCloseTimeMs:ts,computedAt:ts,availableAt:ts,model_version:'synthetic-v1'});
  const prefix=JSON.stringify(forecast(start-300000))+'\n';
  const tail=Array.from({length:9},(_,i)=>JSON.stringify(forecast(start+i*300000))).join('\n')+'\n';
  writeFileSync(cachePath,prefix+tail);
  const cacheIdentity={path:cachePath,sha256:createHash('sha256').update(prefix).digest('hex'),sizeBytes:Buffer.byteLength(prefix)};
  const tfAsset={...asset,timesfm:{enabled:true,cachePath,auditPath:path.join(dir,'MUST_NOT_WRITE'),collectPath:path.join(dir,'MUST_NOT_COLLECT')}};
  const cacheInput={...input,beforeAsset:tfAsset,appliedAsset:tfAsset,expectedCacheFiles:[cacheIdentity],worker:{call:async()=>initial}};
  const cached=await evaluateFollowup(cacheInput);
  assert.equal(cached.decision,'KEEP',cached.reason);
  assert.equal(cached.before.fileIdentities[0].sha256,createHash('sha256').update(prefix+tail).digest('hex'));
  assert.ok(!readdirSync(dir).includes('MUST_NOT_WRITE'));
  assert.ok(!readdirSync(dir).includes('MUST_NOT_COLLECT'));
  writeFileSync(cachePath,prefix);
  const missingCache=await evaluateFollowup(cacheInput);
  assert.equal(missingCache.decision,'PENDING');assert.match(missingCache.reason,/cache.*coverage/);
  writeFileSync(cachePath,prefix.replace('synthetic-v1','synthetic-v2')+tail);
  const replaced=await evaluateFollowup(cacheInput);
  assert.equal(replaced.decision,'PENDING');assert.match(replaced.reason,/cache.*(prefix|identity)/);
  writeFileSync(cachePath,prefix+tail.replace(/"availableAt":(\d+)/g,`"availableAt":${start+86400000}`));
  const futureCache=await evaluateFollowup(cacheInput);
  assert.equal(futureCache.decision,'PENDING');assert.match(futureCache.reason,/cache.*(causal|temporal|availability)/);
  assert.equal(readdirSync(dir).filter(n=>n.endsWith('.csv')).length,2);
  console.log('PASS real RPC init + real reset-execution replay, paired 8-trade synthetic interval, provenance, local evidence, insufficient sample/week');
} finally {rmSync(dir,{recursive:true,force:true});}
