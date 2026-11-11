import assert from 'node:assert/strict';
import {test} from 'node:test';
import {candidateContext,configureArm,hash,verifyFiles,recommendation,selectCalibration,thresholdHoldout,compareCandidate,THRESHOLDS} from './ml_candidate_compare.ts';
import {completedTrades,metrics} from './ml_threshold_sweep.ts';
const config={ticker:'JP225',entryTrigger:'SMART',sessions:{ALL:{minScore:8}},mlGate:{enabled:false},mlGateEnabled:false};
const manifest={version:1,ticker:'JP225',from_ms:100,train_end_ms:200,validation_end_ms:300,test_end_ms:400,test_independence:'unverified'};
const protocol={version:1,thresholds:[.5,.65,.8],minCalibrationTrades:20,minValidationTrades:30};
const make=(mutate?:(m:any)=>void)=>{const m:any={meta:{ticker:'JP225',protocol_version:1,threshold:.65,available_at_ms:900000,evaluation_manifest:manifest,threshold_calibration_protocol:protocol,config,dataset_source:{partitions:{train:{effective_config:config,dataset_meta:{partition:'train',from_ms:100,to_ms:200,terminal_close_policy:'censored'}},validation:{effective_config:config,dataset_meta:{partition:'validation',from_ms:200,to_ms:300,terminal_close_policy:'censored'}}}}}};mutate?.(m);return Buffer.from(JSON.stringify(m));};
const stats=(pnlR:number,n=30)=>({n,pnlR,wr:50,pf:1.5,mdd:2});
const windows={calibration:{fromMs:200,toMs:300},validation:{fromMs:300,toMs:400}};
test('declared three chronological periods, not current training availability, govern replay',()=>{
 const raw=make();const c=candidateContext(raw,'JP225',hash(raw),{...config,mlGateEnabled:true,mlGateDeployment:{ignored:true}});
 assert.deepEqual(c.calibration,windows.calibration);assert.deepEqual(c.validation,windows.validation);
});
test('legacy candidate and inspected empty final window cannot be silently relabeled holdout',()=>{
 for(const change of [(m:any)=>delete m.meta.threshold_calibration_protocol,(m:any)=>m.meta.evaluation_manifest={...manifest,test_end_ms:300},(m:any)=>m.meta.threshold_calibration_protocol={...protocol,thresholds:[.4,.65,.8]},(m:any)=>m.meta.threshold_calibration_protocol={...protocol,minValidationTrades:20},(m:any)=>m.meta.threshold_calibration_protocol={...protocol,minCalibrationTrades:10}]){
  const raw=make(change);assert.throws(()=>candidateContext(raw,'JP225',hash(raw)));
 }
});
test('raw model identity, default threshold, ticker and frozen/current config fail closed',()=>{
 const raw=make();assert.throws(()=>candidateContext(raw,'JP225','0'.repeat(64)),/SHA256/);
 for(const change of [(m:any)=>m.meta.threshold=.5,(m:any)=>m.meta.ticker='EURUSD',(m:any)=>m.meta.dataset_source.partitions.validation.effective_config={...config,entryTrigger:'BOS'}]){
  const r=make(change);assert.throws(()=>candidateContext(r,'JP225',hash(r)));
 }
 assert.throws(()=>candidateContext(raw,'JP225',hash(raw),{...config,entryTrigger:'BOS'}),/production config/);
});
test('training/calibration provenance cannot include final or disagree with actual collection windows',()=>{
 for(const change of [(m:any)=>m.meta.test_evaluated=true,(m:any)=>m.meta.dataset_source.partitions.validation.dataset_meta.to_ms=400,(m:any)=>m.meta.dataset_source.partitions.train.dataset_meta.to_ms=300,(m:any)=>delete m.meta.dataset_source.partitions.train,(m:any)=>m.meta.dataset_source.partitions.validation.dataset_meta.terminal_close_policy='forced']){
  const raw=make(change);assert.throws(()=>candidateContext(raw,'JP225',hash(raw)));
 }
});
test('dynamic deployment threshold applies without changing raw candidate default or bytes',()=>{
 const calls:any[]=[];const raw=make(),before=hash(raw),ctx={ticker:'JP225',raw,sha256:hash(raw),fromMs:200};
 let activeThreshold=.65;
 const runtime:any={setMLGateOverride:(...v:any[])=>calls.push(['override',...v]),setMLGateDeployment:(key:string,value:any)=>{calls.push(['deployment',key,value]);activeThreshold=value?.threshold;},setMLWindowStart:(v:any)=>calls.push(['window',v]),loadModelFromJSON:(...v:any[])=>{calls.push(['load',...v]);return true;},getMLGateStatus:()=>({ready:true,gateEnabled:true,modelSha256:ctx.sha256,threshold:activeThreshold})};
 configureArm(ctx,false,runtime);assert.deepEqual(calls[0],['override','JP225',false]);assert.equal(calls.some(x=>x[0]==='load'),false);
 for(const threshold of THRESHOLDS){
  calls.length=0;configureArm(ctx,true,runtime,threshold);assert.deepEqual(calls[0],['override','JP225',true]);assert.equal(calls.find(x=>x[0]==='window')[1],199);assert.equal(calls.find(x=>x[0]==='deployment')[2].threshold,threshold);assert.equal(calls.find(x=>x[0]==='load')[2],'JP225');
  assert.equal(hash(raw),before);assert.equal(JSON.parse(raw.toString()).meta.threshold,.65);
 }
 assert.throws(()=>configureArm(ctx,true,{...runtime,loadModelFromJSON:()=>false}),/no generic/);
 for(const field of [{gateEnabled:false},{modelSha256:'b'.repeat(64)},{threshold:.5},{ready:false}]) assert.throws(()=>configureArm(ctx,true,{...runtime,getMLGateStatus:()=>({...runtime.getMLGateStatus(),...field})},.65),/not active/);
 assert.throws(()=>configureArm(ctx,true,runtime,.6),/declared/);
});
test('dataset and inference source hashes cannot silently change',()=>{
 const bytes=Buffer.from('frozen');verifyFiles([{path:'data.csv',sha256:hash(bytes)}],()=>bytes);
 assert.throws(()=>verifyFiles([{path:'data.csv',sha256:hash(bytes)}],()=>Buffer.from('changed')),/input hash/);
 assert.throws(()=>verifyFiles([]),/provenance/);
});
test('completed PnL includes BE/timeout/reversal, never censored/open records',()=>{
 const trade={timestamp:210,closedAt:220,result:'WIN',rMultiple:2};
 const rows=[trade,{...trade,result:'BE',rMultiple:0},{...trade,result:'TIMEOUT',rMultiple:-.5},{...trade,result:'REVERSAL',rMultiple:.2},{...trade,result:'OPEN'},{...trade,closedAt:299},{...trade,executionBacktest:{closeReason:'FINAL_CENSOR'}},{...trade,rMultiple:NaN},{...trade,closedAt:300}];
 const closed=completedTrades(rows,200,300,299);assert.equal(closed.length,4);assert.equal(metrics(closed).pnlR,1.7);
});
test('OFF is a competitor, wins all exact ties, and calibration threshold ties are deterministic',()=>{
 const runs=(pairs:[number,number][])=>pairs.map(([threshold,pnlR])=>({threshold,metrics:stats(pnlR),eligible:true}));
 assert.deepEqual(selectCalibration(stats(10),runs([[.5,10],[.65,9],[.8,10]])),{selectedMode:'off',selectedThreshold:null,selectionMade:true});
 assert.equal(selectCalibration(stats(0),runs([[.8,10],[.5,10],[.65,10]])).selectedThreshold,.65);
 assert.equal(selectCalibration(stats(0),runs([[.8,10],[.5,10]])).selectedThreshold,.5);
 assert.equal(selectCalibration(stats(0),runs([[.5,1],[.65,2],[.8,3]])).selectedThreshold,.8);
});
test('sub-minimum threshold cannot compete even with highest calibration PnL',async()=>{
 const result=await thresholdHoldout(windows,request=>request.phase==='calibration'?(request.threshold===.8?stats(999,19):request.threshold===.65?stats(2):stats(1)):stats(3));
 assert.equal(result.calibration.runs[2].eligible,false);assert.equal(result.selectedThreshold,.65);
 assert.equal(result.validation.selected?.pnlR,3);
});
test('winner selected only from calibration, final loss never triggers reselection',async()=>{
 const calls:any[]=[];
 const run=async(finalSelectedPnl:number)=>thresholdHoldout(windows,request=>{
  calls.push(request);
  if(request.phase==='calibration')return stats(request.threshold===null?1:request.threshold===.5?4:request.threshold===.65?7:100);
  return stats(request.threshold===null?5:finalSelectedPnl);
 });
 const loss=await run(-1000);assert.equal(loss.selectedThreshold,.8);assert.equal(loss.recommendation,'KEEP_OFF');assert.equal(loss.validation.deltaR,-1005);
 const gain=await run(1000);assert.equal(gain.selectedThreshold,.8);assert.equal(gain.recommendation,'REVIEW_CANDIDATE');
 for(let i=0;i<calls.length;i+=6){
  assert.deepEqual(calls.slice(i,i+4).map(r=>[r.phase,r.threshold]),[['calibration',null],['calibration',.5],['calibration',.65],['calibration',.8]]);
  assert.deepEqual(calls.slice(i+4,i+6).map(r=>[r.phase,r.threshold]),[['validation',null],['validation',.8]]);
 }
});
test('OFF selection has no fake final with-gate, threshold, delta or alternate gate run',async()=>{
 const calls:any[]=[];
 const result=await thresholdHoldout(windows,request=>{calls.push(request);return stats(request.phase==='calibration'?(request.threshold===null?10:9):100);});
 assert.equal(result.calibration.selectedMode,'off');assert.equal(result.selectedThreshold,null);
 assert.equal(result.validation.selected,null);assert.equal(result.validation.deltaR,null);assert.equal(result.recommendation,'KEEP_OFF');
 assert.equal(calls.length,5);assert.equal(calls.at(-1).mode,'off');
});
test('all calibration thresholds ineligible leaves OFF competitor, not a sub-minimum winner',async()=>{
 const result=await thresholdHoldout(windows,r=>r.phase==='calibration'?(r.threshold===null?stats(1,20):stats(100,19)):stats(3,30));
 assert.equal(result.calibration.runs.every(r=>!r.eligible),true);assert.equal(result.selectedThreshold,null);assert.equal(result.calibration.selectionMade,true);assert.equal(result.recommendation,'KEEP_OFF');
});
test('insufficient calibration baseline never claims an eligible winner',async()=>{
 const calls:any[]=[];
 const result=await thresholdHoldout(windows,r=>{calls.push(r);return r.phase==='calibration'?(r.threshold===null?stats(1,19):stats(100,30)):stats(10,30);});
 assert.equal(result.status,'insufficient');assert.equal(result.calibration.selectionMade,false);assert.equal(result.recommendation,'INSUFFICIENT_EVIDENCE');assert.equal(result.validation.selected,null);assert.equal(calls.length,5);
});
test('insufficient final samples never reselect threshold or claim activation evidence',async()=>{
 for(const lowArm of ['baseline','selected']){
  const calls:any[]=[];
  const result=await thresholdHoldout(windows,r=>{calls.push(r);return r.phase==='calibration'?stats(r.threshold===.65?10:1):stats(r.threshold===null?5:100,(r.threshold===null)===(lowArm==='baseline')?29:30);});
  assert.equal(result.selectedThreshold,.65);assert.equal(result.status,'insufficient');assert.equal(result.recommendation,'INSUFFICIENT_EVIDENCE');assert.equal(calls.length,6);
 }
 assert.equal(recommendation(stats(9,49),stats(-100,23)).recommendation,'INSUFFICIENT_EVIDENCE');
});
test('bad replay output fails closed, no invented sample counts',async()=>{
 await assert.rejects(()=>thresholdHoldout(windows,()=>stats(NaN)),/metrics/);
});
test('legacy existing JP225 is unavailable, never split or backfit old validation',async()=>{
 // Real, already-inspected candidate; comparison must stop BEFORE any replay/fitting.
 const old='/opt/JARVIS/data/ml_calibration/candidates/JP225-1794431389776.json';
 const fs=await import('node:fs');
 if(!fs.existsSync(old)) return;
 const result=await compareCandidate(old,hash(fs.readFileSync(old)));
 assert.equal(result.schemaVersion,2);assert.equal(result.status,'unavailable');assert.match(result.reason,/protocol/);
 assert.equal(result.prospective,false);assert.equal(result.independentTest,false);assert.equal(result.applyEligible,false);
 assert.equal('calibration' in result,false);
});
