/** Retrospective chronological threshold holdout. Never fits or publishes deployment evidence. */
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
export const THRESHOLDS=[0.50,0.65,0.80] as const;
export const MIN_CALIBRATION_TRADES=20;
export const MIN_VALIDATION_TRADES=30;
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
  const protocol=m.threshold_calibration_protocol;
  if(protocol?.version!==1 || stableCanonical(protocol.thresholds)!==stableCanonical([...THRESHOLDS])
      || protocol.minCalibrationTrades!==MIN_CALIBRATION_TRADES || protocol.minValidationTrades!==MIN_VALIDATION_TRADES)
    throw new Error('threshold calibration protocol missing or incompatible; legacy candidates cannot claim an untouched final window');
  const manifest=loadEvaluationManifest(m.evaluation_manifest,ticker);
  if(!(manifest.train_end_ms<manifest.validation_end_ms && manifest.validation_end_ms<manifest.test_end_ms))
    throw new Error('distinct nonempty calibration and final validation windows required; do not split previously inspected validation');
  if(m.threshold!==0.65) throw new Error('candidate default threshold must remain exactly 0.65; arm overrides do not edit candidate bytes');
  const config=strategyConfig(m.config);
  if(config.ticker!==ticker) throw new Error('candidate config ticker mismatch');
  if(m.test_evaluated===true) throw new Error('candidate metrics already evaluated the final partition; cannot claim this protocol');
  for(const [name,from,to] of [['train',manifest.from_ms,manifest.train_end_ms],['validation',manifest.train_end_ms,manifest.validation_end_ms]] as const) {
    const recorded=m.dataset_source?.partitions?.[name],dataset=recorded?.dataset_meta;
    if(!dataset || dataset.partition!==name || dataset.from_ms!==from || dataset.to_ms!==to || dataset.terminal_close_policy!=='censored')
      throw new Error('candidate recorded Train/Calibration windows disagree with declared manifest');
    if(!recorded.effective_config || stableCanonical(strategyConfig(recorded.effective_config))!==stableCanonical(config))
      throw new Error('candidate frozen calibration config mismatch');
  }
  if(currentConfig && stableCanonical(strategyConfig(currentConfig))!==stableCanonical(config)) throw new Error('current production config differs from candidate frozen config');
  return {model,config,manifest,sha256:expectedSha,
    calibration:{fromMs:manifest.train_end_ms,toMs:manifest.validation_end_ms},
    validation:{fromMs:manifest.validation_end_ms,toMs:manifest.test_end_ms}};
}
export function verifyFiles(files:any[],read:(p:string)=>Buffer=fs.readFileSync as any) {
  if(!Array.isArray(files)||files.length===0) throw new Error('missing frozen dataset provenance');
  for(const f of files) if(!f || typeof f.path!=='string'||! /^[a-f0-9]{64}$/.test(f.sha256)||hash(read(f.path))!==f.sha256) throw new Error(`input hash mismatch: ${f?.path}`);
}
export function configureArm(ctx:any,enabled:boolean,runtime:any={loadModelFromJSON,setMLGateOverride,setMLGateDeployment,setMLWindowStart,getMLGateStatus},threshold:number=0.65) {
  if(enabled && !(THRESHOLDS as readonly number[]).includes(threshold)) throw new Error('arm threshold is not declared in protocol');
  runtime.setMLGateOverride(ctx.ticker,enabled);
  runtime.setMLGateDeployment(ctx.ticker,enabled?{schemaVersion:2,modelSha256:ctx.sha256,threshold,evidenceId:'0'.repeat(64)}:undefined);
  // Deliberate retrospective inference, NOT a historical model-availability claim.
  runtime.setMLWindowStart(enabled?ctx.fromMs-1:0);
  if(enabled) {
    if(!runtime.loadModelFromJSON(ctx.raw.toString('utf8'),ctx.ticker,ctx.sha256)) throw new Error('candidate rejected by production loader; no generic/no-op fallback');
    const s=runtime.getMLGateStatus(ctx.ticker);
    if(!s.ready||!s.gateEnabled||s.modelSha256!==ctx.sha256||s.threshold!==threshold) throw new Error('candidate exact-model gate is not active');
  }
}
/** Final sample guard always precedes interpretation of final PnL. */
export function recommendation(baseline:any,gate:any) {
  if(baseline.n<MIN_VALIDATION_TRADES||gate.n<MIN_VALIDATION_TRADES) return {recommendation:'INSUFFICIENT_EVIDENCE',reason:'Validación final insuficiente: mínimo 30 operaciones completadas en ambos brazos. No se elige otro umbral.'};
  if(gate.pnlR-baseline.pnlR<=0) return {recommendation:'KEEP_OFF',reason:'El umbral elegido en calibración no mejora el PnL sin gate en la validación posterior.'};
  return {recommendation:'REVIEW_CANDIDATE',reason:'Mejora en holdout cronológico retrospectivo; no es prueba prospectiva ni autoriza activación.'};
}
export function selectCalibration(baseline:any,runs:any[]) {
  if(baseline.n<MIN_CALIBRATION_TRADES) return {selectedMode:'off',selectedThreshold:null,selectionMade:false};
  const candidates=runs.filter(r=>r.eligible && r.metrics.n>=MIN_CALIBRATION_TRADES && r.metrics.pnlR>baseline.pnlR);
  candidates.sort((a,b)=>{
    const pnl=b.metrics.pnlR-a.metrics.pnlR;
    if(pnl!==0) return pnl;
    const distance=Math.abs(a.threshold-.65)-Math.abs(b.threshold-.65);
    return Math.abs(distance)>1e-12?distance:a.threshold-b.threshold;
  });
  return candidates.length?{selectedMode:'gate',selectedThreshold:candidates[0].threshold,selectionMade:true}:{selectedMode:'off',selectedThreshold:null,selectionMade:true};
}
type ReplayRequest={phase:'calibration'|'validation';mode:'off'|'gate';threshold:number|null;fromMs:number;toMs:number};
function assertMetrics(m:any) {
  if(!m || !Number.isInteger(m.n)||m.n<0||![m.pnlR,m.wr,m.pf,m.mdd].every(Number.isFinite)||m.wr<0||m.wr>100||m.mdd<0||m.pf<0)
    throw new Error('invalid replay metrics');
}
/** Injectable replay proves selection ordering and never exposes final metrics to selection. */
export async function thresholdHoldout(windows:any,replay:(request:ReplayRequest)=>Promise<any>|any) {
  const get=async(phase:'calibration'|'validation',threshold:number|null)=>{
    const result=await replay({phase,mode:threshold===null?'off':'gate',threshold,...windows[phase]});
    assertMetrics(result); return result;
  };
  const baseline=await get('calibration',null),runs:any[]=[];
  for(const threshold of THRESHOLDS) {
    const m=await get('calibration',threshold),eligible=m.n>=MIN_CALIBRATION_TRADES;
    runs.push({threshold,metrics:m,eligible,...(!eligible?{reason:'Menos de 20 operaciones completadas en calibración; no compite'}:{})});
  }
  // Freeze the winner BEFORE executing any final-validation replay.
  const selection=Object.freeze(selectCalibration(baseline,runs));
  const calibration={...windows.calibration,baseline,runs,...selection};
  const finalBaseline=await get('validation',null);
  const selected=selection.selectedMode==='gate'?await get('validation',selection.selectedThreshold):null;
  const validation={...windows.validation,baseline:finalBaseline,selected,deltaR:selected?selected.pnlR-finalBaseline.pnlR:null};
  if(!selection.selectionMade) return {status:'insufficient',calibration,validation,selectedThreshold:null,recommendation:'INSUFFICIENT_EVIDENCE',reason:'Calibración sin filtro insuficiente: mínimo 20 operaciones. No se declara un umbral ganador.'};
  if(!selected) {
    if(finalBaseline.n<MIN_VALIDATION_TRADES) return {status:'insufficient',calibration,validation,selectedThreshold:null,recommendation:'INSUFFICIENT_EVIDENCE',reason:'Sin gate ganó la calibración; la muestra del período final es insuficiente (mínimo 30). No se probó un gate en ese período.'};
    return {status:'valid',calibration,validation,selectedThreshold:null,recommendation:'KEEP_OFF',reason:'Sin gate ganó la calibración (también gana los empates). En el período final solo se midió sin gate; no existe un resultado con gate seleccionado.'};
  }
  const advice=recommendation(finalBaseline,selected);
  return {status:advice.recommendation==='INSUFFICIENT_EVIDENCE'?'insufficient':'valid',calibration,validation,selectedThreshold:selection.selectedThreshold,...advice};
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
  // UI code is not an inference dependency. Replay/feature/projection code is.
  const sources=c.model.meta.dataset_source?.worker_provenance?.source_files;
  const critical=(sources??[]).filter((f:any)=>/\/src\/engine\/|\/services\/(backtestEngine|replayWindow|backtestTypes)\.ts$|\/scripts\/(periodic_opt\/selection_context|hyperopt\/evaluation_protocol)\.ts$/.test(f.path));
  if(!critical.some((f:any)=>f.path.endsWith('/backtestEngine.ts')) || !critical.some((f:any)=>f.path.endsWith('/MLFilter.ts'))) throw new Error('missing replay engine source provenance');
  verifyFiles(critical);
  return {...c,raw,ticker,dataset,critical,dir};
}
async function arm(candidate:string,sha256:string,phase:'calibration'|'validation',threshold:number|null) {
  const c=context(candidate,sha256),windowBounds=c[phase],enabled=threshold!==null;
  if(!windowBounds) throw new Error('invalid replay phase');
  configureArm({...c,fromMs:windowBounds.fromMs},enabled,undefined,threshold??.65);
  const logs=loadSelectionLogs({ticker:c.ticker,logsDir:c.dir});
  if(logs.size!==5) throw new Error('five TF datasets required');
  const entries=await prepareEntries(logs);
  const window=planReplayWindow(entries,windowBounds.fromMs,windowBounds.toMs);
  const config=readOnlyReplayConfig({...clone(c.config),mlGateEnabled:enabled,mlGate:enabled?{enabled:true,modelPath:candidate,trainedAt:windowBounds.fromMs-1}:{enabled:false}});
  const result=runBacktest(logs,config,undefined,entries,window);
  if(!result.replayDiagnostics?.readiness.ready) throw new Error('insufficient replay warmup context');
  if(enabled) {
    const s=getMLGateStatus(c.ticker);
    if(!s.ready||!s.gateEnabled||s.modelSha256!==sha256||s.threshold!==threshold) throw new Error('exact candidate gate changed during replay');
  }
  const terminal=entries.reduce((max,e)=>e.ts>=window.warmupStartMs&&e.ts<windowBounds.toMs?Math.max(max,e.ts):max,-1);
  const closed=completedTrades(result.trades??[],windowBounds.fromMs,windowBounds.toMs,terminal);
  context(candidate,sha256);
  return {metrics:metrics(closed),phase,...windowBounds,terminalMs:terminal,warmupStartMs:window.warmupStartMs,gateVerified:enabled,modelSha256:enabled?sha256:null,threshold};
}
export async function compareCandidate(candidate:string,expectedSha:string,currentConfig?:any) {
  const base:any={schemaVersion:2,status:'unavailable',ticker:path.basename(candidate).split('-')[0],candidate:path.relative(ROOT,candidate),candidateSha256:expectedSha,evaluatedAt:Date.now(),scope:'temporal_threshold_holdout',selectedThreshold:null,recommendation:'INSUFFICIENT_EVIDENCE',reason:'',applyEligible:false,prospective:false,independentTest:false};
  try {
    const c=context(candidate,expectedSha,currentConfig);
    Object.assign(base,{ticker:c.ticker,provenance:{configSha256:hash(stableCanonical(c.config)),datasetFiles:c.dataset,replaySourceFiles:c.critical,manifest:c.manifest,thresholdProtocol:c.model.meta.threshold_calibration_protocol,trainingDeclaredConfigSha256:c.model.meta.config_sha256,completionPolicy:'closed finiteR WIN/LOSS/BE/TIMEOUT/REVERSAL; close before terminal; no FINAL_CENSOR; no OPEN/unlabelled',replayContext:'same historical datasets; phase-specific identical pre-window warmup in separate processes',selectionRule:'max calibration PnL only; OFF wins ties; threshold ties nearest .65 then lower; no final reselection',historicalIndependence:'retrospective chronological holdout; not globally untouched historical Test or prospective evidence'}});
    const proofs:any[]=[];
    const result=await thresholdHoldout(c,async request=>{
      const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'--arm',request.mode,'--phase',request.phase,'--threshold',request.threshold===null?'off':String(request.threshold),'--candidate',candidate,'--sha256',expectedSha],{cwd:ROOT,encoding:'utf8',timeout:90000,maxBuffer:64*1024*1024});
      if(child.error||child.status!==0) throw new Error(`replay ${request.phase}/${request.mode}/${request.threshold} failed: ${child.error?.message??child.stderr?.slice(-2000)}`);
      const marker=child.stdout.split('\n').findLast((line:string)=>line.startsWith('ML_CANDIDATE_RESULT='));
      if(!marker) throw new Error('replay result missing');
      const proof=JSON.parse(marker.slice('ML_CANDIDATE_RESULT='.length));
      if(proof.phase!==request.phase||proof.fromMs!==request.fromMs||proof.toMs!==request.toMs||proof.threshold!==request.threshold) throw new Error('replay window/threshold proof mismatch');
      if(request.mode==='gate'&&(!proof.gateVerified||proof.modelSha256!==expectedSha)) throw new Error('candidate gate proof missing');
      if(request.mode==='off'&&(proof.gateVerified||proof.modelSha256!==null)) throw new Error('OFF replay contaminated by gate');
      const baseline=proofs.find(p=>p.phase===request.phase&&p.threshold===null);
      if(baseline&&(baseline.terminalMs!==proof.terminalMs||baseline.warmupStartMs!==proof.warmupStartMs)) throw new Error('paired replay context mismatch');
      proofs.push(proof);
      return proof.metrics;
    });
    context(candidate,expectedSha,currentConfig);
    return {...base,...result,gateProofs:proofs};
  } catch(error:any) {return {...base,reason:error.message};}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const value=(key:string)=>{const i=process.argv.indexOf(key);if(i<0||!process.argv[i+1]) throw new Error(`${key} required`);return process.argv[i+1];};
  (async()=>{
    const candidate=path.resolve(value('--candidate')),sha=value('--sha256');
    if(!/^[a-f0-9]{64}$/.test(sha)) throw new Error('explicit candidate --sha256 required');
    let result;
    if(process.argv.includes('--arm')) {
      const mode=value('--arm'),phase=value('--phase'),rawThreshold=value('--threshold');
      if(!['off','gate'].includes(mode)||!['calibration','validation'].includes(phase)) throw new Error('invalid arm/phase');
      const threshold=rawThreshold==='off'?null:Number(rawThreshold);
      if((mode==='off')!==(threshold===null)||threshold!==null&&!(THRESHOLDS as readonly number[]).includes(threshold)) throw new Error('arm threshold mismatch');
      result=await arm(candidate,sha,phase as 'calibration'|'validation',threshold);
    } else result=await compareCandidate(candidate,sha,process.argv.includes('--current-config')?JSON.parse(fs.readFileSync(value('--current-config'),'utf8')):undefined);
    console.log('ML_CANDIDATE_RESULT='+JSON.stringify(result));
  })().catch(e=>{console.error(e.message);process.exitCode=1;});
}
