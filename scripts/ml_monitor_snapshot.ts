/** Read-only gate activation/config snapshot. Never writes Firestore or models. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import admin from 'firebase-admin';
import {configFingerprint} from '../jarvis-os/src/services/mlGateDeployment.js';
import {mapAssetConfig,loadSelectionLogs} from './periodic_opt/selection_context.js';
import {stableCanonical} from './hyperopt/evaluation_protocol.js';
import {getCriticalSourceFingerprint,getCriticalSourceSnapshot,strategyConfig} from './ml_active_monitor.js';
import {prepareEntries} from '../jarvis-os/src/services/backtestEngine.js';
import {selectCalibration} from './ml_candidate_compare.js';
const ROOT='/opt/JARVIS';
const plain=(v:any)=>JSON.parse(JSON.stringify(v));
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const strategy=(v:any)=>{const c=plain(v);for(const k of ['mlGate','mlGateEnabled','mlGateDeployment'])delete c[k];return c;};
if(!admin.apps.length)admin.initializeApp({credential:admin.credential.cert(JSON.parse(fs.readFileSync(path.join(ROOT,'service-account.json'),'utf8')))});
const db=admin.firestore(),nowMs=Date.now();
const [configs,refs,roster]=await Promise.all([db.collection('asset_configs').get(),db.collection('ml_gate_monitor_refs').get(),db.doc('optimization_config/active_tickers').get()]);
const pointers=new Map(refs.docs.map(d=>[d.id,d.data()]));
const assets:Record<string,any>={};
let calibration:any={assets:{}};try{calibration=JSON.parse(fs.readFileSync(path.join(ROOT,'data/ml_calibration/status.json'),'utf8'));}catch{}
function candidateFor(ticker:string){
 try{
  const entry=calibration.assets?.[ticker],binding=entry?.candidate,c=entry?.comparison;
  // A frozen historical comparison can become unavailable when NEW history is
  // appended. Its already-observed threshold choice can still be tested forward;
  // never reuse those historical PnL figures as monitoring evidence.
  if(!binding||!c||c.schemaVersion!==2||c.scope!=='temporal_threshold_holdout'||!['valid','insufficient','unavailable'].includes(c.status)||c.candidateSha256!==binding.sha256||c.candidate!==binding.path||c.calibration?.selectedMode!=='gate'||c.calibration?.selectedThreshold!==c.selectedThreshold||![.5,.65,.8].includes(c.selectedThreshold)||!Number.isSafeInteger(c.evaluatedAt)||c.evaluatedAt>nowMs)return {status:'unavailable',reason:'No hay selección de umbral de candidato identificada y compatible'};
  const calibration=c.calibration;
  const validMetrics=(m:any)=>m&&Number.isInteger(m.n)&&m.n>=0&&Number.isFinite(m.pnlR);
  if(!validMetrics(calibration.baseline)||!Array.isArray(calibration.runs)||calibration.runs.length!==3||[.5,.65,.8].some(t=>calibration.runs.filter((r:any)=>r.threshold===t).length!==1)||calibration.runs.some((r:any)=>!validMetrics(r.metrics)||typeof r.eligible!=='boolean'||r.eligible!==(r.metrics.n>=20)))return {status:'unavailable',reason:'Selección de calibración incompleta'};
  const selected=selectCalibration(calibration.baseline,calibration.runs);
  if(!selected.selectionMade||selected.selectedMode!=='gate'||selected.selectedThreshold!==c.selectedThreshold)return {status:'unavailable',reason:'El umbral no coincide con la selección original de calibración'};
  const file=path.resolve(ROOT,binding.path),base=path.join(ROOT,'data/ml_calibration/candidates')+path.sep;
  if(!file.startsWith(base))throw new Error('Candidate archive path outside isolated candidates');
  const raw=fs.readFileSync(file);if(createHash('sha256').update(raw).digest('hex')!==binding.sha256)throw new Error('Candidate raw SHA mismatch');
  const m=JSON.parse(raw.toString()).meta;
  if(m?.ticker!==ticker||m?.threshold_calibration_protocol?.version!==1||m?.inference_profile!=='MLFilter.ts/array-trees/zero-margin/base_weights/v1')throw new Error('Candidate model/inference profile unknown');
  const recorded=new Map((m.dataset_source?.worker_provenance?.source_files??[]).map((f:any)=>[f.path,f.sha256]));
  for(const f of getCriticalSourceSnapshot())if(recorded.get(f.path)!==f.sha256)throw new Error('Candidate replay/feature source profile differs from current epoch');
  return {status:'eligible',modelPath:file,modelSha256:binding.sha256,threshold:c.selectedThreshold,availableAtMs:m.available_at_ms,trainEndMs:m.train_end_ms,selectionAtMs:c.evaluatedAt,selectionIdentity:sha(stableCanonical({candidateSha256:binding.sha256,threshold:c.selectedThreshold,evaluatedAt:c.evaluatedAt,calibration:c.calibration})),strategyFingerprint:sha(stableCanonical(strategyConfig(m.config)))};
 }catch(e:any){return {status:'unavailable',reason:e.message};}
}
for(const doc of configs.docs){
 if(!/^[A-Z0-9]{1,24}$/.test(doc.id)||doc.id==='GLOBAL')continue;
 const ticker=doc.id,raw=plain(doc.data()),gateEnabled=raw.mlGateEnabled===true;
 const ref=pointers.get(ticker),row:any={ticker,gateEnabled,trade:raw.enabled===true&&!String(raw.disabledReason??'').trim(),deployment:raw.mlGateDeployment??null,ref:ref?plain(ref):null,modelPath:path.join(ROOT,'scripts/hyperopt/models',`ml_model_${ticker}.json`),dataDir:path.join(ROOT,'logs',ticker.toLowerCase(),'history_exported')};
 try{row.configFingerprint=configFingerprint(raw);}catch(e:any){row.snapshotError=`Current config: ${e.message}`;}
 if(gateEnabled&&typeof ref?.activationId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(ref.activationId)){
  const record=await db.doc(`ml_gate_activations/${ref.activationId}`).get();
  if(record.exists){const a=record.data()!;row.activation=plain(a);row.activation.requestedAtMs=typeof a.requestedAt?.toMillis==='function'?a.requestedAt.toMillis():null;
   try{row.activation.snapshotFingerprint=configFingerprint(a.configSnapshot);row.config=strategyConfig(strategy(mapAssetConfig(ticker,plain(a.configSnapshot))));row.strategyFingerprint=sha(stableCanonical(row.config));}catch(e:any){row.snapshotError=`Activation config: ${e.message}`;}
  }
 }
 if(gateEnabled&&row.trade)row.candidate=candidateFor(ticker);
 if(gateEnabled&&row.trade){try{const logs=loadSelectionLogs({ticker,logsDir:row.dataDir});const entries=await prepareEntries(logs);const last=entries.reduce((last,e)=>Number.isSafeInteger(e.ts)&&e.ts<=nowMs?Math.max(last,e.ts):last,-1);row.dataAvailableToMs=last<0?null:Math.min(nowMs,last+1);row.dataTfCount=logs.size;}catch(e:any){row.dataError=e.message;}}
 assets[ticker]=row;
}
for(const ticker of roster.data()?.tickers??[]){
 if(typeof ticker==='string'&&/^[A-Z0-9]{1,24}$/.test(ticker)&&!assets[ticker])assets[ticker]={ticker,gateEnabled:false,trade:false,hasConfig:false,ref:null,deployment:null};
}
// Use the replay engine's own fingerprint, not an independent approximation.
const engineFingerprint=await getCriticalSourceFingerprint();
if(typeof engineFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(engineFingerprint))throw new Error('Invalid monitor engine fingerprint');
await new Promise<void>((resolve,reject)=>process.stdout.write(JSON.stringify({schemaVersion:1,nowMs,engineFingerprint,assets}),e=>e?reject(e):resolve()));
process.exit(0);
