// In-memory DB and explicitly artificial reports. No broker/Firestore access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assetFingerprint} from './weekly_candidate_safety.js';
import {mapAssetConfig} from './selection_context.js';
assert.equal(fs.existsSync('scripts/periodic_opt/weekly_rollout.ts'),true,'automatic weekly rollout must be implemented');
const {applyWeeklyRollout,verifyEvaluationArtifacts}=await import('./weekly_rollout.js');
// UI/deployment code cannot invalidate a completed engine evaluation. Engine/data changes can.
{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weekly-artifacts-'));
 const data=path.join(dir,'events.csv');fs.writeFileSync(data,'explicit synthetic fixture');
 const {createHash}=await import('node:crypto');
 const digest=createHash('sha256').update(fs.readFileSync(data)).digest('hex');
 const provenance={source_files:[{path:'/opt/JARVIS/jarvis-os/src/components/PeriodicOptPanel.tsx',sha256:'0'.repeat(64)},{path:data,sha256:digest}],dataset_files:[{path:data,sha256:digest}]};
 const report={evaluation_provenance:provenance,evaluation_fingerprint:assetFingerprint(provenance)};
 assert.equal(verifyEvaluationArtifacts(report).ok,true,'operational UI edits do not change evaluated engine');
 fs.writeFileSync(data,'changed fixture');
 assert.equal(verifyEvaluationArtifacts(report).ok,false,'changed evaluation inputs block deployment');
 fs.rmSync(dir,{recursive:true,force:true});
}
const now=Date.now();
const base={ticker:'EURUSD',enabled:true,fixedRR:2,sessions:{NY:{bos5m:{enabled:true,minScore:4}}}};
function fixture():any {
 const asset={...structuredClone(base),fixedRR:2.5};const config={...mapAssetConfig('EURUSD',asset),mlGate:{enabled:false}};const hash=assetFingerprint(config);
 return {ticker:'EURUSD',timestamp:now-100,status:'RECOMMEND',apply_eligible:false,production_asset_snapshot:structuredClone(base),production_asset_fingerprint:assetFingerprint(base),final_asset_config:asset,final_asset_fingerprint:assetFingerprint(asset),final_config:config,evaluation_fingerprint:'e'.repeat(64),proposal_validation:{trade_count:12,expectancy:.3,net_pnl_r:3.6,max_drawdown_r:2},production_validation:{trade_count:12,expectancy:.1,net_pnl_r:1.2,max_drawdown_r:3},montecarlo:{survival:.95,config_fingerprint:hash,evaluation_fingerprint:'e'.repeat(64)},certificate:{version:1,config_fingerprint:hash,asset_fingerprint:assetFingerprint(asset),evaluation_fingerprint:'e'.repeat(64),montecarlo_config_fingerprint:hash,validation_role:'selection_validation',test_independence:'unverified',test_evaluated:false}};
}
function database(initial:any,options:any={}) {
 const docs:any=structuredClone(initial);const calls:string[]=[];let tx=false;
 const ref=(key:string):any=>({key,get:async()=>{calls.push(`read:${key}`);return {exists:docs[key]!==undefined,data:()=>structuredClone(docs[key])};},set:async(v:any)=>{calls.push(`write:${key}`);docs[key]=structuredClone(v);}});
 const collection=(name:string):any=>({doc:(id:string)=>ref(`${name}/${id}`),where:()=>({limit:()=>({query:name})})});
 const db:any={doc:ref,collection,runTransaction:async(cb:any)=>{const pending:any[]=[];tx=true;const result=await cb({get:async(r:any)=>r.query?{empty:!options.open,size:options.open?1:0}:r.get(),set:(r:any,v:any)=>pending.push([r.key,v])});tx=false;for(const [key,v]of pending){calls.push(`write:${key}`);docs[key]=structuredClone(v);}return result;}};
 return {db,docs,calls};
}
async function exercise(options:any={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weekly-rollout-test-'));const report=fixture();if(options.mutate)options.mutate(report);
 fs.writeFileSync(path.join(root,'EURUSD.json'),JSON.stringify(report));
 const d=database({'asset_configs/EURUSD':options.current??base,'optimization_config/auto_state':{}},options);
 const before=fs.readdirSync(root);
 try {const result=await applyWeeklyRollout({db:d.db,reportsDir:root,dryRun:!!options.dryRun,now:()=>now,verifyArtifacts:()=>({ok:true,reason:'artificial fixture only'}),followup:async()=>({status:'PENDING',reason:'fixture: no future observations'})});return {...d,result,files:fs.readdirSync(root),before,report};}finally{fs.rmSync(root,{recursive:true,force:true});}
}
const dry=await exercise({dryRun:true});assert.deepEqual(dry.calls.filter(x=>x.startsWith('write:')),[],'dry run zero external writes');assert.deepEqual(dry.files,dry.before,'dry run zero backup/report writes');
const applied=await exercise();assert.deepEqual(applied.docs['asset_configs/EURUSD'],applied.report.final_asset_config,'writes exact evaluated asset');assert.equal(applied.docs['optimization_config/auto_state'].applied.EURUSD.policy_version,2);assert.ok(Number.isSafeInteger(applied.docs['optimization_config/auto_state'].applied.EURUSD.confirmed_at_ms),'future review must start after read-back confirmation, never before commit');assert.equal(applied.docs['opt_reports/EURUSD'].application.status,'APPLIED');assert.equal(applied.report.apply_eligible,false,'does not forge future certification');
for(const options of [{open:true},{current:{...base,enabled:false}},{current:{...base,fixedRR:3}},{mutate:(r:any)=>r.status='HOLD'},{mutate:(r:any)=>r.timestamp=now-49*3600000}]) {const result=await exercise(options);assert.deepEqual(result.docs['asset_configs/EURUSD'],options.current??base,'failed gates must preserve production');}
console.log('PASS: weekly exact rollout, no-write dry-run, open-position/disabled/concurrent/stale/HOLD protection');
// Exercise the real apply->review->rollback transaction, not a source-string assertion.
for (const mode of ['rollback','keep','insufficient','operator-change','open','review-failure','retry'] as const) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weekly-lifecycle-'));
 try {
  const report=fixture();fs.writeFileSync(path.join(root,'EURUSD.json'),JSON.stringify(report));
  const opts:any={};const d=database({'asset_configs/EURUSD':base,'optimization_config/auto_state':{}},opts);
  const shared:any={db:d.db,reportsDir:root,now:()=>now,verifyArtifacts:()=>({ok:true,reason:'artificial fixture'})};
  await applyWeeklyRollout({...shared,skipFollowup:true});
  const oldClock=d.docs['optimization_config/auto_state'].applied.EURUSD.at;
  if(mode==='operator-change')d.docs['asset_configs/EURUSD']={...d.docs['asset_configs/EURUSD'],disabledReason:'manual change',enabled:false};
  if(mode==='open')opts.open=true;
  if(mode==='retry'){
   const priorWrites=d.calls.filter(x=>x.startsWith('write:')).length;
   await applyWeeklyRollout({...shared,skipFollowup:true,now:()=>now+10000});
   assert.equal(d.calls.filter(x=>x.startsWith('write:')).length,priorWrites,'retry is idempotent');
   assert.equal(d.docs['optimization_config/auto_state'].applied.EURUSD.at,oldClock,'retry preserves future cutoff');
  }else{
   await applyWeeklyRollout({...shared,followupOnly:true,followup:async(input:any)=>{
    assert.equal(input.appliedAt,oldClock);assert.deepEqual(input.beforeAsset,base);
    if(mode==='review-failure')throw new Error('fixture evaluator unavailable');
    return {decision:mode==='insufficient'?'PENDING':mode==='keep'?'KEEP':'ROLLBACK',reason:'explicit synthetic followup evidence',evidencePath:'/fixture/evidence.json',evidenceFingerprint:'e'.repeat(64)};
   }});
   if(mode==='rollback'){
    assert.deepEqual(d.docs['asset_configs/EURUSD'],base,'rollback restores exact original');
    assert.equal(d.docs['optimization_config/auto_state'].latest.EURUSD.status,'ROLLED_BACK');
    await applyWeeklyRollout({...shared,skipFollowup:true});
    assert.deepEqual(d.docs['asset_configs/EURUSD'],base,'rolled-back report cannot reapply on retry');
   }else if(mode==='operator-change')assert.equal(d.docs['asset_configs/EURUSD'].disabledReason,'manual change','never undo operator change');
   else assert.deepEqual(d.docs['asset_configs/EURUSD'],report.final_asset_config,'retain current asset without valid safe rollback');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
console.log('PASS: seven real deployment lifecycle scenarios, including exact rollback, retained config and idempotent retry');
{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weekly-review-queue-'));
 try{
  const r=fixture();fs.writeFileSync(path.join(root,'EURUSD.json'),JSON.stringify(r));
  const d=database({'asset_configs/EURUSD':base,'optimization_config/auto_state':{}});
  const opts:any={db:d.db,reportsDir:root,now:()=>now,skipFollowup:true,verifyArtifacts:()=>({ok:true,reason:'fixture'})};
  await applyWeeklyRollout(opts);
  const next=fixture();next.timestamp=now+100;next.production_asset_snapshot=r.final_asset_config;next.production_asset_fingerprint=assetFingerprint(r.final_asset_config);next.final_asset_config={...r.final_asset_config,fixedRR:3};next.final_config={...mapAssetConfig('EURUSD',next.final_asset_config),mlGate:{enabled:false}};next.final_asset_fingerprint=next.certificate.asset_fingerprint=assetFingerprint(next.final_asset_config);next.certificate.config_fingerprint=next.certificate.montecarlo_config_fingerprint=next.montecarlo.config_fingerprint=assetFingerprint(next.final_config);
  fs.writeFileSync(path.join(root,'EURUSD.json'),JSON.stringify(next));await applyWeeklyRollout({...opts,now:()=>now+200});
  assert.equal(Object.keys(d.docs['optimization_config/auto_state'].reviews??{}).length,2,'replacing a version must retain its pending future review');
  let reviews=0;await applyWeeklyRollout({...opts,skipFollowup:false,followupOnly:true,now:()=>now+300,followup:async()=>{reviews++;return {decision:'ROLLBACK',reason:'synthetic archived/current degradation'};}});
  assert.equal(reviews,2,'both current and archived versions are reviewed');
  assert.deepEqual(d.docs['asset_configs/EURUSD'],r.final_asset_config,'only the actually current version can be rolled back');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
console.log('PASS: pending review queue survives replacement; archived recommendations cannot overwrite a newer live version');
