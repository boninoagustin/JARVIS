import assert from 'node:assert/strict';
import {test} from 'node:test';
import {candidateContext,configureArm,hash,verifyFiles,recommendation} from './ml_candidate_compare.ts';
import {completedTrades,metrics} from './ml_threshold_sweep.ts';
const config={ticker:'JP225',entryTrigger:'SMART',sessions:{ALL:{minScore:8}},mlGate:{enabled:false},mlGateEnabled:false};
const manifest={version:1,ticker:'JP225',from_ms:100,train_end_ms:200,validation_end_ms:300,test_end_ms:300,test_independence:'unverified'};
const make=(mutate?:(m:any)=>void)=>{const m:any={meta:{ticker:'JP225',protocol_version:1,threshold:.65,available_at_ms:900000,evaluation_manifest:manifest,config,dataset_source:{partitions:{validation:{effective_config:config}}}}};mutate?.(m);return Buffer.from(JSON.stringify(m));};
test('declared retrospective window, not current training availability, governs replay',()=>{
 const raw=make();const c=candidateContext(raw,'JP225',hash(raw),{...config,mlGateEnabled:true,mlGateDeployment:{ignored:true}});
 assert.equal(c.fromMs,200);assert.equal(c.toMs,300);
});
test('raw model identity, threshold, ticker and frozen/current config fail closed',()=>{
 const raw=make();assert.throws(()=>candidateContext(raw,'JP225','0'.repeat(64)),/SHA256/);
 for(const change of [(m:any)=>m.meta.threshold=.5,(m:any)=>m.meta.ticker='EURUSD',(m:any)=>m.meta.dataset_source.partitions.validation.effective_config={...config,entryTrigger:'BOS'}]){
  const r=make(change);assert.throws(()=>candidateContext(r,'JP225',hash(r)));
 }
 assert.throws(()=>candidateContext(raw,'JP225',hash(raw),{...config,entryTrigger:'BOS'}),/production config/);
});
test('both arms explicitly control ML and candidate arm must load exact own model',()=>{
 const calls:any[]=[];const ctx={ticker:'JP225',raw:make(),sha256:'a'.repeat(64),fromMs:200};
 const runtime:any={setMLGateOverride:(...v:any[])=>calls.push(['override',...v]),setMLGateDeployment:(...v:any[])=>calls.push(['deployment',...v]),setMLWindowStart:(v:any)=>calls.push(['window',v]),loadModelFromJSON:(...v:any[])=>{calls.push(['load',...v]);return true;},getMLGateStatus:()=>({ready:true,gateEnabled:true,modelSha256:ctx.sha256,threshold:.65})};
 configureArm(ctx,false,runtime);assert.deepEqual(calls[0],['override','JP225',false]);assert.equal(calls.some(x=>x[0]==='load'),false);
 calls.length=0;configureArm(ctx,true,runtime);assert.deepEqual(calls[0],['override','JP225',true]);assert.equal(calls.find(x=>x[0]==='window')[1],199);assert.equal(calls.find(x=>x[0]==='load')[2],'JP225');
 assert.throws(()=>configureArm(ctx,true,{...runtime,loadModelFromJSON:()=>false}),/no generic/);
 for(const field of [{gateEnabled:false},{modelSha256:'b'.repeat(64)},{threshold:.5},{ready:false}]) assert.throws(()=>configureArm(ctx,true,{...runtime,getMLGateStatus:()=>({...runtime.getMLGateStatus(),...field})}),/not active/);
});
test('dataset and inference source hashes cannot silently change',()=>{
 const bytes=Buffer.from('frozen');verifyFiles([{path:'data.csv',sha256:hash(bytes)}],()=>bytes);
 assert.throws(()=>verifyFiles([{path:'data.csv',sha256:hash(bytes)}],()=>Buffer.from('changed')),/input hash/);
 assert.throws(()=>verifyFiles([]),/provenance/);
});
test('PnL includes completed BE/timeout/reversal, not training-label-only rows or censored/open records',()=>{
 const trade={timestamp:210,closedAt:220,result:'WIN',rMultiple:2};
 const rows=[trade,{...trade,result:'BE',rMultiple:0},{...trade,result:'TIMEOUT',rMultiple:-.5},{...trade,result:'REVERSAL',rMultiple:.2},{...trade,result:'OPEN'},{...trade,closedAt:299},{...trade,executionBacktest:{closeReason:'FINAL_CENSOR'}},{...trade,rMultiple:NaN},{...trade,closedAt:300}];
 const closed=completedTrades(rows,200,300,299);assert.equal(closed.length,4);assert.equal(metrics(closed).pnlR,1.7);
});
test('recommendation is from paired returns, never accuracy; positive small gate sample is insufficient',()=>{
 assert.equal(recommendation({n:49,pnlR:9},{n:23,pnlR:6}).recommendation,'KEEP_OFF');
 assert.equal(recommendation({n:49,pnlR:9},{n:23,pnlR:10}).recommendation,'INSUFFICIENT_EVIDENCE');
 assert.equal(recommendation({n:49,pnlR:9},{n:35,pnlR:10}).recommendation,'REVIEW_CANDIDATE');
});
