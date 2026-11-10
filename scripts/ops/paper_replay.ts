/** Forward paper evidence only. No Firebase, broker, optimizer or config writes.
 * evaluate_final has isolated partitions (no warmup); evaluate_window reserves its
 * latest Vault. Use the same public SMC context-only/reset replay API instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {configFingerprint, readOnlyReplayConfig, modelAvailability} from '../hyperopt/evaluation_protocol.js';
import {planReplayWindow, contextObservationTf} from '../../jarvis-os/src/services/replayWindow.js';

export const WEEK = 604800000;
const HASH = /^[a-f0-9]{64}$/;
const TFS = ['5','15','60','240','D'];
const finiteMs = (v:any) => Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
export const isTrading = (c:any) => c?.enabled === true && !String(c?.disabledReason ?? '').trim();
export function registrationIdentity(r:any) {
  return {ticker:r.ticker, registered_at_ms:r.registered_at_ms,
    candidate_fingerprint:r.candidate_fingerprint, candidate_engine_fingerprint:r.candidate_engine_fingerprint,
    source_files:r.source_files, model_files:r.model_files, cache_files:r.cache_files};
}
export function validateRegistration(ticker:string, r:any, createdAtMs:number, now:number) {
  if (!/^[A-Z0-9]+$/.test(ticker) || r?.ticker !== ticker) throw new Error('registration_ticker_mismatch');
  if (!finiteMs(now) || !finiteMs(createdAtMs) || !finiteMs(r.registered_at_ms)) throw new Error('registration_timestamp_invalid');
  if (!['SHADOW','CERTIFIED'].includes(r.status)) throw new Error('registration_not_eligible');
  if (!r.candidate_asset_snapshot || !HASH.test(r.candidate_fingerprint) || configFingerprint(r.candidate_asset_snapshot) !== r.candidate_fingerprint)
    throw new Error('candidate_fingerprint_mismatch');
  if (!r.candidate_engine_snapshot || !HASH.test(r.candidate_engine_fingerprint) || configFingerprint(r.candidate_engine_snapshot) !== r.candidate_engine_fingerprint)
    throw new Error('frozen_engine_config_missing_or_changed');
  if (r.candidate_engine_snapshot.ticker !== ticker) throw new Error('engine_ticker_mismatch');
  for (const key of ['source_files','model_files','cache_files']) {
    if (!Array.isArray(r[key]) || (key === 'source_files' && !r[key].length)) throw new Error('registration_file_identities_missing');
    const seen = new Set();
    for (const f of r[key]) {
      if (!f || typeof f.path !== 'string' || !path.isAbsolute(f.path) || !HASH.test(f.sha256) || seen.has(f.path)) throw new Error('registration_file_identity_invalid');
      seen.add(f.path);
    }
  }
  if (configFingerprint(registrationIdentity(r)) !== r.registration_fingerprint) throw new Error('registration_fingerprint_mismatch');
  // Firestore creation time is authoritative against legacy --since backdating.
  const cutoff = Math.max(createdAtMs, r.registered_at_ms);
  if (cutoff > now) throw new Error('registration_in_future');
  return {cutoff, asset:structuredClone(r.candidate_asset_snapshot), engine:structuredClone(r.candidate_engine_snapshot)};
}
export function fileIdentity(file:string) {
  return {path:path.resolve(file), sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
}
export function verifyFiles(files:any[]) {
  for (const f of files) if (fileIdentity(f.path).sha256 !== f.sha256) throw new Error(`identity_changed: ${f.path}`);
}
export function observationWindow(entries:any[], registeredAtMs:number, now:number) {
  if (!finiteMs(registeredAtMs) || !finiteMs(now)) throw new Error('invalid_observation_clock');
  const times = entries.filter(e=>contextObservationTf(e)==='5').map(e=>e.ts).sort((a,b)=>a-b);
  if (!times.length) throw new Error('actual_M5_data_missing');
  if (times.at(-1)! > now) throw new Error('dataset_has_future_observations');
  const observedEndMs=times.at(-1)!+1;
  const to_ms=Math.min(observedEndMs, now, registeredAtMs+WEEK);
  const coverage={from_ms:times[0],to_ms:observedEndMs,status:'observed_prices_not_exchange_calendar_certification'};
  if (to_ms <= registeredAtMs) return {status:'PENDING',reason:'no_post_registration_observations',window:null,coverage};
  if (to_ms < registeredAtMs+WEEK) return {status:'PENDING',reason:'future_week_not_yet_observed',window:{from_ms:registeredAtMs,to_ms},coverage};
  if (times[0]>registeredAtMs) throw new Error('forward_window_start_not_covered');
  return {status:'OBSERVED',reason:'bounded_future_week',window:{from_ms:registeredAtMs,to_ms},coverage};
}
export function closedEvidence(ticker:string, fingerprint:string, trades:any[], window:{from_ms:number;to_ms:number}, terminal:number) {
  const unique = new Map<string,any>();
  for (const t of trades) {
    const close=t.closeTimestamp ?? t.closedAt ?? t.closeTs;
    if (!finiteMs(t.timestamp) || !finiteMs(close) || close<t.timestamp || typeof t.rMultiple !== 'number' || !Number.isFinite(t.rMultiple)) throw new Error('invalid_trade_timestamp_or_return');
    if (t.timestamp<window.from_ms || t.timestamp>=window.to_ms) throw new Error('trade_outside_forward_window');
    // Engine terminal marking is not a genuinely observed close.
    if (close>=window.to_ms || close>=terminal) continue;
    if (!['WIN','LOSS','BE','BREAKEVEN','TIMEOUT','REVERSAL'].includes(t.result)) throw new Error('unconfirmed_trade_result');
    if (!['BUY','SELL','LONG','SHORT'].includes(t.direction) || !Number.isFinite(t.entryPrice) || t.entryPrice<=0 || !Number.isFinite(t.slPrice) || t.slPrice<=0) throw new Error('trade_identity_missing');
    const identity={ticker,candidateFingerprint:fingerprint,timestamp:t.timestamp,direction:t.direction,entryPrice:t.entryPrice,slPrice:t.slPrice};
    const id=configFingerprint(identity);
    const record={...identity,id,closedAt:close,rMultiple:t.rMultiple,result:t.rMultiple>0?'WIN':t.rMultiple<0?'LOSS':'BREAKEVEN',mode:'paper',isPaper:true};
    if (unique.has(id) && configFingerprint(unique.get(id))!==configFingerprint(record)) throw new Error('conflicting_duplicate_trade');
    unique.set(id,record);
  }
  const records=[...unique.values()].sort((a,b)=>a.closedAt-b.closedAt||a.id.localeCompare(b.id));
  const n=records.length,wins=records.filter(t=>t.rMultiple>0).length,sumR=records.reduce((s,t)=>s+t.rMultiple,0);
  if (!Number.isFinite(sumR)) throw new Error('nonfinite_aggregate');
  return {trades:records,n,wins,sumR,wr:n?wins/n:0,expectancy:n?sumR/n:0};
}
export function invalidation(ticker:string, reason:string, now:number) {
  return {ticker,evidenceKind:'forward_paper_v1',temporalMode:'future_observation',status:'INVALIDATED',reason,
    generatedAt:new Date(now).toISOString(),paperReady:false,apply_eligible:false,certificationStatus:'NOT_CERTIFIED',
    invalidatesLegacyHistorical:true,legacyEvidenceKind:'historical_reconstruction',n:0,wr:0,expectancy:0,trades:[],window:null};
}
export async function replayPaper(input:{ticker:string;registration:any;createdAtMs:number;now:number;logsDir:string}) {
  const {ticker,registration:r,createdAtMs,now,logsDir}=input;
  const frozen=validateRegistration(ticker,r,createdAtMs,now);
  const base={...invalidation(ticker,'not_evaluated',now),candidateFingerprint:r.candidate_fingerprint,
    registrationFingerprint:r.registration_fingerprint,registeredAtMs:frozen.cutoff,declaredRegisteredAtMs:r.registered_at_ms,
    candidateConfigFingerprint:r.candidate_engine_fingerprint};
  verifyFiles([...r.source_files,...r.model_files,...r.cache_files]);
  // No historical forecast cache can establish that a forecast existed live in
  // this future interval. Do not backfill it or silently turn the strategy OFF.
  if (frozen.engine.timesfm?.enabled) throw new Error('forward_TimesFM_live_ledger_not_supported_no_forecast_coverage_claim');
  const config=readOnlyReplayConfig(frozen.engine);
  config.enabled=true; // simulation-local operator OFF only; never a persisted config
  delete config.disabledReason;
  if (config.mlGateEnabled===true && config.mlGate?.enabled!==false) {
    const gate=config.mlGate;
    const model=r.model_files.find((f:any)=>f.path===gate?.modelPath);
    if (!model) throw new Error('frozen_ML_model_missing');
    const meta=modelAvailability(JSON.parse(fs.readFileSync(model.path,'utf8')));
    if (meta.status!=='verified'||meta.available_at_ms!>frozen.cutoff||meta.train_end_ms!>frozen.cutoff||gate.trainedAt!==meta.available_at_ms) throw new Error('ML_temporal_identity_invalid');
  } else if (config.mlGate?.enabled===true) throw new Error('ML_permission_mismatch');
  const {RpcWorker}=await import('../periodic_opt/eval_production.js');
  const w=new RpcWorker();
  let init:any;
  try { init=await w.call('init',{ticker,log_dir:logsDir}); } finally { w.close(); }
  if (!init.provenance || configFingerprint(init.provenance)!==init.evaluation_fingerprint) throw new Error('worker_provenance_mismatch');
  const canonical=(xs:any[])=>xs.map(x=>({path:x.path,sha256:x.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
  if (configFingerprint(canonical(r.source_files))!==configFingerprint(canonical(init.provenance.source_files))) throw new Error('registered_source_set_changed');
  const {loadSelectionLogs}=await import('../periodic_opt/selection_context.js');
  const {prepareEntries,runBacktest}=await import('../../jarvis-os/src/services/backtestEngine.js');
  const {setMLGateOverride}=await import('../../src/engine/MLFilter.js');
  const dataset=['M5','M15','H1','H4','D1'].map(tf=>{
    const f=[`pine-logs-SMC Master_${tf}.csv`,`history_${tf}.csv`,`${tf}.csv`].map(n=>path.join(logsDir,n)).find(fs.existsSync);
    if (!f) throw new Error(`missing_dataset_TF_${tf}`);return fileIdentity(f);
  });
  if (configFingerprint(canonical(dataset))!==configFingerprint(canonical(init.provenance.dataset_files))) throw new Error('dataset_set_changed');
  const logs=loadSelectionLogs({ticker,logsDir});
  const entries=await prepareEntries(logs);
  verifyFiles([...dataset,...r.source_files,...r.model_files,...r.cache_files]);
  const observed=observationWindow(entries,frozen.cutoff,now);
  const identities={datasetFiles:dataset,sourceFiles:r.source_files,modelFiles:r.model_files,cacheFiles:r.cache_files};
  const replaySourceFiles=['paper_replay.ts','paper_trades.ts'].map(name=>fileIdentity(`/opt/JARVIS/scripts/ops/${name}`));
  const provenance={...identities,replaySourceFiles,datasetFingerprint:configFingerprint(dataset),sourceFingerprint:configFingerprint([...r.source_files,...replaySourceFiles]),modelFingerprint:configFingerprint(r.model_files)};
  if (observed.status==='PENDING') return {...base,...observed,...provenance};
  const window=observed.window!;
  const replayOptions=planReplayWindow(entries,window.from_ms,window.to_ms,{warmupDays:60,minContextObservations:Object.fromEntries(TFS.map(tf=>[tf,60]))});
  setMLGateOverride(ticker,config.mlGate?.enabled===true);
  const result=runBacktest(logs,structuredClone(config),undefined,entries,replayOptions);
  verifyFiles([...dataset,...r.source_files,...replaySourceFiles,...r.model_files,...r.cache_files]);
  if (result.replayDiagnostics?.readiness.ready!==true) throw new Error('full_multiTF_warmup_not_ready');
  const terminal=entries.reduce((last,e)=>e.ts>=window.from_ms&&e.ts<window.to_ms?Math.max(last,e.ts):last,-1);
  const metrics=closedEvidence(ticker,r.candidate_fingerprint,result.trades,window,terminal);
  return {...base,...observed,...provenance,...metrics,configFingerprint:configFingerprint(config),simulationConfig:config,
    simulationOverrides:{enabled:true,disabledReasonRemoved:true},replayOptions,replayDiagnostics:result.replayDiagnostics};
}
