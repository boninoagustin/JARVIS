// Offline lifecycle regressions: artificial reports, transactional memory DB only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assetFingerprint} from './weekly_candidate_safety.js';
import {mapAssetConfig} from './selection_context.js';
import {applyWeeklyRollout,isEvaluationSource} from './weekly_rollout.js';
for(const file of ['update_adr_guarded.ts','timesfm_followup_recorder.py'])assert.equal(isEvaluationSource(`/opt/JARVIS/scripts/periodic_opt/${file}`),false);
for(const file of ['/opt/JARVIS/src/engine/AlphaModel.ts','/opt/JARVIS/jarvis-os/src/services/backtestEngine.ts','/opt/JARVIS/scripts/periodic_opt/eval_production.ts'])assert.equal(isEvaluationSource(file),true);
const now=Date.now();
const base={ticker:'EURUSD',enabled:true,fixedRR:2};
function report(timestamp=now-100):any {
 const asset={...base,fixedRR:2.5},config={...mapAssetConfig('EURUSD',asset),mlGate:{enabled:false}},hash=assetFingerprint(config),evaluation='e'.repeat(64);
 return {ticker:'EURUSD',timestamp,status:'RECOMMEND',apply_eligible:false,production_asset_snapshot:base,production_asset_fingerprint:assetFingerprint(base),final_asset_config:asset,final_asset_fingerprint:assetFingerprint(asset),final_config:config,evaluation_fingerprint:evaluation,proposal_validation:{trade_count:12,expectancy:.3,net_pnl_r:3.6,max_drawdown_r:2},production_validation:{trade_count:12,expectancy:.1,net_pnl_r:1.2,max_drawdown_r:3},montecarlo:{survival:.95,config_fingerprint:hash,evaluation_fingerprint:evaluation},certificate:{version:1,config_fingerprint:hash,asset_fingerprint:assetFingerprint(asset),evaluation_fingerprint:evaluation,montecarlo_config_fingerprint:hash,validation_role:'selection_validation',test_independence:'unverified',test_evaluated:false}};
}
function database() {
 const docs:any={'asset_configs/EURUSD':structuredClone(base),'optimization_config/auto_state':{}};
 const control:any={failConfirmation:false,beforeTransaction:null};
 const ref=(key:string):any=>({key,get:async()=>({exists:docs[key]!==undefined,data:()=>structuredClone(docs[key])})});
 const db:any={doc:ref,collection:()=>({where:()=>({limit:()=>({query:true})})}),runTransaction:async(cb:any)=>{
  if(control.beforeTransaction)await control.beforeTransaction();
  const pending:any[]=[];
  const result=await cb({get:async(r:any)=>r.query?{empty:true}:r.get(),set:(r:any,v:any)=>pending.push([r.key,structuredClone(v)])});
  if(control.failConfirmation && pending.some(([k,v])=>k==='optimization_config/auto_state'&&v.applied?.EURUSD?.confirmed_at_ms)){
   control.failConfirmation=false;throw new Error('synthetic confirmation transaction failure');
  }
  for(const [key,v]of pending)docs[key]=v;
  return result;
 }};
 return {db,docs,control};
}
async function scenario(run:(s:any)=>Promise<void>) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weekly-recovery-')),d=database(),r=report();
 const write=(value:any)=>fs.writeFileSync(path.join(root,'EURUSD.json'),JSON.stringify(value));write(r);
 const opts={db:d.db,reportsDir:root,now:()=>now,verifyArtifacts:()=>({ok:true,reason:'synthetic fixture'})};
 try{await run({...d,root,r,write,opts});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
await scenario(async({docs,control,r,write,opts}:any)=>{
 control.failConfirmation=true;
 await applyWeeklyRollout({...opts,skipFollowup:true});
 assert.equal(docs['optimization_config/auto_state'].applied.EURUSD.confirmation_pending,true);
 write({...report(now+100),status:'HOLD'});
 let evaluations=0;
 await applyWeeklyRollout({...opts,now:()=>now+200,followup:async(input:any)=>{
  evaluations++;assert.equal(input.appliedAt,now+200);return {decision:'PENDING',reason:'fixture'};
 }});
 const state=docs['optimization_config/auto_state'];
 assert.equal(state.applied.EURUSD.confirmation_pending,false,'durable pending deployment must recover before a replaced local report is processed');
 assert.equal(state.applied.EURUSD.confirmed_at_ms,now+200);
 assert.equal(evaluations,1,'recovered deployment must be eligible for followup immediately');
 const audit=docs[`optimization_rollouts/EURUSD_${r.timestamp}`];
 assert.equal(audit.application.confirmed_at_ms,now+200);
 await applyWeeklyRollout({...opts,followupOnly:true,now:()=>now+300,followup:async(input:any)=>{
  assert.equal(input.appliedAt,now+200,'confirmed clock is immutable on retry');return {decision:'PENDING',reason:'fixture'};
 }});
 assert.equal(docs['optimization_config/auto_state'].applied.EURUSD.confirmed_at_ms,now+200);
});
console.log('PASS: durable confirmation recovery precedes replaced reports and preserves confirmed clock');
await scenario(async({docs,r,write,root,opts}:any)=>{
 await applyWeeklyRollout({...opts,skipFollowup:true});
 await applyWeeklyRollout({...opts,followupOnly:true,followup:async()=>({decision:'ROLLBACK',reason:'synthetic degradation'})});
 const auditKey=`optimization_rollouts/EURUSD_${r.timestamp}`,audit=structuredClone(docs[auditKey]);
 const trackPath=path.join(root,'rollouts',`EURUSD_${r.timestamp}.json`),tracking=fs.readFileSync(trackPath,'utf8');
 write({...report(now+100),status:'HOLD'});
 await applyWeeklyRollout({...opts,skipFollowup:true,now:()=>now+200});
 assert.equal(docs['optimization_config/auto_state'].latest.EURUSD.status,'UNCHANGED');
 const latest=structuredClone(docs['optimization_config/auto_state'].latest.EURUSD);
 write(r);
 await applyWeeklyRollout({...opts,skipFollowup:true,now:()=>now+300});
 assert.deepEqual(docs['asset_configs/EURUSD'],base,'immutable audit prevents rollback->HOLD->old-report reapplication');
 assert.deepEqual(docs[auditKey],audit,'retry cannot overwrite original deployment/rollback audit');
 assert.deepEqual(docs['optimization_config/auto_state'].latest.EURUSD,latest,'old retry cannot replace newer status');
 assert.equal(fs.readFileSync(trackPath,'utf8'),tracking,'tracking snapshot survives retry unchanged');
});
console.log('PASS: rollback audit remains authoritative after newer HOLD');
for(const mode of ['state','published','transaction-state','transaction-published','transaction-audit'] as const){
 await scenario(async({docs,control,r,opts}:any)=>{
  const successor={status:'UNCHANGED',report_timestamp:r.timestamp+1,reason:'newer HOLD'};
  const auditKey=`optimization_rollouts/EURUSD_${r.timestamp}`;
  const install=()=>{
   if(mode.endsWith('audit'))docs[auditKey]={immutable:'existing transaction winner'};
   else if(mode.endsWith('published'))docs['opt_reports/EURUSD']={...report(r.timestamp+1),status:'HOLD'};
   else docs['optimization_config/auto_state'].latest={EURUSD:successor};
  };
  if(mode.startsWith('transaction')){
   let transactions=0;control.beforeTransaction=()=>{if(++transactions===2)install();};
  }else install();
  await applyWeeklyRollout({...opts,skipFollowup:true});
  assert.deepEqual(docs['asset_configs/EURUSD'],base,`${mode}: older/racing report cannot commit`);
  if(mode.endsWith('audit'))assert.deepEqual(docs[auditKey],{immutable:'existing transaction winner'},'audit created concurrently is never overwritten');
  else assert.equal(docs[auditKey],undefined,'rejected version cannot create deployment audit');
  if(mode.endsWith('state'))assert.deepEqual(docs['optimization_config/auto_state'].latest.EURUSD,successor,'older status cannot replace newer state');
  if(mode.endsWith('published'))assert.equal(docs['opt_reports/EURUSD'].timestamp,r.timestamp+1,'newer published report is preserved');
 });
}
console.log('PASS: older versions and concurrent audit/version winners cannot be overwritten');
await scenario(async({docs,r,opts}:any)=>{
 await applyWeeklyRollout({...opts,skipFollowup:true});
 await applyWeeklyRollout({...opts,followupOnly:true,followup:async()=>({decision:'KEEP',reason:'completed synthetic comparison'})});
 const state=structuredClone(docs['optimization_config/auto_state']),audit=structuredClone(docs[`optimization_rollouts/EURUSD_${r.timestamp}`]);
 let evaluations=0;
 await applyWeeklyRollout({...opts,followupOnly:true,followup:async()=>{evaluations++;return {decision:'PENDING',reason:'engine source later changed'};}});
 assert.equal(evaluations,0,'completed KEEP must not be reevaluated after legitimate engine update');
 assert.deepEqual(docs['optimization_config/auto_state'],state,'completed review must not resurrect in pending queue');
 assert.deepEqual(docs[`optimization_rollouts/EURUSD_${r.timestamp}`],audit,'first completed comparison remains durable');
});
console.log('PASS: completed comparison is not reevaluated or resurrected');
for(const mode of ['no-file','manual-change','superseded','published-identity','audit-identity','track-version','dry-run','partial-clock','review-clock','review-only'] as const){
 await scenario(async({docs,control,r,root,opts}:any)=>{
  control.failConfirmation=true;
  await applyWeeklyRollout({...opts,skipFollowup:true});
  const state=docs['optimization_config/auto_state'],id=`EURUSD_${r.timestamp}`;
  if(mode==='no-file')fs.unlinkSync(path.join(root,'EURUSD.json'));
  if(mode==='manual-change')docs['asset_configs/EURUSD'].fixedRR=7;
  if(mode==='superseded')docs['opt_reports/EURUSD']={...report(r.timestamp+1),status:'HOLD'};
  if(mode==='published-identity')docs['opt_reports/EURUSD'].proposal_validation.expectancy=99;
  if(mode==='audit-identity')docs[`optimization_rollouts/${id}`].source_files=[{path:'/fixture/tampered.ts',sha256:'a'.repeat(64)}];
  if(mode==='track-version'){
   const file=state.applied.EURUSD.track_path,track=JSON.parse(fs.readFileSync(file,'utf8'));track.report_timestamp++;fs.writeFileSync(file,JSON.stringify(track));
  }
  if(mode==='partial-clock'||mode==='review-clock'){
   state.applied.EURUSD.confirmed_at_ms=now+50;state.reviews[id].confirmed_at_ms=now+50;
   docs[`optimization_rollouts/${id}`].application.confirmed_at_ms=now+50;docs['opt_reports/EURUSD'].application.confirmed_at_ms=now+50;
   if(mode==='review-clock')state.applied.EURUSD.confirmation_pending=false;
  }
  if(mode==='review-only')delete state.applied.EURUSD;
  const before=structuredClone(docs);let evaluations=0;
  const result=await applyWeeklyRollout({...opts,followupOnly:true,dryRun:mode==='dry-run',now:()=>now+200,followup:async(input:any)=>{
   evaluations++;assert.equal(input.appliedAt,['partial-clock','review-clock'].includes(mode)?now+50:now+200);return {decision:'PENDING',reason:'fixture'};
  }});
  if(['no-file','partial-clock','review-clock'].includes(mode)){
   assert.equal(evaluations,1,`${mode}: recovery does not depend on local report and preserves any original confirmed clock`);
   assert.equal(docs['optimization_config/auto_state'].applied.EURUSD.confirmation_pending,false);
   assert.equal(docs['optimization_config/auto_state'].reviews[id].confirmation_pending,false);
  }else{
   assert.equal(evaluations,0,`${mode}: unsafe identity cannot start future evaluation`);
   assert.ok(result.outcomes.some((o:any)=>o.followup?.status==='PENDING'),`${mode}: unsafe recovery returns pending`);
   assert.equal((docs['optimization_config/auto_state'].applied?.EURUSD??docs['optimization_config/auto_state'].reviews[id]).confirmation_pending,true);
   assert.deepEqual(docs['asset_configs/EURUSD'],before['asset_configs/EURUSD'],'never undo operator/successor config');
   if(mode==='dry-run')assert.deepEqual(docs,before,'dry run cannot recover through writes');
  }
 });
}
console.log('PASS: missing files, exact identity checks, dry-run, supersession and partial-clock recovery');
