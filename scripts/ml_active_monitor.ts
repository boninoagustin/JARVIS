/** Read-only post-activation full-strategy replay. No fitting, deployment or automatic action. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runBacktest,prepareEntries} from '../jarvis-os/src/services/backtestEngine.js';
import {planReplayWindow} from '../jarvis-os/src/services/replayWindow.js';
import {loadSelectionLogs} from './periodic_opt/selection_context.js';
import {stableCanonical,readOnlyReplayConfig} from './hyperopt/evaluation_protocol.js';
import {completedTrades,metrics} from './ml_threshold_sweep.js';
import {loadModelFromJSON,setMLGateOverride,setMLGateDeployment,setMLWindowStart,getMLGateStatus} from '../src/engine/MLFilter.js';
const ROOT='/opt/JARVIS';
export const DAY_MS=86400000;
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value)) freeze(child);Object.freeze(value);}return value;}
export const RULES=freeze({version:1,id:'ml-active-monitor/v1',minimumCompletedPerArm:30,recentDays:28,maximumDataAgeDays:7,requireNewCompletedTradesForConfirmation:true,
  maintain:{minimumDeltaExclusive:0,drawdownMultiplier:1.25,drawdownAllowanceR:1},
  recalibrate:{maximumDeltaR:-2},disable:{maximumDeltaR:-5,minimumAdditionalDrawdownExclusiveR:2},
  confirmation:{assessments:2,minimumSpacingDays:7,sameActivationModelThresholdConfigEngine:true,newDataThroughRequired:true},
  automation:false});
export interface MonitorInput {ticker:string;activationId:string;modelPath:string;modelSha256:string;threshold:number;config:any;fromMs:number;toMs:number;recentFromMs:number;dataDir:string;engineFingerprint?:string;configFingerprint?:string;}
export interface FileIdentity {path:string;sha256:string;}
export interface MonitorMetrics {n:number;pnlR:number;wr:number;pf:number;mdd:number;}
export type BaseSignal='INSUFFICIENT_DATA'|'MAINTAIN'|'RECALIBRATE_SIGNAL'|'DISABLE_SIGNAL'|'OBSERVE';
export const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const clone=(v:any)=>JSON.parse(JSON.stringify(v));
class MonitorError extends Error {constructor(public code:string,message:string){super(message);}}
const fail=(code:string,message:string):never=>{throw new MonitorError(code,message);};
export function strategyConfig(input:any) {
  const c=readOnlyReplayConfig(input) as any;
  for(const key of ['mlGate','mlGateEnabled','mlGateDeployment']) delete c[key];
  return c;
}
export function validateInput(value:any,rawModel:Buffer,now=Date.now()) {
  if(!value||typeof value!=='object'||Array.isArray(value)) fail('INVALID_INPUT','Monitor input must be an object');
  const i=value as MonitorInput;
  if(!/^[A-Z0-9]{1,24}$/.test(i.ticker)||typeof i.activationId!=='string'||!i.activationId.trim()||i.activationId.length>256) fail('INVALID_IDENTITY','Exact ticker and nonempty activationId required');
  if(typeof i.modelPath!=='string'||!path.isAbsolute(i.modelPath)||typeof i.dataDir!=='string'||!path.isAbsolute(i.dataDir)) fail('INVALID_INPUT','Absolute archive and history directory paths required');
  if(!/^[a-f0-9]{64}$/.test(i.modelSha256)||hash(rawModel)!==i.modelSha256) fail('MODEL_HASH_MISMATCH','Archived model raw SHA256 mismatch');
  if(typeof i.threshold!=='number'||!Number.isFinite(i.threshold)||!(i.threshold>0&&i.threshold<1)) fail('INVALID_THRESHOLD','Active threshold must be a finite number strictly between zero and one');
  if(![i.fromMs,i.toMs,i.recentFromMs].every(v=>Number.isSafeInteger(v)&&v>=0)||i.fromMs>now||i.toMs>now) fail('INVALID_WINDOW','Monitoring windows require integer UTC milliseconds and cannot be in the future');
  if(i.toMs<=i.fromMs) fail('NO_DATA','No history after the monitoring start: monitoring window is empty');
  if(i.recentFromMs!==Math.max(i.fromMs,i.toMs-RULES.recentDays*DAY_MS)) fail('INVALID_WINDOW','Recent window must be exactly the latest 28 days, capped at the verified monitoring start');
  let model:any;try{model=JSON.parse(rawModel.toString('utf8'));}catch{fail('MODEL_INVALID','Archived model is not JSON');}
  const meta=model?.meta;
  if(meta?.ticker!==i.ticker) fail('MODEL_TICKER_MISMATCH','Archived own-model ticker mismatch');
  if(!Number.isSafeInteger(meta?.train_end_ms)||meta.train_end_ms<0||!Number.isSafeInteger(meta?.available_at_ms)||meta.available_at_ms<meta.train_end_ms) fail('MODEL_PROVENANCE_UNKNOWN','Authoritative train_end_ms and available_at_ms required; no mtime or inferred availability');
  if(i.fromMs<meta.available_at_ms) fail('PRE_AVAILABILITY_WINDOW','Monitoring start precedes authoritative model availability');
  const config=strategyConfig(i.config);
  if(config.ticker!==i.ticker) fail('INVALID_CONFIG','Mapped strategy config ticker mismatch');
  const configFingerprint=hash(stableCanonical(config));
  if(i.configFingerprint!==undefined&&i.configFingerprint!==configFingerprint) fail('CONFIG_HASH_MISMATCH','Frozen mapped strategy config fingerprint mismatch');
  return {input:{...clone(i),config},model,configFingerprint,modelAvailableAtMs:meta.available_at_ms,trainEndMs:meta.train_end_ms};
}
function tsFiles(directory:string):string[] {
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(d=>{
    const p=path.join(directory,d.name);
    return d.isDirectory()?tsFiles(p):d.isFile()&&d.name.endsWith('.ts')&&!/(\.test\.ts$|^test_)/.test(d.name)?[p]:[];
  });
}
function identities(files:string[]):FileIdentity[] {return [...new Set(files)].sort().map(p=>({path:p,sha256:hash(fs.readFileSync(p))}));}
export function getCriticalSourceSnapshot():FileIdentity[] {
  const files=[...tsFiles(path.join(ROOT,'src/engine')),...tsFiles(path.join(ROOT,'jarvis-os/src/engine')),
    ...['backtestEngine.ts','backtestTypes.ts','replayWindow.ts','mlGateDeployment.ts'].map(f=>path.join(ROOT,'jarvis-os/src/services',f)),
    ...['periodic_opt/selection_context.ts','hyperopt/evaluation_protocol.ts','ml_threshold_sweep.ts','ml_active_monitor.ts'].map(f=>path.join(ROOT,'scripts',f))];
  return identities(files);
}
export function getCriticalSourceFingerprint():string {return hash(stableCanonical(getCriticalSourceSnapshot()));}
function csvFiles(directory:string):string[] {return fs.readdirSync(directory,{withFileTypes:true}).filter(d=>d.isFile()&&d.name.endsWith('.csv')).map(d=>path.join(directory,d.name)).sort();}
export function verifyFrozenFiles(files:FileIdentity[],read:(p:string)=>Buffer=fs.readFileSync as any) {
  if(!Array.isArray(files)) fail('INPUT_SNAPSHOT_INVALID','Frozen file identities missing');
  for(const f of files) if(!f||typeof f.path!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256)||hash(read(f.path))!==f.sha256) fail('INPUT_CHANGED',`Frozen input changed: ${f?.path}`);
}
interface InputSnapshot {datasetFiles:FileIdentity[];sourceFiles:FileIdentity[];auxiliaryFiles:FileIdentity[];engineFingerprint:string;configFingerprint:string;}
function captureInputs(input:MonitorInput,configFingerprint:string):InputSnapshot {
  const datasetFiles=identities(csvFiles(input.dataDir));
  if(datasetFiles.length<5) fail('DATASET_INCOMPLETE','At least the five production TF CSV datasets are required');
  const sourceFiles=getCriticalSourceSnapshot(),engineFingerprint=hash(stableCanonical(sourceFiles));
  if(input.engineFingerprint!==undefined&&input.engineFingerprint!==engineFingerprint) fail('ENGINE_HASH_MISMATCH','Current replay engine differs from activation/config epoch');
  const auxiliaryFiles:FileIdentity[]=[];
  if(input.config.timesfm?.enabled===true) auxiliaryFiles.push(...identities([path.resolve(ROOT,input.config.timesfm.cachePath)]));
  return {datasetFiles,sourceFiles,auxiliaryFiles,engineFingerprint,configFingerprint};
}
function verifyInputs(input:MonitorInput,snapshot:InputSnapshot) {
  if(hash(fs.readFileSync(input.modelPath))!==input.modelSha256) fail('MODEL_HASH_MISMATCH','Archived model changed during assessment');
  if(hash(stableCanonical(strategyConfig(input.config)))!==snapshot.configFingerprint) fail('CONFIG_HASH_MISMATCH','Frozen assessment config changed');
  if(stableCanonical(csvFiles(input.dataDir))!==stableCanonical(snapshot.datasetFiles.map(f=>f.path))) fail('INPUT_CHANGED','History CSV file set changed during assessment');
  verifyFrozenFiles(snapshot.datasetFiles);verifyFrozenFiles(snapshot.sourceFiles);verifyFrozenFiles(snapshot.auxiliaryFiles);
  const current=getCriticalSourceSnapshot();
  if(stableCanonical(current)!==stableCanonical(snapshot.sourceFiles)) fail('INPUT_CHANGED','Replay source file set or content changed during assessment');
}
export function coveredWindows(input:MonitorInput,entries:readonly {ts:number}[],now=Date.now()) {
  const last=entries.reduce((v,e)=>Number.isSafeInteger(e.ts)&&e.ts<=now&&e.ts<input.toMs?Math.max(v,e.ts):v,-1);
  const toMs=Math.min(input.toMs,last+1,now);
  if(last<input.fromMs||toMs<=input.fromMs) fail('NO_DATA','No post-activation history events are available');
  const recentFromMs=Math.max(input.fromMs,toMs-RULES.recentDays*DAY_MS);
  return {dataThroughMs:last,dataStale:now-last>RULES.maximumDataAgeDays*DAY_MS,
    cumulative:{fromMs:input.fromMs,toMs},recent:{fromMs:recentFromMs,toMs}};
}
export function configureMonitorArm(ctx:{input:MonitorInput;raw:Buffer;fromMs:number},enabled:boolean,runtime:any={loadModelFromJSON,setMLGateOverride,setMLGateDeployment,setMLWindowStart,getMLGateStatus}) {
  const i=ctx.input;
  runtime.setMLGateOverride(i.ticker,enabled);
  runtime.setMLGateDeployment(i.ticker,enabled?{schemaVersion:2,modelSha256:i.modelSha256,threshold:i.threshold,evidenceId:'0'.repeat(64)}:undefined);
  runtime.setMLWindowStart(enabled?ctx.fromMs-1:0);
  if(enabled) {
    if(!runtime.loadModelFromJSON(ctx.raw.toString('utf8'),i.ticker,i.modelSha256)) fail('MODEL_REJECTED','Own archived model rejected by production loader; no default/no-op fallback');
    verifyGate(i,runtime.getMLGateStatus(i.ticker));
  }
}
export function verifyGate(input:MonitorInput,status:any) {
  if(!status?.ready||!status.gateEnabled||status.modelSha256!==input.modelSha256||status.threshold!==input.threshold) fail('GATE_PROOF_INVALID','Exact archived model and active threshold are not enabled in replay');
}
export function validMetrics(m:any):m is MonitorMetrics {return !!m&&Number.isInteger(m.n)&&m.n>=0&&[m.pnlR,m.wr,m.pf,m.mdd].every(Number.isFinite)&&m.wr>=0&&m.wr<=100&&m.pf>=0&&m.mdd>=0;}
export function assessSignals(windows:any,dataStale=false):{baseSignal:BaseSignal;reason:string} {
  const list=[windows?.cumulative,windows?.recent];
  if(list.some(w=>!w||!validMetrics(w.baseline)||!validMetrics(w.active)||!Number.isFinite(w.deltaR)||Math.abs(w.deltaR-(w.active.pnlR-w.baseline.pnlR))>1e-6)) fail('INVALID_METRICS','Paired monitoring metrics are missing, nonfinite or inconsistent');
  if(dataStale) return {baseSignal:'INSUFFICIENT_DATA',reason:'History exports are more than seven days old; stale data cannot confirm model health or deterioration'};
  if(list.some(w=>w.baseline.n<RULES.minimumCompletedPerArm||w.active.n<RULES.minimumCompletedPerArm)) return {baseSignal:'INSUFFICIENT_DATA',reason:'At least 30 completed trades in each arm of both windows are required, regardless of PnL sign'};
  if(list.every(w=>w.deltaR<=RULES.disable.maximumDeltaR&&w.active.mdd>w.baseline.mdd+RULES.disable.minimumAdditionalDrawdownExclusiveR)) return {baseSignal:'DISABLE_SIGNAL',reason:'Both windows meet severe deterioration limits; this is only a signal requiring separate weekly confirmation'};
  if(list.every(w=>w.deltaR<=RULES.recalibrate.maximumDeltaR)) return {baseSignal:'RECALIBRATE_SIGNAL',reason:'Both windows lose at least 2R versus OFF; require two distinct weekly assessments before recommending recalibration'};
  if(list.every(w=>w.deltaR>RULES.maintain.minimumDeltaExclusive&&w.active.mdd<=w.baseline.mdd*RULES.maintain.drawdownMultiplier+RULES.maintain.drawdownAllowanceR)) return {baseSignal:'MAINTAIN',reason:'Both windows improve returns within the predeclared drawdown allowance'};
  return {baseSignal:'OBSERVE',reason:'Results are mixed or do not meet the predeclared maintain/deterioration limits'};
}
async function runArm(input:MonitorInput,snapshot:InputSnapshot,name:'cumulative'|'recent',bounds:{fromMs:number;toMs:number},enabled:boolean) {
  verifyInputs(input,snapshot);
  const raw=fs.readFileSync(input.modelPath);validateInput(input,raw);
  const logs=loadSelectionLogs({ticker:input.ticker,logsDir:input.dataDir});
  if(logs.size!==5) fail('DATASET_INCOMPLETE','Exactly five TF datasets must be loadable');
  const entries=await prepareEntries(logs),window=planReplayWindow(entries,bounds.fromMs,bounds.toMs);
  if(!(window.warmupStartMs<bounds.fromMs)) fail('WARMUP_INSUFFICIENT','Historical warmup must start strictly before the monitoring window');
  configureMonitorArm({input,raw,fromMs:bounds.fromMs},enabled);
  const config=readOnlyReplayConfig({...clone(input.config),mlGateEnabled:enabled,mlGate:enabled?{enabled:true,modelPath:input.modelPath,trainedAt:bounds.fromMs-1}:{enabled:false}});
  const result=runBacktest(logs,config,undefined,entries,window);
  if(!result.replayDiagnostics?.readiness.ready) fail('WARMUP_INSUFFICIENT','Replay warmup/context is incomplete');
  if(enabled) verifyGate(input,getMLGateStatus(input.ticker));
  const terminal=entries.reduce((v,e)=>e.ts>=window.warmupStartMs&&e.ts<bounds.toMs?Math.max(v,e.ts):v,-1);
  const closed=completedTrades(result.trades??[],bounds.fromMs,bounds.toMs,terminal);
  verifyInputs(input,snapshot);
  return {window:name,...bounds,metrics:metrics(closed),terminalMs:terminal,warmupStartMs:window.warmupStartMs,
    gateVerified:enabled,modelSha256:enabled?input.modelSha256:null,threshold:enabled?input.threshold:null,
    ...(enabled&&Number.isSafeInteger((result as any).mlRejected)&&(result as any).mlRejected>=0?{replayRejectedEntries:(result as any).mlRejected}:{})};
}
/** Snapshot NEW assessment data, not the model's historical training files. */
export async function monitorActiveModel(value:MonitorInput) {
  const base:any={schemaVersion:1,scope:'post_activation_replay',status:'unavailable',ticker:value?.ticker,activationId:value?.activationId,modelSha256:value?.modelSha256,threshold:value?.threshold,
    evaluatedAt:Date.now(),rules:RULES,ruleVersion:RULES.id,baseSignal:'INSUFFICIENT_DATA',applyEligible:false,automaticAction:false};
  try {
    if(!value||typeof value.modelPath!=='string') fail('INVALID_INPUT','modelPath required');
    const raw=fs.readFileSync(value.modelPath),ctx=validateInput(value,raw,base.evaluatedAt),input=ctx.input;
    const snapshot=captureInputs(input,ctx.configFingerprint);
    Object.assign(base,{configFingerprint:ctx.configFingerprint,engineFingerprint:snapshot.engineFingerprint,modelAvailableAtMs:ctx.modelAvailableAtMs,trainEndMs:ctx.trainEndMs,fromMs:input.fromMs,requestedToMs:input.toMs,
      provenance:{...snapshot,completionPolicy:'closed finite R; WIN/LOSS/BE/TIMEOUT/REVERSAL before terminal; no OPEN/unlabelled or FINAL_CENSOR',interpretation:'Full-strategy post-activation replay, not observed broker PnL; cumulative/recent overlap is not independent confirmation'}});
    const logs=loadSelectionLogs({ticker:input.ticker,logsDir:input.dataDir});
    if(logs.size!==5) fail('DATASET_INCOMPLETE','Exactly five TF datasets must be loadable');
    const entries=await prepareEntries(logs),coverage=coveredWindows(input,entries,base.evaluatedAt);
    verifyInputs(input,snapshot);
    const windows:any={},proofs:any[]=[],cache=new Map<string,any>();
    for(const name of ['cumulative','recent'] as const) {
      const bounds=coverage[name],arms:any[]=[];
      for(const enabled of [false,true]) {
        const key=stableCanonical({enabled,...bounds});
        let proof=cache.get(key);
        if(!proof) {
          verifyInputs(input,snapshot);
          const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'--arm',name,'--mode',enabled?'active':'off'],{cwd:ROOT,input:JSON.stringify({input,snapshot,bounds}),encoding:'utf8',timeout:90000,maxBuffer:64*1024*1024});
          if(child.error||child.status!==0) fail('REPLAY_FAILED',`Replay ${name}/${enabled?'active':'off'} failed: ${child.error?.message??child.stderr?.slice(-1600)}`);
          const line=child.stdout.split('\n').findLast((s:string)=>s.startsWith('ML_ACTIVE_MONITOR_ARM='));
          if(!line) fail('REPLAY_FAILED','Replay arm result is missing');
          proof=JSON.parse(line.slice('ML_ACTIVE_MONITOR_ARM='.length));
          if(proof.fromMs!==bounds.fromMs||proof.toMs!==bounds.toMs||proof.gateVerified!==enabled||proof.modelSha256!==(enabled?input.modelSha256:null)||proof.threshold!==(enabled?input.threshold:null)||!validMetrics(proof.metrics)) fail('GATE_PROOF_INVALID','Paired arm window/model/threshold/metrics proof mismatch');
          verifyInputs(input,snapshot);cache.set(key,proof);proofs.push(proof);
        }
        arms.push(proof);
      }
      if(arms[0].terminalMs!==arms[1].terminalMs||arms[0].warmupStartMs!==arms[1].warmupStartMs) fail('REPLAY_CONTEXT_MISMATCH','Active and OFF arms must share terminal and warmup context');
      const baseline=arms[0].metrics,active=arms[1].metrics;
      windows[name]={...bounds,baseline,active,deltaR:active.pnlR-baseline.pnlR,status:baseline.n>=30&&active.n>=30?'sufficient':'insufficient',
        ...(Number.isSafeInteger(arms[1].replayRejectedEntries)?{replayRejectedEntries:arms[1].replayRejectedEntries}:{})};
    }
    verifyInputs(input,snapshot);
    return {...base,status:'valid',toMs:coverage.cumulative.toMs,dataThroughMs:coverage.dataThroughMs,dataStale:coverage.dataStale,windows,
      sameWindows:coverage.cumulative.fromMs===coverage.recent.fromMs,gateProofs:proofs,...assessSignals(windows,coverage.dataStale)};
  } catch(error:any) {return {...base,reasonCode:error.code??'MONITOR_UNAVAILABLE',reason:error.message};}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  (async()=>{
    const arg=(flag:string)=>{const n=process.argv.indexOf(flag);if(n<0||!process.argv[n+1]) throw new Error(`${flag} required`);return process.argv[n+1];};
    if(process.argv.includes('--arm')) {
      const name=arg('--arm'),mode=arg('--mode');
      if(!['cumulative','recent'].includes(name)||!['off','active'].includes(mode)) throw new Error('Invalid replay arm');
      const {input,snapshot,bounds}=JSON.parse(fs.readFileSync(0,'utf8'));
      const result=await runArm(input,snapshot,name as 'cumulative'|'recent',bounds,mode==='active');
      console.log('ML_ACTIVE_MONITOR_ARM='+JSON.stringify(result));
    } else {
      const value=JSON.parse(fs.readFileSync(arg('--input'),'utf8'));
      console.log('ML_ACTIVE_MONITOR_RESULT='+JSON.stringify(await monitorActiveModel(value)));
    }
  })().catch(error=>{console.error(error.message);process.exitCode=1;});
}
