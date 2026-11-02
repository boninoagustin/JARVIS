/** Authorized weekly deployment, separate from prospective certification.
 * Every external write is transactional and read back. Dry-run writes NOTHING.
 * Exact evaluated assets only; no broker mutation, preset rewrite or model promotion.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assetFingerprint,checkWeeklyCandidate} from './weekly_candidate_safety.js';

type Check={ok:boolean;reason:string;compatibility?:any[]};
export type RolloutOptions={db:any;reportsDir:string;dryRun?:boolean;tickers?:string[];followupOnly?:boolean;skipFollowup?:boolean;now?:()=>number;verifyArtifacts?:(report:any)=>Check;followup?:(input:any)=>Promise<any>};
const clone=(v:any)=>JSON.parse(JSON.stringify(v));
const sha=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const validTicker=(v:any)=>typeof v==='string' && /^[A-Z][A-Z0-9]{0,20}$/.test(v);
// Application/followup metadata is mutable; the evaluated report identity is not.
const reportIdentity=(report:any)=>{const {application,followup,appliedAt,appliedBy,...identity}=report;return assetFingerprint(identity);};
const reportVersion=(state:any,ticker:string,published:any)=>Math.max(0,...[state.report_versions?.[ticker],state.latest?.[ticker]?.report_timestamp,
 state.applied?.[ticker]?.report_timestamp,published?.timestamp,...Object.entries<any>(state.reviews??{}).filter(([id,s])=>(s.ticker??id.split('_')[0])===ticker).map(([,s])=>s.report_timestamp)].filter(Number.isSafeInteger));

/** Provenance inventories also contain UI/tests/deployment code, which never
 * execute inside the evaluated strategy. Keep every other source byte pinned. */
export function isEvaluationSource(file:string):boolean {
 const relative=path.relative('/opt/JARVIS',path.resolve(file));
 if (/^jarvis-os\/src\/components\//.test(relative)) return false;
 if (/^scripts\/.*(?:^|\/)test_[^/]+\.(?:ts|py)$/.test(relative)) return false;
 return !new Set(['scripts/periodic_opt/run_weekly.py','scripts/periodic_opt/apply_weekly.ts',
  'scripts/periodic_opt/weekly_candidate_safety.ts','scripts/periodic_opt/weekly_rollout.ts',
  'scripts/periodic_opt/weekly_followup.ts','scripts/periodic_opt/push_reports.js',
  'scripts/periodic_opt/update_adr_guarded.ts','scripts/periodic_opt/timesfm_followup_recorder.py']).has(relative);
}

/** Verify actual evaluation inputs, never an invented certificate from a boolean. */
function reviewedSourceCompatibility(item:any,currentHash:string,manifest:any):any|null {
 try {
  if(manifest?.version!==1 || !Number.isSafeInteger(manifest.valid_until_ms) || manifest.valid_until_ms<Date.now())return null;
  const change=manifest.changes?.find((c:any)=>c.path===item.path && c.from_sha256===item.sha256 && c.to_sha256===currentHash);
  if(!change || sha(change.baseline_path)!==item.sha256 || sha(change.verification_path)!==change.verification_sha256)return null;
  const proof=JSON.parse(fs.readFileSync(change.verification_path,'utf8'));
  if(proof.passed!==true || proof.exit_code!==0 || proof.files?.[item.path]?.before!==item.sha256 || proof.files?.[item.path]?.after!==currentHash)return null;
  return change;
 }catch{return null;}
}
export function verifyEvaluationArtifacts(report:any,options:{compatibilityManifest?:any}={}):Check {
 try {
  const p=report.evaluation_provenance;
  const compatibility:any[]=[];
  const manifestPath='/opt/JARVIS/scripts/periodic_opt/evaluation_source_compatibility.json';
  const manifest=options.compatibilityManifest??(fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):null);
  if (!p || assetFingerprint(p)!==report.evaluation_fingerprint) return {ok:false,reason:'proveniencia de evaluación ausente o alterada'};
  if (!Array.isArray(p.source_files) || !p.source_files.length || !Array.isArray(p.dataset_files) || !p.dataset_files.length)
   return {ok:false,reason:'faltan identidades de motor/datos evaluados'};
  for (const group of ['source_files','dataset_files','manifest_files','model_files','cache_files']) {
   for (const item of p[group]??[]) {
    if (group==='source_files' && typeof item.path==='string' && !isEvaluationSource(item.path)) continue;
    if (typeof item.path!=='string' || !/^[a-f0-9]{64}$/.test(item.sha256??'') || !fs.existsSync(item.path))return {ok:false,reason:`falta un archivo evaluado (${group}): ${item.path??'sin ruta'}`};
    const currentHash=sha(item.path);
    if(currentHash!==item.sha256){
     const reviewed=group==='source_files'?reviewedSourceCompatibility(item,currentHash,manifest):null;
     if(!reviewed)return {ok:false,reason:`cambió un archivo evaluado (${group}): ${item.path}`};
     compatibility.push(reviewed);
    }
   }
  }
  return {ok:true,reason:'motor, datos, modelos y cachés verificados'+(compatibility.length?' (extensión de seguimiento compatible verificada)':''),compatibility};
 } catch(e:any){return {ok:false,reason:`no se pudo verificar la evaluación: ${e.message}`};}
}

/** Register a separate live-observation stream. Historical cache bytes and
 * historical forecast timestamps are never relabelled as live availability. */
export function registerLiveForecastLedger(ticker:string,report:any,logsRoot='/opt/JARVIS/logs',registeredAt=Date.now()):any {
 if(!validTicker(ticker))throw new Error('ticker inválido para registro de forecasts');
 if(report.final_asset_config?.timesfm?.enabled!==true && report.production_asset_snapshot?.timesfm?.enabled!==true)return null;
 const cache=report.final_config?.timesfm?.cachePath??report.production_backtest_config?.timesfm?.cachePath??report.evaluation_provenance?.cache_files?.[0]?.path;
 if(typeof cache!=='string'||!fs.existsSync(cache))throw new Error('TimesFM: falta identidad del modelo histórico evaluado');
 const rows=fs.readFileSync(cache,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
 const versions=[...new Set(rows.map(row=>row.model_version))];
 if(versions.length!==1 || typeof versions[0]!=='string' || !versions[0])throw new Error('TimesFM: identidad de modelo ambigua');
 for(const asset of [report.final_asset_config,report.production_asset_snapshot])if(asset?.timesfm?.liveModelVersion && asset.timesfm.liveModelVersion!==versions[0])throw new Error('TimesFM: modelo vivo distinto del modelo evaluado');
 let dir=path.resolve(logsRoot);
 if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true});
 if(fs.lstatSync(dir).isSymbolicLink())throw new Error('logs-root no puede ser symlink');
 for(const segment of [ticker.toLowerCase(),'forecasts']){
  dir=path.join(dir,segment);
  if(fs.existsSync(dir)){if(fs.lstatSync(dir).isSymbolicLink()||!fs.statSync(dir).isDirectory())throw new Error('ruta de ledger insegura');}
  else fs.mkdirSync(dir);
 }
 const file=path.join(dir,'live_followup_ledger.jsonl');
 if(fs.existsSync(file)){if(fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())throw new Error('ledger inseguro');}
 else fs.writeFileSync(file,'',{flag:'wx',mode:0o600});
 const bytes=fs.readFileSync(file);const end=bytes.lastIndexOf(10)+1;
 return {path:file,model_version:versions[0],registered_at_ms:registeredAt,prefix_size_bytes:end,
  prefix_sha256:createHash('sha256').update(bytes.subarray(0,end)).digest('hex')};
}

export function readBrokerCalendar(ticker:string):any {
 const root='/opt/JARVIS/logs/rollover_safety';
 if (!fs.existsSync(root)) return null;
 const files=fs.readdirSync(root).filter(f=>f.endsWith(`_${ticker}_clean_reference.json`)).sort().reverse();
 for (const f of files) {
  try {
   const file=path.join(root,f),capture=JSON.parse(fs.readFileSync(file,'utf8'));
   if(capture.ticker!==ticker || !capture.symbol?.scheduleTimeZone || !Array.isArray(capture.symbol.schedule) || !capture.symbol.schedule.length) continue;
   return {ticker,scheduleTimeZone:capture.symbol.scheduleTimeZone,schedule:capture.symbol.schedule,
    source:{path:file,sha256:sha(file)},capture_date:capture.date};
  }catch{}
 }
 return null;
}

function writeJson(file:string,value:any,exclusive=false) {
 fs.mkdirSync(path.dirname(file),{recursive:true});
 if (exclusive) {
  if (fs.existsSync(file)) {
   if (assetFingerprint(JSON.parse(fs.readFileSync(file,'utf8')))!==assetFingerprint(value)) throw new Error(`respaldo existente difiere: ${file}`);
   return;
  }
  fs.writeFileSync(file,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
 } else {
  const tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);
 }
}

/** Recording DB boundaries make the real transaction path testable offline. */
export async function applyWeeklyRollout(options:RolloutOptions) {
 const {db,dryRun=false}=options;
 const dir=path.resolve(options.reportsDir),now=options.now??Date.now;
 const stateRef=db.doc('optimization_config/auto_state');
 const outcomes:any[]=[];
 const selected=options.tickers;
 if (selected?.some(t=>!validTicker(t))) throw new Error('ticker inválido');
 const want=(t:string)=>!selected || selected.includes(t);
 let initial=(await stateRef.get()).data()??{};
 const trackingRoot=path.join(dir,'rollouts');
 const readTrack=(st:any,t:string)=>{
  const target=path.resolve(st.track_path??'');
  if (path.dirname(target)!==trackingRoot || !path.basename(target).startsWith(`${t}_`)) throw new Error('ruta de seguimiento no válida');
  const track=JSON.parse(fs.readFileSync(target,'utf8'));
  if (track.ticker!==t || track.report_timestamp!==st.report_timestamp || track.applied_asset_fingerprint!==st.applied_asset_fingerprint ||
    assetFingerprint(track.appliedAsset)!==st.applied_asset_fingerprint || assetFingerprint(track.beforeAsset)!==track.before_fingerprint)
   throw new Error('snapshots de seguimiento no coinciden');
  return track;
 };
 const confirmDeployment=async(ticker:string,reportTimestamp:number,expectedHash:string)=>{
  const assetRef=db.doc(`asset_configs/${ticker}`),auditRef=db.doc(`optimization_rollouts/${ticker}_${reportTimestamp}`),publishedRef=db.doc(`opt_reports/${ticker}`);
  if(assetFingerprint((await assetRef.get()).data())!==expectedHash)throw new Error('configuración cambió antes de confirmar la aplicación');
  const confirmedAt=now(); // strictly AFTER an actual successful deployment readback
  await db.runTransaction(async(tx:any)=>{
   const asset=(await tx.get(assetRef)).data();const state=(await tx.get(stateRef)).data()??{};
   const audit=(await tx.get(auditRef)).data();const published=(await tx.get(publishedRef)).data();
   const st=state.applied?.[ticker];
   if(!st||st.report_timestamp!==reportTimestamp||st.applied_asset_fingerprint!==expectedHash||assetFingerprint(asset)!==expectedHash||published?.ticker!==ticker||published.timestamp!==reportTimestamp)throw new Error('no se pudo confirmar la identidad de la aplicación');
   const track=readTrack(st,ticker),id=`${ticker}_${reportTimestamp}`;
   if(!audit || assetFingerprint(Object.fromEntries(Object.keys(track).map(k=>[k,audit[k]])))!==assetFingerprint(track) ||
    audit.rolled_back_at_ms || audit.ticker!==ticker || audit.report_timestamp!==reportTimestamp ||
    audit.application?.tracking_id!==id || audit.application?.status!=='APPLIED' || audit.application.asset_fingerprint!==expectedHash ||
    published.application?.tracking_id!==id || published.application?.asset_fingerprint!==expectedHash ||
    published.final_asset_fingerprint!==expectedHash || assetFingerprint(published.final_asset_config)!==expectedHash ||
    assetFingerprint(audit.appliedAsset)!==expectedHash || assetFingerprint(audit.beforeAsset)!==track.before_fingerprint ||
    assetFingerprint(audit.evaluatedAppliedConfig)!==assetFingerprint(track.evaluatedAppliedConfig) ||
    assetFingerprint(published.final_config)!==assetFingerprint(track.evaluatedAppliedConfig) ||
    (track.report_fingerprint && (audit.report_fingerprint!==track.report_fingerprint || reportIdentity(published)!==track.report_fingerprint)))
     throw new Error('identidad de reporte/auditoría no coincide con el seguimiento');
   const clocks=[st.confirmed_at_ms,state.reviews?.[id]?.confirmed_at_ms,audit.application.confirmed_at_ms,published.application.confirmed_at_ms].filter(v=>v!==undefined);
   if(clocks.some(v=>!Number.isSafeInteger(v)||v!==clocks[0]))throw new Error('relojes de confirmación no coinciden');
   const clock=clocks[0]??confirmedAt;
   st.confirmed_at_ms=clock;st.confirmation_pending=false;
   if(state.reviews?.[`${ticker}_${reportTimestamp}`])Object.assign(state.reviews[`${ticker}_${reportTimestamp}`],{confirmed_at_ms:clock,confirmation_pending:false});
   if(state.latest?.[ticker]?.report_timestamp===reportTimestamp)state.latest[ticker].confirmed_at_ms=clock;
   audit.application.confirmed_at_ms=clock;published.application.confirmed_at_ms=clock;
   tx.set(stateRef,state);tx.set(auditRef,audit);tx.set(publishedRef,published);
  });
  const st=(await stateRef.get()).data()?.applied?.[ticker];
  const audit=(await auditRef.get()).data();const published=(await publishedRef.get()).data();
  if(!Number.isSafeInteger(st?.confirmed_at_ms)||audit?.application?.confirmed_at_ms!==st.confirmed_at_ms||published?.application?.confirmed_at_ms!==st.confirmed_at_ms)throw new Error('la confirmación de aplicación no persistió');
  return st.confirmed_at_ms;
 };
 const persistStatus=async(t:string,report:any,application:any,followup?:any)=>{
  if (dryRun) return;
  const saved=await db.runTransaction(async(tx:any)=>{
   const state=(await tx.get(stateRef)).data()??{};
   const ref=db.doc(`opt_reports/${t}`);const old=(await tx.get(ref)).data();
   if(!Number.isSafeInteger(report.timestamp)||report.timestamp<reportVersion(state,t,old))return false;
   state.report_versions??={};state.report_versions[t]=report.timestamp;
   state.latest??={};state.latest[t]={...application,report_timestamp:report.timestamp,...(followup?{followup}:{})};
   tx.set(stateRef,state);
   // Never replace a newer published report with metadata from a stale file.
   if (!old || old.timestamp===report.timestamp) tx.set(ref,{...report,application,...(followup?{followup}:{})});
   return true;
  });
  if(!saved)return;
  const state=(await stateRef.get()).data();
  if (assetFingerprint(state?.latest?.[t])!==assetFingerprint({...application,report_timestamp:report.timestamp,...(followup?{followup}:{})})) throw new Error(`${t}: estado de aplicación no persistido`);
  writeJson(path.join(dir,`${t}.json`),{...report,application,...(followup?{followup}:{})});
 };

 // Recovery is driven by durable queues, never by whichever local report survives.
 if(!dryRun){
  const pending={...Object.fromEntries(Object.entries<any>(initial.applied??{}).map(([t,s])=>[`${t}_${s.report_timestamp}`,{...s,ticker:t}])),...(initial.reviews??{})};
  for(const [id,st] of Object.entries<any>(pending)){
   const ticker=st.ticker??id.split('_')[0];
   if(!want(ticker)||!validTicker(ticker)||st.policy_version!==2||(!st.confirmation_pending&&Number.isSafeInteger(st.confirmed_at_ms)))continue;
   try{await confirmDeployment(ticker,st.report_timestamp,st.applied_asset_fingerprint);}
   catch(e:any){outcomes.push({ticker,followup:{status:'PENDING',reason:`confirmación pendiente: ${e.message}`}});}
  }
  initial=(await stateRef.get()).data()??{};
 }
 // Pending reviews survive replacement; an archived version can never overwrite a successor.
 const reviews={...Object.fromEntries(Object.entries<any>(initial.applied??{}).map(([t,s])=>[`${t}_${s.report_timestamp}`,{...s,ticker:t}])),...(initial.reviews??{})};
 if (!options.skipFollowup) for (const [reviewId,st] of Object.entries<any>(reviews)) {
  const ticker=st.ticker??reviewId.split('_')[0];
  if (!want(ticker) || !validTicker(ticker) || st.policy_version!==2 || ['KEEP','ROLLBACK'].includes(st.followup?.status)) continue;
  const ref=db.doc(`asset_configs/${ticker}`);const current=(await ref.get()).data()??{};
  let followup:any;
  try {
   const track=readTrack(st,ticker);
   if (!Number.isSafeInteger(st.confirmed_at_ms) || st.confirmation_pending) {
    followup={status:'PENDING',reason:'falta confirmar por lectura la aplicación de esta versión'};
   } else if (current.enabled!==true || current.disabledReason?.trim()) {
    followup={status:'PENDING',reason:'configuración cambiada o activo deshabilitado por el operador; no se revierte',evaluated_at_ms:now()};
   } else if (dryRun) {
    followup={status:'PENDING',reason:'dry-run: seguimiento no ejecutado; ninguna escritura ni replay adicional'};
   } else {
    const evaluate=options.followup??(await import('./weekly_followup.js')).evaluateFollowup;
    const result=await evaluate({ticker,appliedAt:st.confirmed_at_ms,beforeAsset:track.beforeAsset,appliedAsset:track.appliedAsset,
     evaluationEndMs:track.evaluation_end_ms,evaluatedBeforeConfig:track.evaluatedBeforeConfig,evaluatedAppliedConfig:track.evaluatedAppliedConfig,
     expectedModelFiles:track.model_files,expectedSourceFiles:track.source_files,expectedCacheFiles:track.cache_files,expectedLiveLedger:track.live_forecast_ledger,brokerCalendar:track.broker_calendar,minIntervalMs:1,
     outputDir:path.join(dir,'followup',`${ticker}_${st.report_timestamp}`)});
    followup={status:result.decision??result.status,reason:result.reason,evaluated_at_ms:now(),
     ...(result.evidencePath?{evidence_path:result.evidencePath,evidence_fingerprint:result.evidenceFingerprint}:{}),
     ...(result.window?{window:result.window}:{}),
     ...Object.fromEntries(['beforeCount','appliedCount','beforeRPerTrade','appliedRPerTrade','deteriorationRPerTrade'].filter(k=>result[k]!==undefined).map(k=>[k,result[k]]))};
   }
   if (!['PENDING','KEEP','ROLLBACK'].includes(followup?.status)) throw new Error('resultado de seguimiento desconocido');
   if (dryRun) {outcomes.push({ticker,followup,dry_run:true});continue;}
   const reviewCommit=await db.runTransaction(async(tx:any)=>{
    const latest=(await tx.get(ref)).data()??{};
    const state=(await tx.get(stateRef)).data()??{};
    const open=await tx.get(db.collection('active_trades').where('ticker','==',ticker).limit(1));
    const tracked=state.reviews?.[reviewId]??(state.applied?.[ticker]?.report_timestamp===st.report_timestamp?state.applied[ticker]:undefined);
    if (!tracked || ['KEEP','ROLLBACK'].includes(tracked.followup?.status)) return {rolledBack:false,skipped:true};
    const currentVersion=state.applied?.[ticker]?.report_timestamp===st.report_timestamp && assetFingerprint(latest)===st.applied_asset_fingerprint && latest.enabled===true && !latest.disabledReason?.trim();
    if (followup.status==='ROLLBACK' && currentVersion && !open.empty) followup={...followup,status:'PENDING',reason:'reversión pendiente: el activo tiene operaciones abiertas'};
    const auditRef=db.doc(`optimization_rollouts/${ticker}_${st.report_timestamp}`);
    const audit=(await tx.get(auditRef)).data()??{};
    state.reviews??={};
    followup.report_timestamp=st.report_timestamp;
    if(followup.status==='PENDING')state.reviews[reviewId]={...st,ticker,followup};else delete state.reviews[reviewId];
    if(state.applied?.[ticker]?.report_timestamp===st.report_timestamp)state.applied[ticker].followup=followup;
    state.latest??={};
    if(state.latest?.[ticker]?.report_timestamp===st.report_timestamp)state.latest[ticker]={...state.latest[ticker],followup};
    const rolledBack=followup.status==='ROLLBACK' && currentVersion;
    if (rolledBack) {
     // The old asset is an immutable full snapshot; no new fragment merge.
     tx.set(ref,track.beforeAsset);
     state.latest[ticker]={status:'ROLLED_BACK',reason:followup.reason,at:now(),report_timestamp:st.report_timestamp,asset_fingerprint:track.before_fingerprint,followup};
     delete state.applied[ticker];
    }
    tx.set(auditRef,{...audit,followup,...(rolledBack?{rolled_back_at_ms:now()}:{})});
    tx.set(stateRef,state);
    return {rolledBack,skipped:false};
   });
   if(reviewCommit.skipped){outcomes.push({ticker,followup,concurrent_change:true});continue;}
   const after=(await ref.get()).data()??{};
   if (reviewCommit.rolledBack && assetFingerprint(after)!==track.before_fingerprint) throw new Error('la reversión no coincide con el respaldo');
   const saved=(await db.doc(`optimization_rollouts/${ticker}_${st.report_timestamp}`).get()).data();
   if (saved?.followup?.status!==followup.status) throw new Error('seguimiento no persistido');
   outcomes.push({ticker,followup});
  } catch(e:any) {
   outcomes.push({ticker,followup:{status:'PENDING',reason:`seguimiento pendiente: ${e.message}`},error:true});
  }
 }
 if (options.followupOnly) return {dry_run:dryRun,outcomes};

 const files=fs.readdirSync(dir).filter(f=>/^[A-Z][A-Z0-9]*\.json$/.test(f)).sort();
 for (const file of files) {
  const ticker=file.slice(0,-5);if (!want(ticker)) continue;
  let report:any;
  try {
   report=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
   if (report.ticker!==ticker) throw new Error('ticker del archivo difiere del reporte');
   const ref=db.doc(`asset_configs/${ticker}`),current=(await ref.get()).data()??{};
   const currentHash=assetFingerprint(current);
   const state=(await stateRef.get()).data()??{};
   const last=state.latest?.[ticker];
   const published=(await db.doc(`opt_reports/${ticker}`).get()).data();
   if(!Number.isSafeInteger(report.timestamp)||report.timestamp<reportVersion(state,ticker,published)){
    outcomes.push({ticker,application:{status:'BLOCKED',reason:'versión de reporte anterior o inválida'}});continue;
   }
   const existingAudit=(await db.doc(`optimization_rollouts/${ticker}_${report.timestamp}`).get()).data();
   if(existingAudit){
    const matches=existingAudit.ticker===ticker && existingAudit.report_timestamp===report.timestamp &&
     existingAudit.applied_asset_fingerprint===report.final_asset_fingerprint &&
     (!existingAudit.report_fingerprint || existingAudit.report_fingerprint===reportIdentity(report));
    outcomes.push({ticker,application:matches?{...existingAudit.application,...(existingAudit.rolled_back_at_ms?{status:'ROLLED_BACK'}:{})}:
     {status:'BLOCKED',reason:'la versión ya tiene una auditoría inmutable distinta'},idempotent:matches});
    continue;
   }
   // Idempotent retry must not recreate backups, followup cutoffs or tracking clocks.
   if (last?.report_timestamp===report.timestamp && ['APPLIED','ROLLED_BACK'].includes(last.status)) {
    if(!dryRun && last.status==='APPLIED' && state.applied?.[ticker] && (!Number.isSafeInteger(state.applied[ticker].confirmed_at_ms)||state.applied[ticker].confirmation_pending))await confirmDeployment(ticker,report.timestamp,last.asset_fingerprint);
    outcomes.push({ticker,application:last,idempotent:true});continue;
   }
   const gate=checkWeeklyCandidate(report,current,now());
   const check:Check=gate.ok ? (options.verifyArtifacts??verifyEvaluationArtifacts)(report) : gate;
   if (!check.ok) {
    const application={status:report.status==='RECOMMEND'?'BLOCKED':'UNCHANGED',reason:check.reason,at:now(),asset_fingerprint:currentHash};
    outcomes.push({ticker,application});await persistStatus(ticker,report,application);continue;
   }
   if (currentHash===report.final_asset_fingerprint) {
    const application={status:'UNCHANGED',reason:'la configuración evaluada ya está vigente',at:now(),asset_fingerprint:currentHash};
    outcomes.push({ticker,application});await persistStatus(ticker,report,application);continue;
   }
   const openBefore=await db.runTransaction((tx:any)=>tx.get(db.collection('active_trades').where('ticker','==',ticker).limit(1)));
   if (!openBefore.empty) {
    const application={status:'BLOCKED',reason:'hay operaciones abiertas: se conserva su configuración hasta el próximo ciclo',at:now(),asset_fingerprint:currentHash};
    outcomes.push({ticker,application});await persistStatus(ticker,report,application);continue;
   }
   if (dryRun) {outcomes.push({ticker,application:{status:'WOULD_APPLY',reason:check.reason,asset_fingerprint:report.final_asset_fingerprint},dry_run:true});continue;}
   const at=now(),trackingId=`${ticker}_${report.timestamp}`;
   const prevPath=path.join(dir,`prev_${ticker}_${new Date(at).toISOString().slice(0,10)}_${report.timestamp}.json`);
   const trackPath=path.join(trackingRoot,`${trackingId}.json`);
   const liveLedger=fs.existsSync(trackPath)?JSON.parse(fs.readFileSync(trackPath,'utf8')).live_forecast_ledger:registerLiveForecastLedger(ticker,report,undefined,at);
   const track={ticker,report_timestamp:report.timestamp,report_fingerprint:reportIdentity(report),beforeAsset:current,appliedAsset:report.final_asset_config,live_forecast_ledger:liveLedger??null,
    before_fingerprint:currentHash,applied_asset_fingerprint:report.final_asset_fingerprint,
    evaluatedBeforeConfig:report.production_backtest_config??null,evaluatedAppliedConfig:report.final_config,
    evaluation_end_ms:report.evaluation_manifest?.test_end_ms??report.timestamp,
    cache_files:report.evaluation_provenance?.cache_files??[],broker_calendar:readBrokerCalendar(ticker),
    model_files:report.evaluation_provenance?.model_files??[],source_compatibility:check.compatibility??[],
    original_evaluation_source_files:report.evaluation_provenance?.source_files??[],
    source_files:(report.evaluation_provenance?.source_files??[]).filter((item:any)=>isEvaluationSource(item.path)).map((item:any)=>{const c=check.compatibility?.find((c:any)=>c.path===item.path);return c?{...item,sha256:c.to_sha256}:item;})};
   writeJson(prevPath,current,true);writeJson(trackPath,track,true);
   const followup={status:'PENDING',reason:'se comparará con la configuración anterior usando datos posteriores a esta aplicación'};
   const application:any={status:'APPLIED',reason:'mejora de backtest y Monte Carlo aprobados; configuración exacta aplicada',at,asset_fingerprint:report.final_asset_fingerprint,tracking_id:trackingId};
   const committed=await db.runTransaction(async(tx:any)=>{
    const latest=(await tx.get(ref)).data()??{};
    const latestState=(await tx.get(stateRef)).data()??{};
    const auditRef=db.doc(`optimization_rollouts/${trackingId}`);
    const audit=(await tx.get(auditRef)).data();
    const published=(await tx.get(db.doc(`opt_reports/${ticker}`))).data();
    if(report.timestamp<reportVersion(latestState,ticker,published))return {ok:false,preserve:true,reason:'versión de reporte anterior'};
    if(audit)return {ok:false,preserve:true,reason:'la versión ya tiene una auditoría inmutable'};
    const open=await tx.get(db.collection('active_trades').where('ticker','==',ticker).limit(1));
    const checkAgain=checkWeeklyCandidate(report,latest,now());
    if (!checkAgain.ok) return {ok:false,reason:checkAgain.reason};
    if (!open.empty) return {ok:false,reason:'hay operaciones abiertas: se conserva su configuración hasta el próximo ciclo'};
    const artifacts=(options.verifyArtifacts??verifyEvaluationArtifacts)(report);if(!artifacts.ok)return artifacts;
    latestState.applied??={};latestState.latest??={};
    latestState.report_versions??={};latestState.report_versions[ticker]=report.timestamp;
    latestState.applied[ticker]={policy_version:2,at,confirmation_pending:true,report_timestamp:report.timestamp,applied_asset_fingerprint:report.final_asset_fingerprint,prev_path:prevPath,track_path:trackPath,followup};
    latestState.reviews??={};latestState.reviews[trackingId]={...latestState.applied[ticker],ticker};
    latestState.latest[ticker]={...application,report_timestamp:report.timestamp,followup};
    latestState.rollout_policy={version:2,enabled:true,authorization:'operator-approved weekly evaluated rollout',prospective_certification_required:false};
    tx.set(ref,report.final_asset_config);
    tx.set(stateRef,latestState);
    tx.set(db.doc(`optimization_rollouts/${trackingId}`),{...track,application,followup});
    tx.set(db.doc(`opt_reports/${ticker}`),{...report,application,followup,appliedAt:at,appliedBy:'autotune_weekly'});
    return {ok:true};
   });
   if (!committed.ok) {
    if(committed.preserve){outcomes.push({ticker,application:{status:'BLOCKED',reason:committed.reason}});continue;}
    const blocked={status:'BLOCKED',reason:committed.reason,at:now(),asset_fingerprint:currentHash};
    outcomes.push({ticker,application:blocked});await persistStatus(ticker,report,blocked);continue;
   }
   if (assetFingerprint((await ref.get()).data())!==report.final_asset_fingerprint) throw new Error('readback de configuración aplicada no coincide');
   application.confirmed_at_ms=await confirmDeployment(ticker,report.timestamp,report.final_asset_fingerprint);
   const readState=(await stateRef.get()).data();
   if (readState?.applied?.[ticker]?.report_timestamp!==report.timestamp) throw new Error('seguimiento no persistido tras aplicar');
   const readReport=(await db.doc(`opt_reports/${ticker}`).get()).data();
   if (readReport?.application?.tracking_id!==trackingId) throw new Error('reporte no persistido tras aplicar');
   writeJson(path.join(dir,file),{...report,application,followup,appliedAt:at,appliedBy:'autotune_weekly'});
   outcomes.push({ticker,application,followup});
  } catch(e:any) {
   // An error after commit is NOT represented as a confirmed non-application.
   outcomes.push({ticker,application:{status:'ERROR',reason:e.message,at:now()},error:true});
  }
 }
 return {dry_run:dryRun,outcomes};
}
