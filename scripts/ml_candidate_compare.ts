/** Isolated, retrospective candidate-vs-OFF replay. Never publishes deployment evidence. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runBacktest, prepareEntries} from '../jarvis-os/src/services/backtestEngine.js';
import {planReplayWindow} from '../jarvis-os/src/services/replayWindow.js';
import {loadSelectionLogs} from './periodic_opt/selection_context.js';
import {stableCanonical, loadEvaluationManifest, readOnlyReplayConfig} from './hyperopt/evaluation_protocol.js';
import {loadModelFromJSON, setMLGateOverride, setMLGateDeployment, setMLWindowStart, getMLGateStatus} from '../src/engine/MLFilter.js';
import {completedTrades, metrics} from './ml_threshold_sweep.js';
const ROOT='/opt/JARVIS';
export const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const clone=(v:any)=>JSON.parse(JSON.stringify(v));
export function strategyConfig(config:any) {
  const c=clone(config); for(const k of ['mlGate','mlGateEnabled','mlGateDeployment']) delete c[k];
  return readOnlyReplayConfig(c);
}
export function candidateContext(raw:Buffer,ticker:string,expectedSha:string,currentConfig?:any) {
  if(hash(raw)!==expectedSha) throw new Error('candidate raw SHA256 mismatch');
  const model=JSON.parse(raw.toString('utf8')),m=model.meta;
  if(m?.ticker!==ticker || m?.protocol_version!==1) throw new Error('candidate ticker/protocol mismatch');
  const manifest=loadEvaluationManifest(m.evaluation_manifest,ticker);
  if(m.threshold!==0.65) throw new Error('candidate threshold must be exactly 0.65');
  const config=strategyConfig(m.config);
  if(config.ticker!==ticker) throw new Error('candidate config ticker mismatch');
  const declared=m.dataset_source?.partitions?.validation?.effective_config;
  if(!declared || stableCanonical(strategyConfig(declared))!==stableCanonical(config)) throw new Error('candidate frozen validation config mismatch');
  if(currentConfig && stableCanonical(strategyConfig(currentConfig))!==stableCanonical(config)) throw new Error('current production config differs from candidate frozen config');
  return {model,config,fromMs:manifest.train_end_ms,toMs:manifest.validation_end_ms,manifest,sha256:expectedSha};
}
export function verifyFiles(files:any[],read:(p:string)=>Buffer=fs.readFileSync as any) {
  if(!Array.isArray(files)||files.length===0) throw new Error('missing frozen dataset provenance');
  for(const f of files) if(!f || typeof f.path!=='string'||! /^[a-f0-9]{64}$/.test(f.sha256)||hash(read(f.path))!==f.sha256) throw new Error(`input hash mismatch: ${f?.path}`);
}
export function configureArm(ctx:any,enabled:boolean,runtime:any={loadModelFromJSON,setMLGateOverride,setMLGateDeployment,setMLWindowStart,getMLGateStatus}) {
  runtime.setMLGateOverride(ctx.ticker,enabled);
  runtime.setMLGateDeployment(ctx.ticker,enabled?{schemaVersion:2,modelSha256:ctx.sha256,threshold:0.65,evidenceId:'0'.repeat(64)}:undefined);
  // This is a declared retrospective reconstruction, NOT a historical availability claim.
  runtime.setMLWindowStart(enabled?ctx.fromMs-1:0);
  if(enabled) {
    if(!runtime.loadModelFromJSON(ctx.raw.toString('utf8'),ctx.ticker,ctx.sha256)) throw new Error('candidate rejected by production loader; no generic/no-op fallback');
    const s=runtime.getMLGateStatus(ctx.ticker);
    if(!s.ready||!s.gateEnabled||s.modelSha256!==ctx.sha256||s.threshold!==0.65) throw new Error('candidate exact-model gate is not active');
  }
}
export function recommendation(baseline:any,gate:any) {
  if(gate.pnlR-baseline.pnlR<=0) return {recommendation:'KEEP_OFF',reason:'El candidato no mejora el PnL del replay sin gate en esta validación retrospectiva.'};
  if(baseline.n<30||gate.n<30) return {recommendation:'INSUFFICIENT_EVIDENCE',reason:'Delta positivo, pero se requieren al menos 30 operaciones completadas por brazo para revisar evidencia.'};
  return {recommendation:'REVIEW_CANDIDATE',reason:'Mejora retrospectiva; requiere evaluación independiente adicional. No autoriza activación.'};
}
function context(candidate:string,expectedSha:string,currentConfig?:any) {
  const raw=fs.readFileSync(candidate),ticker=JSON.parse(raw.toString()).meta?.ticker;
  if(!/^[A-Z0-9]+$/.test(ticker)) throw new Error('invalid candidate ticker');
  const c=candidateContext(raw,ticker,expectedSha,currentConfig);
  const dataset=c.model.meta.dataset_source?.worker_provenance?.dataset_files;
  verifyFiles(dataset);
  const dir=path.join(ROOT,'logs',ticker.toLowerCase(),'history_exported');
  const actual=fs.readdirSync(dir).filter(f=>f.endsWith('.csv')).map(f=>path.join(dir,f)).sort();
  if(stableCanonical(actual)!==stableCanonical(dataset.map((f:any)=>f.path).sort())) throw new Error('frozen dataset file set changed');
  // UI code is deliberately not an inference dependency. Replay/feature code is.
  const sources=c.model.meta.dataset_source?.worker_provenance?.source_files;
  const critical=(sources??[]).filter((f:any)=>/\/src\/engine\/|\/services\/(backtestEngine|replayWindow|backtestTypes)\.ts$|\/scripts\/(periodic_opt\/selection_context|hyperopt\/evaluation_protocol)\.ts$/.test(f.path));
  if(!critical.some((f:any)=>f.path.endsWith('/backtestEngine.ts')) || !critical.some((f:any)=>f.path.endsWith('/MLFilter.ts'))) throw new Error('missing replay engine source provenance');
  verifyFiles(critical);
  return {...c,raw,ticker,dataset,critical,dir};
}
async function arm(candidate:string,sha256:string,enabled:boolean) {
  const c=context(candidate,sha256);
  configureArm(c,enabled);
  const logs=loadSelectionLogs({ticker:c.ticker,logsDir:c.dir});
  if(logs.size!==5) throw new Error('five TF datasets required');
  const entries=await prepareEntries(logs);
  const window=planReplayWindow(entries,c.fromMs,c.toMs);
  const config=readOnlyReplayConfig({...clone(c.config),mlGateEnabled:enabled,mlGate:enabled?{enabled:true,modelPath:candidate,trainedAt:c.fromMs-1}:{enabled:false}});
  const result=runBacktest(logs,config,undefined,entries,window);
  if(!result.replayDiagnostics?.readiness.ready) throw new Error('insufficient replay warmup context');
  if(enabled) {
    const s=getMLGateStatus(c.ticker);
    if(!s.ready||!s.gateEnabled||s.modelSha256!==sha256||s.threshold!==0.65) throw new Error('exact candidate gate changed during replay');
  }
  const terminal=entries.reduce((max,e)=>e.ts>=window.warmupStartMs&&e.ts<c.toMs?Math.max(max,e.ts):max,-1);
  const closed=completedTrades(result.trades??[],c.fromMs,c.toMs,terminal);
  context(candidate,sha256); // Recheck all immutable inputs AFTER replay.
  return {metrics:metrics(closed),terminalMs:terminal,warmupStartMs:window.warmupStartMs,gateVerified:enabled,modelSha256:enabled?sha256:null,threshold:enabled?0.65:null};
}
export async function compareCandidate(candidate:string,expectedSha:string,currentConfig?:any) {
  const base:any={schemaVersion:1,status:'unavailable',ticker:path.basename(candidate).split('-')[0],candidate:path.relative(ROOT,candidate),candidateSha256:expectedSha,threshold:0.65,evaluatedAt:Date.now(),scope:'retrospective_validation',recommendation:'INSUFFICIENT_EVIDENCE',reason:'',applyEligible:false,prospective:false,independentTest:false};
  try {
    const c=context(candidate,expectedSha,currentConfig);
    Object.assign(base,{ticker:c.ticker,fromMs:c.fromMs,toMs:c.toMs,provenance:{configSha256:hash(stableCanonical(c.config)),datasetFiles:c.dataset,replaySourceFiles:c.critical,manifest:c.manifest,trainingDeclaredConfigSha256:c.model.meta.config_sha256,completionPolicy:'closed finiteR WIN/LOSS/BE/TIMEOUT/REVERSAL; close before terminal; no FINAL_CENSOR; no OPEN/unlabelled',replayContext:'same historical datasets with pre-validation warmup in both separate processes'}});
    const results=[];
    for(const mode of ['off','on']) {
      const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'--arm',mode,'--candidate',candidate,'--sha256',expectedSha],{cwd:ROOT,encoding:'utf8',timeout:300000,maxBuffer:64*1024*1024});
      if(child.error||child.status!==0) throw new Error(`replay ${mode} failed: ${child.error?.message??child.stderr?.slice(-2000)}`);
      const marker=child.stdout.split('\n').findLast((line:string)=>line.startsWith('ML_CANDIDATE_RESULT='));
      if(!marker) throw new Error(`replay ${mode} result missing`);
      results.push(JSON.parse(marker.slice('ML_CANDIDATE_RESULT='.length)));
    }
    if(!results[1].gateVerified||results[1].modelSha256!==expectedSha||results[1].threshold!==0.65) throw new Error('candidate gate proof missing');
    if(results[0].terminalMs!==results[1].terminalMs||results[0].warmupStartMs!==results[1].warmupStartMs) throw new Error('paired replay context mismatch');
    context(candidate,expectedSha,currentConfig);
    const baseline=results[0].metrics,gate=results[1].metrics;
    if(!baseline.n||!gate.n) return {...base,baseline,gate,reason:'No completed trades in one replay arm'};
    return {...base,status:'valid',baseline,gate,deltaR:gate.pnlR-baseline.pnlR,...recommendation(baseline,gate),gateProof:results[1]};
  } catch(error:any) {return {...base,reason:error.message};}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const value=(key:string)=>process.argv[process.argv.indexOf(key)+1];
  (async()=>{
    const candidate=path.resolve(value('--candidate')),sha=value('--sha256');
    if(!/^[a-f0-9]{64}$/.test(sha)) throw new Error('explicit candidate --sha256 required');
    const result=process.argv.includes('--arm')?await arm(candidate,sha,value('--arm')==='on'):await compareCandidate(candidate,sha,process.argv.includes('--current-config')?JSON.parse(fs.readFileSync(value('--current-config'),'utf8')):undefined);
    console.log('ML_CANDIDATE_RESULT='+JSON.stringify(result));
  })().catch(e=>{console.error(e.message);process.exitCode=1;});
}
