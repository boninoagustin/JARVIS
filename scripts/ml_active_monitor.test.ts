import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RULES,DAY_MS,hash,strategyConfig,validateInput,coveredWindows,configureMonitorArm,verifyGate,validMetrics,assessSignals,verifyFrozenFiles,getCriticalSourceFingerprint,monitorActiveModel,type MonitorInput} from './ml_active_monitor.ts';
import {LEGACY_FEATURE_NAMES} from '../src/engine/MLModelValidation.ts';
import {getMLGateStatus,setMLGateDeployment,setMLGateOverride,setMLWindowStart} from '../src/engine/MLFilter.ts';
const now=100*DAY_MS;
const raw=(meta:any={})=>Buffer.from(JSON.stringify({meta:{ticker:'JP225',train_end_ms:DAY_MS,available_at_ms:2*DAY_MS,...meta}}));
const input=(bytes=raw(),extra:any={}):MonitorInput=>({ticker:'JP225',activationId:'activation-v1',modelPath:'/archive/model.json',modelSha256:hash(bytes),threshold:.573,config:{ticker:'JP225',entryTrigger:'SMART',sessions:{ALL:{minScore:8}}},fromMs:3*DAY_MS,toMs:now,recentFromMs:now-28*DAY_MS,dataDir:'/history/jp225',...extra});
const metrics=(pnlR:number,n=30,mdd=2)=>({n,pnlR,mdd,wr:50,pf:2});
const window=(deltaR:number,n=30,baselineDD=2,activeDD=2)=>({baseline:metrics(10,n,baselineDD),active:metrics(10+deltaR,n,activeDD),deltaR});
const windows=(c:any=window(1),r:any=window(1))=>({cumulative:c,recent:r});

test('requires authoritative raw model availability and exact own-model identity, never backdates',()=>{
 const bytes=raw(),i=input(bytes),ctx=validateInput(i,bytes,now);
 assert.equal(ctx.modelAvailableAtMs,2*DAY_MS);assert.equal(ctx.input.threshold,.573);
 assert.throws(()=>validateInput({...i,modelSha256:'0'.repeat(64)},bytes,now),/SHA256/);
 for(const meta of [{available_at_ms:undefined,trained_at:'2026-01-01T00:00:00Z'},{train_end_ms:undefined},{available_at_ms:'100'},{available_at_ms:DAY_MS-1},{available_at_ms:true}]){
  const b=raw(meta);assert.throws(()=>validateInput(input(b),b,now),/Authoritative/);
 }
 const other=raw({ticker:'EURUSD'});assert.throws(()=>validateInput(input(other),other,now),/ticker mismatch/);
 assert.throws(()=>validateInput({...i,fromMs:DAY_MS},bytes,now),/precedes/);
});
test('active threshold is fixed but accepts ANY finite probability threshold, not calibration grid only',()=>{
 const bytes=raw();for(const threshold of [.01,.41,.573,.99]) assert.equal(validateInput(input(bytes,{threshold}),bytes,now).input.threshold,threshold);
 for(const threshold of [0,1,-.1,Infinity,NaN,'0.65',true]) assert.throws(()=>validateInput(input(bytes,{threshold}),bytes,now),/threshold/i);
});
test('strict temporal bounds and exact recent 28-day input are required',()=>{
 const bytes=raw();
 for(const extra of [{toMs:now+1},{fromMs:now},{fromMs:-1},{recentFromMs:now-27*DAY_MS},{toMs:1.5}]) assert.throws(()=>validateInput(input(bytes,extra),bytes,now),/window/i);
 const short=input(bytes,{fromMs:now-5*DAY_MS,recentFromMs:now-5*DAY_MS});assert.equal(validateInput(short,bytes,now).input.recentFromMs,short.fromMs);
});
test('config fingerprint is frozen strategy projection and cannot mutate caller config',()=>{
 const original={ticker:'JP225',mlGateEnabled:true,mlGateDeployment:{old:true},mlGate:{enabled:true},timesfm:{enabled:false,auditPath:'/must/not/write',collectPath:'/must/not/write',collectOnly:true},sessions:{ALL:{minScore:8}}};
 const c=strategyConfig(original);assert.equal(c.mlGate,undefined);assert.equal(c.timesfm.auditPath,undefined);assert.equal(original.mlGateEnabled,true);
 const bytes=raw(),i=input(bytes,{config:original}),a=validateInput(i,bytes,now);
 assert.equal(validateInput({...i,configFingerprint:a.configFingerprint},bytes,now).configFingerprint,a.configFingerprint);
 assert.throws(()=>validateInput({...i,configFingerprint:'0'.repeat(64)},bytes,now),/fingerprint/);
 assert.throws(()=>validateInput({...i,config:{ticker:'EURUSD'}},bytes,now),/config ticker/);
});
test('NEW post-activation data caps window to available history, not training dataset end',()=>{
 const i=input(),events=[{ts:DAY_MS},{ts:10*DAY_MS},{ts:50*DAY_MS},{ts:now+1000}];
 const c=coveredWindows(i,events,now);
 assert.equal(c.dataThroughMs,50*DAY_MS);assert.equal(c.cumulative.toMs,50*DAY_MS+1);
 assert.equal(c.recent.fromMs,22*DAY_MS+1);assert.equal(c.cumulative.fromMs,i.fromMs);assert.equal(c.dataStale,true);
 assert.equal(coveredWindows(i,[{ts:now-2}],now).dataStale,false);
});
test('no post-start events returns NO_DATA before any replay; overlapping windows are not independent evidence',()=>{
 assert.throws(()=>coveredWindows(input(),[{ts:DAY_MS}],now),{code:'NO_DATA'});
 const i=input(raw(),{fromMs:now-2*DAY_MS,recentFromMs:now-2*DAY_MS}),c=coveredWindows(i,[{ts:now-1}],now);
 assert.equal(c.recent.fromMs,c.cumulative.fromMs);assert.equal(RULES.confirmation.assessments,2);assert.equal(RULES.confirmation.minimumSpacingDays,7);
 assert.equal(RULES.requireNewCompletedTradesForConfirmation,true);assert.equal(RULES.confirmation.newDataThroughRequired,true);
});
test('OFF is explicit, active gate loads exact archived bytes and arbitrary fixed threshold without fallback',()=>{
 const bytes=raw(),i=input(bytes),calls:any[]=[],state={ready:true,gateEnabled:true,modelSha256:i.modelSha256,threshold:i.threshold};
 const runtime={setMLGateOverride:(...a:any[])=>calls.push(['override',...a]),setMLGateDeployment:(...a:any[])=>calls.push(['deployment',...a]),setMLWindowStart:(...a:any[])=>calls.push(['window',...a]),loadModelFromJSON:(...a:any[])=>{calls.push(['load',...a]);return true;},getMLGateStatus:()=>state};
 configureMonitorArm({input:i,raw:bytes,fromMs:i.fromMs},false,runtime);
 assert.deepEqual(calls[0],['override','JP225',false]);assert.equal(calls.some(c=>c[0]==='load'),false);
 calls.length=0;configureMonitorArm({input:i,raw:bytes,fromMs:i.fromMs},true,runtime);
 assert.deepEqual(calls[0],['override','JP225',true]);assert.equal(calls.find(c=>c[0]==='deployment')[2].threshold,.573);assert.equal(calls.find(c=>c[0]==='load')[1],bytes.toString());
 assert.equal(calls.find(c=>c[0]==='window')[1],i.fromMs-1);
 assert.throws(()=>configureMonitorArm({input:i,raw:bytes,fromMs:i.fromMs},true,{...runtime,loadModelFromJSON:()=>false}),/no default/);
 for(const change of [{ready:false},{gateEnabled:false},{modelSha256:'0'.repeat(64)},{threshold:.65}]) assert.throws(()=>verifyGate(i,{...state,...change}),/Exact archived/);
});
test('actual production loader proves exact archived SHA/threshold on a tiny pure fixture and rejects unfit models',()=>{
 const fixture=(ticker:string,accuracy=.8)=>Buffer.from(JSON.stringify({features:[...LEGACY_FEATURE_NAMES],meta:{ticker,train_end_ms:DAY_MS,available_at_ms:2*DAY_MS,feature_names:[...LEGACY_FEATURE_NAMES],threshold:.65,accuracy,f1:.7,train_samples:100},xgboost_model:{learner:{objective:{name:'binary:logistic'},learner_model_param:{num_feature:'12',num_class:'0',num_target:'1',base_score:'5E-1'},gradient_booster:{name:'gbtree',model:{tree_info:[0],trees:[{left_children:[-1],right_children:[-1],split_indices:[0],split_conditions:[.2],base_weights:[.2],default_left:[0],split_type:[0]}]}}}}}));
 for(const ticker of ['MONITORTEST','MONITORBAD']) {
  const bytes=fixture(ticker,ticker==='MONITORBAD'?.54:.8),i=input(bytes,{ticker,config:{ticker}});
  validateInput(i,bytes,now);
  try {
   if(ticker==='MONITORBAD') {
    assert.throws(()=>configureMonitorArm({input:i,raw:bytes,fromMs:i.fromMs},true),/rejected/);
    assert.equal(getMLGateStatus(ticker).ready,false);
   } else {
    configureMonitorArm({input:i,raw:bytes,fromMs:i.fromMs},true);
    const s=getMLGateStatus(ticker);assert.equal(s.ready,true);assert.equal(s.modelSha256,hash(bytes));assert.equal(s.threshold,.573);assert.equal(s.gateEnabled,true);
   }
  } finally {setMLGateOverride(ticker,undefined);setMLGateDeployment(ticker,undefined);setMLWindowStart(0);}
 }
});
test('current data/source bytes and file identity are reverified, never require original model training files',()=>{
 const bytes=Buffer.from('new post-activation dataset'),files=[{path:'/new/data.csv',sha256:hash(bytes)}];
 verifyFrozenFiles(files,()=>bytes);
 assert.throws(()=>verifyFrozenFiles(files,()=>Buffer.from('changed')),/Frozen input changed/);
 assert.match(getCriticalSourceFingerprint(),/^[a-f0-9]{64}$/);
});
test('sample floor wins over PnL sign in every arm and window',()=>{
 for(const name of ['cumulative','recent']) for(const arm of ['baseline','active']) {
  const w:any=windows(window(-100),window(-100));w[name][arm].n=29;
  assert.equal(assessSignals(w).baseSignal,'INSUFFICIENT_DATA');
 }
 assert.equal(assessSignals(windows(),true).baseSignal,'INSUFFICIENT_DATA');
});
test('maintain requires positive deltas in BOTH windows and predeclared drawdown allowance',()=>{
 assert.equal(assessSignals(windows(window(1),window(.01))).baseSignal,'MAINTAIN');
 assert.equal(assessSignals(windows(window(1,30,2,3.5),window(1,30,0,1))).baseSignal,'MAINTAIN');
 assert.equal(assessSignals(windows(window(1,30,2,3.50001),window(1))).baseSignal,'OBSERVE');
 assert.equal(assessSignals(windows(window(0),window(1))).baseSignal,'OBSERVE');
 assert.equal(assessSignals(windows(window(1),window(-1))).baseSignal,'OBSERVE');
});
test('recalibrate and severe disable are signals only, not actions or overlapping-window confirmations',()=>{
 assert.equal(assessSignals(windows(window(-2),window(-2))).baseSignal,'RECALIBRATE_SIGNAL');
 assert.equal(assessSignals(windows(window(-5,30,2,4.01),window(-5,30,1,3.01))).baseSignal,'DISABLE_SIGNAL');
 assert.equal(assessSignals(windows(window(-5,30,2,4),window(-5,30,1,3.01))).baseSignal,'RECALIBRATE_SIGNAL');
 assert.equal(assessSignals(windows(window(-2),window(-1.99))).baseSignal,'OBSERVE');
 assert.equal(RULES.automation,false);assert.equal(Object.isFrozen(RULES.disable),true);
});
test('nonfinite or inconsistent metrics cannot silently recommend any action',()=>{
 assert.equal(validMetrics(metrics(1)),true);assert.equal(validMetrics({...metrics(1),pf:Infinity}),false);
 const bad:any=windows();bad.recent.deltaR=9;assert.throws(()=>assessSignals(bad),/inconsistent/);
 const invalid:any=windows();invalid.cumulative.active.pnlR=NaN;assert.throws(()=>assessSignals(invalid),/metrics/);
});
test('unavailable results have no invented windows, trades, performance or blocked percentage',async()=>{
 const result=await monitorActiveModel(input(raw(),{modelPath:'/missing-monitor-test-model.json'}));
 assert.equal(result.status,'unavailable');assert.equal(result.baseSignal,'INSUFFICIENT_DATA');assert.equal(result.windows,undefined);assert.equal(result.blockedFraction,undefined);assert.equal(result.automaticAction,false);assert.equal(result.applyEligible,false);
});
