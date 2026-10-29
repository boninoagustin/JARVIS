/** Post-application monitoring; NOT a prospective Test certificate or a broker action.
 * RPC init supplies the real loader's frozen dataset/source provenance. v1
 * evaluate_final has no context-only boundary, while evaluate_window deliberately
 * blocks its latest Vault: neither is repurposed to pretend a prospective Test.
 * Instead use the SAME real engine's public WFA replay/reset + terminal censoring.
 * All writes are content-addressed evidence under outputDir; never model/broker IO.
 */
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Worker,isMainThread,workerData} from 'node:worker_threads';
import {RpcWorker} from './eval_production.js';
import {mapAssetConfig,loadSelectionLogs} from './selection_context.js';
import {configFingerprint,readOnlyReplayConfig,partitionTrades,modelAvailability,loadEvaluationManifest} from '../hyperopt/evaluation_protocol.js';
import type {EvaluationManifest} from '../hyperopt/evaluation_protocol.js';
import {prepareEntries,runBacktest} from '../../jarvis-os/src/services/backtestEngine.js';
import {planReplayWindow,contextObservationTf} from '../../jarvis-os/src/services/replayWindow.js';
import {setMLGateOverride} from '../../src/engine/MLFilter.js';
import {timesfmCandleKey,validateTimesfmForecast,type TimesfmForecast} from '../../src/engine/TimesfmFilter.js';
import {registerRolloverSchedule} from '../../src/engine/RolloverSpreadGate.js';
export type FollowupDecision = 'KEEP'|'ROLLBACK'|'PENDING';
/** Only a supplied broker schedule can explain missing M5 prices; never infer
 * a closure from the very data hole under inspection. No fallback calendar. */
export function calendarAllowsMissingM5(calendar:any,fromMs:number,toMs:number):boolean {
 if(!calendar || !Number.isSafeInteger(fromMs)||!Number.isSafeInteger(toMs)||fromMs>toMs||toMs-fromMs>62*86400000) return false;
 // Pure closure probe: registerRolloverSchedule has destructive validation and
 // exposes neither a getter nor unregister. Never borrow a global ticker here.
 try {
  if(typeof calendar.scheduleTimeZone!=='string'||!calendar.scheduleTimeZone.trim())return false;
  const formatter=new Intl.DateTimeFormat('en-US',{timeZone:calendar.scheduleTimeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const schedule=calendar.schedule.map((s:any)=>({startSecond:Number(s.startSecond),endSecond:Number(s.endSecond)})).sort((a:any,b:any)=>a.startSecond-b.startSecond);
  if(!schedule.length||schedule.some((s:any,i:number)=>!Number.isFinite(s.startSecond)||!Number.isFinite(s.endSecond)||s.startSecond<0||s.endSecond>604800||s.endSecond<=s.startSecond||(i>0&&s.startSecond<schedule[i-1].endSecond)))return false;
  // Mirror the broker calendar's wall-time → UTC resolution, including its
  // repeated-hour/DST semantics. Local seconds alone can falsely excuse a hole.
  const wallTime=(ms:number)=>{
   const parts=formatter.formatToParts(ms),n=(name:string)=>Number(parts.find(p=>p.type===name)?.value);
   return Date.UTC(n('year'),n('month')-1,n('day'),n('hour'),n('minute'),n('second'));
  };
  const utcFromWall=(wall:number)=>{
   let utc=wall;
   for(let i=0;i<4;i++){const delta=wall-wallTime(utc);if(!delta)break;utc+=delta;}
   return utc;
  };
  const first=new Date(wallTime(fromMs)),day=86400000;
  const sunday=Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),first.getUTCDate()-first.getUTCDay());
  const lastWeek=Math.floor((wallTime(toMs)-sunday)/(7*day));
  const sessions:{start:number;end:number}[]=[];
  for(let week=-1;week<=lastWeek+1;week++)for(const s of schedule)sessions.push({
   start:utcFromWall(sunday+week*7*day+s.startSecond*1000),end:utcFromWall(sunday+week*7*day+s.endSecond*1000)});
  for(let t=fromMs;t<toMs;t+=300000)if(sessions.some(s=>t>=s.start&&t<s.end))return false;
  return true;
 }catch{return false;}
}
export interface AssessmentInput {
  beforeReturns: readonly number[];
  appliedReturns: readonly number[];
  minTrades?: number;
}
export function assessFollowup(input: AssessmentInput) {
  const minTrades=input.minTrades??8;
  const base={thresholdRPerTrade:0.10,minTrades};
  const pending=(reason:string)=>({...base,decision:'PENDING' as FollowupDecision,reason});
  if(!Number.isSafeInteger(minTrades)||minTrades<1)return pending('invalid_min_trades');
  if(!Array.isArray(input.beforeReturns)||!Array.isArray(input.appliedReturns)||
    [...input.beforeReturns,...input.appliedReturns].some(x=>typeof x!=='number'||!Number.isFinite(x)))return pending('nonfinite_or_missing_returns');
  const beforeCount=input.beforeReturns.length,appliedCount=input.appliedReturns.length;
  if(beforeCount<minTrades||appliedCount<minTrades)return {...pending('insufficient_trades'),beforeCount,appliedCount};
  const beforeRPerTrade=input.beforeReturns.reduce((s,r)=>s+r,0)/beforeCount;
  const appliedRPerTrade=input.appliedReturns.reduce((s,r)=>s+r,0)/appliedCount;
  const deteriorationRPerTrade=beforeRPerTrade-appliedRPerTrade;
  if(![beforeRPerTrade,appliedRPerTrade,deteriorationRPerTrade].every(Number.isFinite))return pending('nonfinite_aggregate');
  // Avoid floating-point noise at the approved strict boundary (0.3-0.2).
  const degraded=deteriorationRPerTrade>0.10+Number.EPSILON*Math.max(1,Math.abs(beforeRPerTrade),Math.abs(appliedRPerTrade))*8;
  return {...base,decision:(degraded?'ROLLBACK':'KEEP') as FollowupDecision,
    reason:degraded?'measured_paired_deterioration_gt_0.10_r_per_trade':'no_measured_deterioration_gt_threshold',
    beforeCount,appliedCount,beforeRPerTrade,appliedRPerTrade,deteriorationRPerTrade,
    pairing:'same_calendar_interval_not_trade_index',statisticalCertification:false};
}

export interface FollowupFileIdentity {path:string;sha256:string;sizeBytes?:number}
export interface FollowupLiveLedger {
  path:string;model_version:string;registered_at_ms:number;prefix_sha256:string;prefix_size_bytes:number;
}
export interface FollowupInput {
  ticker:string;
  /** Exact UTC milliseconds or an ISO timestamp with an explicit UTC/offset. */
  appliedAt:number|string;
  beforeAsset:Record<string,any>;
  appliedAsset:Record<string,any>;
  outputDir:string;
  logsDir?:string;
  /** Inclusive prior history is expressed as an EXCLUSIVE end. Mandatory evidence. */
  evaluationEndMs?:number;
  priorEvaluatedEndMs?:number;
  evaluationManifest?:EvaluationManifest;
  evaluatedBeforeConfig?:Record<string,any>;
  evaluatedAppliedConfig?:Record<string,any>;
  /** Original application-time identities, not hashes taken after retraining. */
  expectedModelFiles?:FollowupFileIdentity[];
  expectedSourceFiles?:FollowupFileIdentity[];
  /** Unchanged bytes or append-only SHA256 prefix (newline boundary or sizeBytes). */
  expectedCacheFiles?:FollowupFileIdentity[];
  /** Separate native live observations; never retrofit historical precompute timestamps. */
  expectedLiveLedger?:FollowupLiveLedger;
  maxObservationGapMs?:number; // default 30s per TF; explicit synthetic policy may override
  minTrades?:number;
  minIntervalMs?:number; // default one elapsed calendar week, not eight trades alone
  warmupDays?:number;
  minContextObservations?:Record<string,number>;
  maxM5GapMs?:number; // default one M5 step; authorize known calendar closures below
  allowedCoverageGaps?:{from_ms:number;to_ms:number;reason:string}[];
  brokerCalendar?:{scheduleTimeZone:string;schedule:{startSecond:number;endSecond:number}[];source?:FollowupFileIdentity;capture_date?:string};
  worker?:Pick<RpcWorker,'call'>; // init RPC injection only; replay remains the real engine
}
/** The calendar API cannot snapshot/unregister an existing schedule. Evaluate in
 * a fresh isolate instead of overwriting the caller's registration or its caches.
 * Both real replays share that isolate and it is destroyed even on failure. */
async function isolatedCalendarFollowup(input:FollowupInput):Promise<any> {
 const {worker,...data}=input;
 // FollowupInput.worker is explicitly an init-only injection seam.
 const init=worker?await worker.call('init',{ticker:input.ticker,log_dir:input.logsDir??`/opt/JARVIS/logs/${input.ticker.toLowerCase()}/history_exported`}):undefined;
 const thread=new Worker(`
  const {parentPort,workerData}=require('node:worker_threads');
  (async()=>{
   const {register}=await import(workerData.tsxUrl);register();
   const {evaluateFollowup}=await import(workerData.moduleUrl);
   const input=workerData.input;
   if(workerData.hasWorker)input.worker={call:async()=>workerData.init};
   parentPort.postMessage({result:await evaluateFollowup(input)});
  })().catch(error=>parentPort.postMessage({error:error instanceof Error?error.message:String(error)}));
 `,{eval:true,execArgv:[],workerData:{kind:'weekly-followup-calendar',input:data,hasWorker:!!worker,init,
   moduleUrl:import.meta.url,tsxUrl:import.meta.resolve('tsx/esm/api')}});
 try {
  return await new Promise((resolve,reject)=>{
   thread.once('message',message=>message.error?reject(new Error(message.error)):resolve(message.result));
   thread.once('error',reject);
   thread.once('exit',code=>reject(new Error(`followup_calendar_worker_exited_${code}`)));
  });
 }finally{await thread.terminate();}
}
function fileIdentity(file:string):FollowupFileIdentity {
  const bytes=readFileSync(file);
  return {path:path.resolve(file),sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length};
}
function verifyFiles(files:FollowupFileIdentity[],label:string) {
  for(const f of files){
    if(!f||!path.isAbsolute(f.path)||!(/^[a-f0-9]{64}$/).test(f.sha256)||fileIdentity(f.path).sha256!==f.sha256)
      throw new Error(`${label}_identity_changed_or_missing`);
  }
}
/** Versioned wire fingerprint shared with the Python recorder. Raw observations
 * stay untouched; binary64 removes decimal formatter differences, including -0.
 * Untagged historical TS ledgers retain their original configFingerprint contract. */
function forecastFingerprint(value:unknown,version:unknown):string {
 if(version===undefined)return configFingerprint(value);
 if(version!=='ieee754-v1')throw new Error('live_ledger_fingerprint_version_unsupported');
 const size=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
 const text=(s:string)=>{const b=Buffer.from(s,'utf16le');b.swap16();return Buffer.concat([Buffer.from('s'),size(b.length),b]);};
 const encode=(v:any):Buffer=>{
  if(v===null)return Buffer.from('z');
  if(typeof v==='boolean')return Buffer.from(v?'t':'f');
  if(typeof v==='number'){
   if(!Number.isFinite(v))throw new Error('fingerprint_numbers_must_be_finite');
   const b=Buffer.alloc(9);b.write('n');b.writeDoubleBE(v===0?0:v,1);return b;
  }
  if(typeof v==='string')return text(v);
  if(Array.isArray(v))return Buffer.concat([Buffer.from('a'),size(v.length),...v.map(encode)]);
  if(typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype){
   const keys=Object.keys(v).sort();
   return Buffer.concat([Buffer.from('o'),size(keys.length),...keys.flatMap(k=>[text(k),encode(v[k])])]);
  }
  throw new Error('fingerprint_requires_JSON_values');
 };
 return createHash('sha256').update(encode(value)).digest('hex');
}
/** Capture once for both configs; retain exact bytes as local content-addressed evidence. */
function captureLiveLedger(track:FollowupLiveLedger,ticker:string,outputDir:string) {
  const bytes=readFileSync(track.path),sha256=createHash('sha256').update(bytes).digest('hex');
  if(!path.isAbsolute(track.path)||!track.model_version||!Number.isSafeInteger(track.registered_at_ms)||track.registered_at_ms<0||
    !Number.isSafeInteger(track.prefix_size_bytes)||track.prefix_size_bytes<0||track.prefix_size_bytes>bytes.length||
    !/^[a-f0-9]{64}$/.test(track.prefix_sha256)||
    createHash('sha256').update(bytes.subarray(0,track.prefix_size_bytes)).digest('hex')!==track.prefix_sha256||
    (track.prefix_size_bytes>0&&bytes[track.prefix_size_bytes-1]!==10))throw new Error('live_ledger_registered_prefix_identity_invalid');
  if(!bytes.length||bytes.at(-1)!==10)throw new Error('live_ledger_incomplete_observations');
  const rows=bytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  const observations=new Map<number,{observedAt:number;forecast?:TimesfmForecast}[]>([[5,[]],[15,[]]]);
  const state=new Map<number,TimesfmForecast>();
  let lastObservation=-1;
  for(const r of rows){
    if(r.observedAt<lastObservation)throw new Error('live_ledger_observation_clock_not_monotonic');
    lastObservation=r.observedAt;
    const list=observations.get(r.tf);
    if(!list||r.schema_version!==1||r.ticker!==ticker||!Number.isSafeInteger(r.observedAt)||r.observedAt<0||
      !['forecast','heartbeat','unavailable'].includes(r.kind))throw new Error('live_ledger_observation_schema_invalid');
    if(r.kind==='unavailable')state.delete(r.tf);
    if(r.kind==='forecast'){
      const invalid=validateTimesfmForecast(r.forecast,{ticker,tfMinutes:r.tf,nowMs:r.observedAt,maxAgeMs:Number.MAX_SAFE_INTEGER,strict:true,modelVersion:track.model_version});
      if(invalid)throw new Error(`live_ledger_native_forecast_invalid: ${invalid}`);
      const fingerprint=forecastFingerprint(r.forecast,r.forecastFingerprintVersion);
      if(r.forecastFingerprint!==undefined&&r.forecastFingerprint!==fingerprint)throw new Error('live_ledger_forecast_fingerprint_invalid');
      state.set(r.tf,r.forecast);
    }
    if(r.kind==='heartbeat'&&(!state.has(r.tf)||r.forecastFingerprint!==forecastFingerprint(state.get(r.tf),r.forecastFingerprintVersion)))
      throw new Error('live_ledger_heartbeat_fingerprint_invalid');
    list.push({observedAt:r.observedAt,forecast:state.get(r.tf)});
  }
  const snapshot={path:track.path,sha256,sizeBytes:bytes.length};
  const snapshotEvidencePath=path.resolve(outputDir,`live_ledger_${sha256}.jsonl`);
  mkdirSync(path.dirname(snapshotEvidencePath),{recursive:true});
  if(existsSync(snapshotEvidencePath)){if(!readFileSync(snapshotEvidencePath).equals(bytes))throw new Error('live_ledger_evidence_collision');}
  else writeFileSync(snapshotEvidencePath,bytes,{flag:'wx'});
  return {provenance:{registration:track,snapshot,snapshotEvidencePath},observations,
    verify:()=>{const current=readFileSync(track.path);if(current.length<bytes.length||!current.subarray(0,bytes.length).equals(bytes))throw new Error('live_ledger_snapshot_prefix_changed');},
    at:(nowMs:number,tf:number,maxAgeMs:number)=>{
      const list=observations.get(tf);if(!list)throw new Error('live_ledger_signal_TF_not_observed');
      let lo=0,hi=list.length;
      while(lo<hi){const mid=(lo+hi)>>>1;if(list[mid].observedAt<=nowMs)lo=mid+1;else hi=mid;}
      const fc=list[lo-1]?.forecast;
      return fc&&!validateTimesfmForecast(fc,{ticker,tfMinutes:tf,nowMs,maxAgeMs,strict:true,modelVersion:track.model_version})?fc:undefined;
    }};
}
/** Single bounded observation, no polling or application. Missing evidence is PENDING.
 * Caller serializes invocations: the shared engine/ML override has process-global state.
 */
export async function evaluateFollowup(input:FollowupInput):Promise<any> {
  let own:RpcWorker|undefined;
  let evidence:any={version:1,kind:'weekly_paired_followup',ticker:input.ticker,
    apply_eligible:false,prospectiveCertification:false,pairing:'same_calendar_interval_not_trade_index',
    policy:{thresholdRPerTrade:0.10,minTrades:input.minTrades??8,minIntervalMs:input.minIntervalMs??604800000},
    decision:'PENDING',reason:'not_evaluated'};
  const finish=(assessment:any)=>{
    evidence={...evidence,...assessment};
    // Local audit only. Content addressing refuses conflicting pre-existing bytes.
    const evidenceFingerprint=configFingerprint(evidence);
    const evidencePath=path.resolve(input.outputDir,`followup_${input.ticker}_${evidenceFingerprint}.json`);
    mkdirSync(path.dirname(evidencePath),{recursive:true});
    const bytes=JSON.stringify(evidence,null,2)+'\n';
    if(existsSync(evidencePath)){if(readFileSync(evidencePath,'utf8')!==bytes)throw new Error('evidence_path_collision');}
    else writeFileSync(evidencePath,bytes,{flag:'wx'});
    return {...evidence,evidence,evidenceFingerprint,evidencePath};
  };
  try {
    if(!/^[A-Z0-9]+$/.test(input.ticker))throw new Error('invalid_ticker');
    const applied=typeof input.appliedAt==='number'?input.appliedAt:
      typeof input.appliedAt==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(input.appliedAt)?Date.parse(input.appliedAt):NaN;
    if(!Number.isSafeInteger(applied)||applied<0)throw new Error('invalid_application_time');
    const ends=[input.evaluationEndMs,input.priorEvaluatedEndMs,
      input.evaluationManifest?loadEvaluationManifest(input.evaluationManifest,input.ticker).test_end_ms:undefined].filter(x=>x!==undefined) as number[];
    if(!ends.length||ends.some(x=>!Number.isSafeInteger(x)||x<0))throw new Error('prior_history_end_cutoff_missing_or_invalid');
    let from_ms=Math.max(applied,...ends);
    evidence={...evidence,appliedAtMs:applied,priorEvaluatedEndMs:Math.max(...ends),
      beforeAsset:input.beforeAsset,appliedAsset:input.appliedAsset,
      frozenInputs:{beforeConfig:input.evaluatedBeforeConfig??null,appliedConfig:input.evaluatedAppliedConfig??null,
        expectedModelFiles:input.expectedModelFiles??[],expectedCacheFiles:input.expectedCacheFiles??[],expectedLiveLedger:input.expectedLiveLedger??null}};
    configFingerprint(evidence); // reject invalid snapshots before cloning or IO
    if(!input.expectedSourceFiles?.length)throw new Error('original_source_identities_missing');
    // Worker hashes a conservative repository superset. Retain every engine,
    // replay, parser, config-mapping and protocol import, but not UI/application/
    // selection orchestration/tests (which do not execute this paired replay).
    const evaluationSource=(f:FollowupFileIdentity)=>{
      const p=f.path.replace(/^\/opt\/JARVIS\//,'');
      return /^(src\/|jarvis-os\/src\/(engine|services)\/)/.test(p)||
        ['scripts/hyperopt/jarvis_hyperopt_worker.ts','scripts/hyperopt/evaluation_protocol.ts',
         'scripts/hyperopt/wfa_window.ts','scripts/periodic_opt/selection_context.ts',
         'scripts/periodic_opt/eval_production.ts','package.json','package-lock.json','tsconfig.json',
         'jarvis-os/package.json','jarvis-os/package-lock.json','jarvis-os/tsconfig.json',
         'jarvis-os/tsconfig.app.json','jarvis-os/tsconfig.node.json'].includes(p);
    };
    const expectedSources=input.expectedSourceFiles.filter(evaluationSource);
    if(!expectedSources.length)throw new Error('original_evaluation_source_identities_missing');
    verifyFiles(expectedSources,'original_source');
    if(input.brokerCalendar&&(isMainThread||workerData?.kind!=='weekly-followup-calendar'))return await isolatedCalendarFollowup(input);
    const logsDir=input.logsDir??`/opt/JARVIS/logs/${input.ticker.toLowerCase()}/history_exported`;
    const w=input.worker??(own=new RpcWorker());
    const init=await w.call('init',{ticker:input.ticker,log_dir:logsDir});
    if(!init.provenance||init.evaluation_fingerprint!==configFingerprint(init.provenance))throw new Error('init_provenance_fingerprint_mismatch');
    const canonicalFiles=(files:FollowupFileIdentity[])=>files.map(f=>({path:f.path,sha256:f.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
    if(configFingerprint(canonicalFiles((init.provenance.source_files??[]).filter(evaluationSource)))!==configFingerprint(canonicalFiles(expectedSources)))
      throw new Error('original_source_set_changed');
    const selectedDatasetFiles=['M5','M15','H1','H4','D1'].map(tf=>
      [`pine-logs-SMC Master_${tf}.csv`,`history_${tf}.csv`,`${tf}.csv`].map(f=>path.join(logsDir,f)).find(existsSync))
      .filter((f):f is string=>!!f).map(fileIdentity);
    if(!selectedDatasetFiles.length||configFingerprint(canonicalFiles(selectedDatasetFiles))!==configFingerprint(canonicalFiles(init.provenance.dataset_files??[])))
      throw new Error('dataset_identity_set_missing_or_changed');
    const frozenFiles=[...selectedDatasetFiles,...expectedSources];
    evidence.originalSourceFiles=expectedSources;
    verifyFiles(frozenFiles,'snapshot');
    evidence.initProvenance=init.provenance;
    evidence.initEvaluationFingerprint=init.evaluation_fingerprint;
    const liveLedger=input.expectedLiveLedger?captureLiveLedger(input.expectedLiveLedger,input.ticker,input.outputDir):undefined;
    if(liveLedger)evidence.liveLedger=liveLedger.provenance;
    const logs=loadSelectionLogs({ticker:input.ticker,logsDir});
    const entries=await prepareEntries(logs);
    const m5=[...new Set(entries.filter(e=>contextObservationTf(e)==='5').map(e=>e.ts))].sort((a,b)=>a-b);
    const coverage=m5.length?{from_ms:m5[0],to_ms:m5.at(-1)!+1}:null;
    if(!coverage||coverage.from_ms!==init.m5_coverage?.from_ms||coverage.to_ms!==init.m5_coverage?.to_ms)
      throw new Error('M5_coverage_missing_invalid_or_changed');
    let to_ms=coverage.to_ms;
    if(liveLedger){
      const bounds=[5,15].map(tf=>{
        const list=liveLedger.observations.get(tf)!;
        if(!list.length)throw new Error('live_ledger_TF_observation_coverage_missing');
        return {tf,from_ms:list[0].observedAt,to_ms:list.at(-1)!.observedAt+1};
      });
      from_ms=Math.max(from_ms,input.expectedLiveLedger!.registered_at_ms,coverage.from_ms,...bounds.map(b=>b.from_ms));
      to_ms=Math.min(to_ms,...bounds.map(b=>b.to_ms));
      evidence.liveLedger={...evidence.liveLedger,coverage:bounds};
    }
    evidence.window={from_ms,to_ms};
    evidence.coverage={...coverage,status:'observed_valid_M5_prices_not_exchange_calendar_certification'};
    const minInterval=input.minIntervalMs??604800000;
    if(!Number.isSafeInteger(minInterval)||minInterval<1)throw new Error('invalid_min_interval');
    if(from_ms>=to_ms||to_ms-from_ms<minInterval)throw new Error('future_interval_not_yet_available');
    const maxGap=input.maxM5GapMs??300000;
    if(!Number.isSafeInteger(maxGap)||maxGap<1)throw new Error('invalid_M5_gap_policy');
    const gaps=input.allowedCoverageGaps??[];
    for(const g of gaps)if(!Number.isSafeInteger(g.from_ms)||!Number.isSafeInteger(g.to_ms)||g.from_ms>=g.to_ms||!g.reason?.trim())throw new Error('invalid_calendar_closure');
    const inWindow=m5.filter(t=>t>=from_ms&&t<to_ms);
    if(input.brokerCalendar?.source)verifyFiles([input.brokerCalendar.source],'broker_calendar');
    if(liveLedger){
      const maxObservationGapMs=input.maxObservationGapMs??30000;
      if(!Number.isSafeInteger(maxObservationGapMs)||maxObservationGapMs<1)throw new Error('invalid_observation_gap_policy');
      for(const [tf,list] of liveLedger.observations)for(let i=1;i<list.length;i++){
        const left=list[i-1].observedAt,right=list[i].observedAt;
        if(right>from_ms&&left<to_ms&&right-left>maxObservationGapMs&&
          !calendarAllowsMissingM5(input.brokerCalendar,Math.floor(left/300000)*300000,Math.ceil(right/300000)*300000))
          throw new Error(`live_ledger_observation_gap_unverified_TF${tf}`);
      }
      evidence.liveLedger={...evidence.liveLedger,maxObservationGapMs};
    }
    if(!inWindow.length || (inWindow[0]-from_ms>maxGap && !calendarAllowsMissingM5(input.brokerCalendar,Math.ceil(from_ms/300000)*300000,inWindow[0])))throw new Error('M5_start_coverage_missing');
    for(let i=1;i<inWindow.length;i++)if(inWindow[i]-inWindow[i-1]>maxGap&&
      !gaps.some(g=>g.from_ms<=inWindow[i-1]+300000&&g.to_ms>=inWindow[i]) &&
      !calendarAllowsMissingM5(input.brokerCalendar,inWindow[i-1]+300000,inWindow[i]))throw new Error('M5_gap_unverified');
    evidence.coverage={...evidence.coverage,maxGapMs:maxGap,authorizedCalendarClosures:gaps,brokerCalendar:input.brokerCalendar??null};
    const replayOptions=planReplayWindow(entries,from_ms,to_ms,{warmupDays:input.warmupDays,minContextObservations:input.minContextObservations});
    if(!Object.values(replayOptions.minContextObservations).some(n=>n>0))throw new Error('context_requirements_empty');
    evidence.replayOptions=replayOptions;
    const resolve=(asset:any,evaluated:any)=>{
      const effectiveConfig=readOnlyReplayConfig(evaluated??mapAssetConfig(input.ticker,asset));
      if(effectiveConfig.ticker!==input.ticker)throw new Error('config_ticker_mismatch');
      const files:FollowupFileIdentity[]=[];
      if(effectiveConfig.mlGateEnabled===true&&effectiveConfig.mlGate?.enabled!==false){
        const gate=effectiveConfig.mlGate??{};
        const models=input.expectedModelFiles??[];
        const modelPath=gate.modelPath??(models.length===1?models[0].path:undefined);
        // Do not consult today's defaultModel(): only an explicit frozen path
        // or one unambiguous original application-time model may resolve a gate.
        const expected=modelPath?models.find(f=>f.path===path.resolve(modelPath)):undefined;
        if(!expected)throw new Error('original_model_identity_missing');
        verifyFiles([expected],'original_model');
        const model=modelAvailability(JSON.parse(readFileSync(expected.path,'utf8')));
        if(model.status!=='verified'||model.available_at_ms!>applied||model.train_end_ms!>applied||
          (gate.trainedAt!==undefined&&gate.trainedAt!==model.available_at_ms))throw new Error('model_temporal_identity_invalid');
        effectiveConfig.mlGate={enabled:true,modelPath:expected.path,trainedAt:model.available_at_ms};
        files.push(fileIdentity(expected.path));
      }else{
        if(effectiveConfig.mlGate?.enabled===true)throw new Error('ML_permission_mismatch');
        effectiveConfig.mlGate={enabled:false};
      }
      let cacheProvenance:any=null;
      if(effectiveConfig.timesfm?.enabled&&!liveLedger){
        const cachePath=path.resolve(effectiveConfig.timesfm.cachePath);
        const original=input.expectedCacheFiles?.find(f=>f.path===cachePath);
        if(!original||!(/^[a-f0-9]{64}$/).test(original.sha256))throw new Error('original_cache_identity_missing');
        const bytes=readFileSync(cachePath);
        let prefixLength=original.sizeBytes;
        const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
        if(prefixLength===undefined){
          // Reports historically stored only SHA256. Find a newline-terminated
          // original prefix in linear time, without accepting changed old rows.
          const h=createHash('sha256');let offset=0;prefixLength=-1;
          while(offset<bytes.length){
            const nl=bytes.indexOf(10,offset),end=nl<0?bytes.length:nl+1;
            h.update(bytes.subarray(offset,end));offset=end;
            if(h.copy().digest('hex')===original.sha256){prefixLength=end;break;}
          }
        }
        if(!Number.isSafeInteger(prefixLength)||prefixLength!<1||prefixLength!>bytes.length||
           hash(bytes.subarray(0,prefixLength))!==original.sha256)throw new Error('cache_original_prefix_identity_changed');
        const originalRows=bytes.subarray(0,prefixLength).toString('utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
        const versions=[...new Set(originalRows.map(f=>f.model_version))];
        if(versions.length!==1||typeof versions[0]!=='string'||!versions[0])throw new Error('cache_original_model_identity_missing');
        const rows=bytes.toString('utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
        const forecasts=new Map<number,any>();
        for(const f of rows){
          if(forecasts.has(f.ts))throw new Error('cache_duplicate_timestamp_identity');
          forecasts.set(f.ts,f);
        }
        for(const event of entries.filter(e=>e.ts>=from_ms&&e.ts<to_ms)){
          // Mirror the engine's actual signal-TF lookup (not a guessed M5-only
          // cache). Over-require coverage at every potential signal event.
          const tf=parseInt(String(event.parsed?.eventTf||'15').replace(/\D/g,''))||15;
          const key=timesfmCandleKey(event.ts,tf),fc=forecasts.get(key);
          if(!fc)throw new Error('cache_future_interval_coverage_missing');
          const invalid=validateTimesfmForecast(fc,{ticker:input.ticker,tfMinutes:tf,nowMs:event.ts,
            maxAgeMs:effectiveConfig.timesfm.maxForecastAgeMs??2100000,strict:true,modelVersion:versions[0]});
          if(invalid)throw new Error(`cache_temporal_or_model_identity_invalid: ${invalid}`);
        }
        files.push({path:cachePath,sha256:hash(bytes),sizeBytes:bytes.length});
        cacheProvenance={original,preservedPrefixBytes:prefixLength,modelVersion:versions[0],policy:'append-only-unchanged-prefix-explicit-causal-v2-forecasts'};
      }
      return {asset,assetFingerprint:configFingerprint(asset),effectiveConfig,
        configFingerprint:configFingerprint(effectiveConfig),fileIdentities:files,cacheProvenance,
        evaluatedInputFingerprint:configFingerprint(evaluated??mapAssetConfig(input.ticker,asset))};
    };
    const before=resolve(input.beforeAsset,input.evaluatedBeforeConfig);
    const appliedConfig=resolve(input.appliedAsset,input.evaluatedAppliedConfig);
    const replay=(snapshot:any)=>{
      setMLGateOverride(input.ticker,snapshot.effectiveConfig.mlGate.enabled===true);
      const result=runBacktest(logs,structuredClone(snapshot.effectiveConfig),undefined,entries,replayOptions,
        liveLedger?{timesfmForecastAt:(nowMs,tf)=>liveLedger.at(nowMs,tf,snapshot.effectiveConfig.timesfm?.maxForecastAgeMs??2100000)}:undefined);
      if(result.trades.some(t=>typeof t.rMultiple==='number'&&!Number.isFinite(t.rMultiple)))throw new Error('nonfinite_engine_trade_return');
      const terminal=entries.filter(e=>e.ts>=from_ms&&e.ts<to_ms).at(-1)?.ts??-1;
      const partitioned=partitionTrades(result.trades,{from_ms,train_end_ms:to_ms} as EvaluationManifest,'train',terminal);
      const closedTrades=partitioned.filter(t=>t.label_status==='closed');
      // Engine diagnostics/trades contain optional undefined properties; NDJSON
      // omits those too. Nonfinite numeric outcomes must NEVER become JSON null.
      return JSON.parse(JSON.stringify({...snapshot,closedTrades,returns:closedTrades.map(t=>t.rMultiple),
        censoredTrades:partitioned.filter(t=>t.label_status!=='closed'),replayDiagnostics:result.replayDiagnostics},
        (_key,value)=>{if(typeof value==='number'&&!Number.isFinite(value))throw new Error('nonfinite_engine_output');return value;}));
    };
    // Calendar-bearing evaluations run only in a disposable worker. Register the
    // actual engine ticker, never a coverage-only alias; both replays see it.
    if(input.brokerCalendar&&!registerRolloverSchedule(input.ticker,input.brokerCalendar))throw new Error('invalid_broker_calendar');
    // No awaits between these two calls: shared engine state cannot interleave.
    evidence.before=replay(before);evidence.applied=replay(appliedConfig);
    liveLedger?.verify();
    verifyFiles([...frozenFiles,...before.fileIdentities,...appliedConfig.fileIdentities],'post_replay_snapshot');
    if(evidence.before.replayDiagnostics?.readiness.ready!==true||evidence.applied.replayDiagnostics?.readiness.ready!==true)
      throw new Error('warmup_context_not_ready');
    const assessment=assessFollowup({beforeReturns:evidence.before.returns,appliedReturns:evidence.applied.returns,minTrades:input.minTrades});
    return finish(assessment);
  } catch(error) {
    // Do not serialize invalid NaN/undefined inputs as invented null metrics.
    try{configFingerprint(evidence);}catch{evidence={version:1,kind:'weekly_paired_followup',ticker:input.ticker,apply_eligible:false,prospectiveCertification:false};}
    return finish({decision:'PENDING',reason:error instanceof Error?error.message:String(error)});
  } finally {own?.close();}
}
