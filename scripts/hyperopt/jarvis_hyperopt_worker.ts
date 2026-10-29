/**
 * JARVIS Hyperopt Worker — JSON-RPC sobre stdin/stdout
 *
 * Recibe peticiones de Optuna (Python) por stdin, ejecuta runBacktest() de
 * jarvis-os/src/services/backtestEngine.ts y devuelve las métricas por stdout.
 *
 * Protocolo (una línea JSON por mensaje, NDJSON):
 *   IN  → {"id": <int>, "method": "evaluate", "params": {<BacktestConfig>}}
 *   OUT ← {"id": <int>, "result": {"metrics": {...}, "objective": <float>, "trades": <int>}}
 *   ERR ← {"id": <int>, "error": "<msg>"}
 *
 * Logging (stderr) separado del canal para no contaminar la RPC.
 *
 * IMPORTANTE: Las líneas de log se almacenan como strings crudos, no como
 * LogEntry objects. Así runBacktest → prepareEntries → preParseAlert
 * genera el campo 'parsed' correctamente (requisito de processAlert).
 */

import { runBacktest, prepareEntries } from '../../jarvis-os/src/services/backtestEngine.js';
import type { BacktestConfig, BacktestTrade } from '../../jarvis-os/src/services/backtestTypes.js';
import {planReplayWindow} from '../../jarvis-os/src/services/replayWindow.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadModelFromJSON, setMLGateOverride } from '../../src/engine/MLFilter.js';
import { loadEvaluationManifest, generateManifest, filterWindow, windowBounds,
  configFingerprint, stableCanonical, modelAvailability, partitionTrades, readOnlyReplayConfig } from './evaluation_protocol.js';
import type { EvaluationManifest, Partition } from './evaluation_protocol.js';

// -----------------------------------------------------------------------------
// 🛡️ ML-GATE en trials (F7, 10-sep-2026): el hyperopt dominical corría SIN el filtro
// ML (solo el Auto-Tune del panel lo tenía) → el optimizador proponía en un mundo sin
// ML mientras eval_production medía la producción CON gate (prop↔prod no 1:1).
// Acá se inyecta el gate walk-forward idéntico al runner (trainedAt = mtime del modelo:
// el modelo de la semana pasada evalúa la semana nueva, jamás su propio train).
// Per-ticker con fallback al genérico (igual que el vivo: DEFAULT_KEY). Si el config ya
// trae mlGate (override de experimentos), se respeta.
// -----------------------------------------------------------------------------
// Historical replay trusts explicit metadata, never filesystem mtime.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODELS_DIR = path.join(REPO_ROOT, 'scripts/hyperopt/models');
type FileHash = {path: string; sha256: string};
let state: any = null;
let loadedDatasetFiles: FileHash[] = [];

function fileHash(file: string): FileHash {
  const absolute = path.resolve(file);
  return {path:absolute, sha256:createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')};
}

function sourceHashes(): FileHash[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const file = path.join(dir,entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) files.push(file);
    }
  };
  visit(path.join(REPO_ROOT,'src'));
  // Conservative superset of the import graph, including re-export/alias wrappers
  // and every transitive source under both source roots (not just services).
  visit(path.join(REPO_ROOT,'jarvis-os/src'));
  for (const dir of ['scripts/hyperopt','scripts/periodic_opt']) {
    const root=path.join(REPO_ROOT,dir);
    if(fs.existsSync(root))for(const entry of fs.readdirSync(root))
      if(/\.(?:py|ts)$/.test(entry))files.push(path.join(root,entry));
  }
  for(const name of ['per_trigger_tune.ts','killswitch_tune.ts','directional_mcl_tune.ts',
    'bias_confluence_tune.ts','train_ml_model.py']) {
    const file=path.join(REPO_ROOT,'scripts',name);if(fs.existsSync(file))files.push(file);
  }
  for (const file of ['package.json','package-lock.json','tsconfig.json',
    'jarvis-os/package.json','jarvis-os/package-lock.json','jarvis-os/tsconfig.json',
    'jarvis-os/tsconfig.app.json','jarvis-os/tsconfig.node.json',
    'scripts/hyperopt/jarvis_hyperopt_worker.ts','scripts/hyperopt/evaluation_protocol.ts',
    'scripts/hyperopt/evaluation_protocol.py','scripts/hyperopt/hyperopt_server.py',
    'scripts/hyperopt/metrics.py','scripts/hyperopt/objective_adapter.py',
    'scripts/periodic_opt/dsr.py']) {
    if (fs.existsSync(path.join(REPO_ROOT,file))) files.push(path.join(REPO_ROOT,file));
  }
  return [...new Set(files)].sort().map(fileHash);
}

function defaultModel(ticker: string): string | null {
  const files = [`ml_model_${ticker}.json`, 'ml_model.json'].map(f => path.join(MODELS_DIR,f));
  return files.find(f => fs.existsSync(f)) ?? null;
}

function resolveConfig(input: any): {config:any; ml:any; model:FileHash|null; cache:FileHash|null} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('config must be an object');
  stableCanonical(input); // reject NaN/undefined and other non-JSON values before cloning
  const config = readOnlyReplayConfig(input);
  if (config.ticker !== state.ticker) throw new Error('config ticker mismatch');
  for (const key of ['minBuyPoints','minSellPoints','oteEntryPercent']) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < 0)
      throw new Error(`invalid config ${key}`);
  }
  if (!['SMART','BOTH','CHOCH','OTE'].includes(config.entryTrigger)) throw new Error('invalid entryTrigger');
  const gate = config.mlGate;
  if (gate != null && (typeof gate !== 'object' || Array.isArray(gate) ||
      (gate.enabled !== undefined && typeof gate.enabled !== 'boolean'))) throw new Error('invalid mlGate');
  let modelPath = gate?.modelPath ?? state.modelPath;
  if (modelPath !== null && (typeof modelPath !== 'string' || !modelPath)) throw new Error('invalid modelPath');
  modelPath = modelPath ? path.resolve(modelPath) : null;
  const model = modelPath ? fileHash(modelPath) : null;
  const availability = modelPath ? modelAvailability(JSON.parse(fs.readFileSync(modelPath,'utf8'))) : modelAvailability(null);
  if (config.mlGateEnabled !== undefined && typeof config.mlGateEnabled !== 'boolean')
    throw new Error('invalid mlGateEnabled permission');
  const permitted = config.mlGateEnabled === true; // identical to live asset_configs semantics
  if (gate?.enabled === true && !permitted)
    throw new Error('explicit enabled mlGate requires mlGateEnabled permission');
  const enabled = permitted && gate?.enabled !== false && availability.status === 'verified';
  const trainedAt = availability.available_at_ms;
  if (gate?.enabled && availability.status !== 'verified') throw new Error('explicit enabled mlGate has unknown temporal metadata');
  if (gate?.trainedAt !== undefined && gate.trainedAt !== trainedAt) throw new Error('mlGate trainedAt does not match model metadata');
  config.mlGate = enabled ? {enabled:true, modelPath, trainedAt} : {enabled:false};
  const ml = {...availability, enabled, model_path:modelPath,
    reason:gate?.enabled === false ? 'explicit_off' : !permitted ? 'live_permission_off' : enabled ? 'metadata_verified' : 'unknown_metadata'};
  const tfm = config.timesfm;
  if (tfm != null && (typeof tfm !== 'object' || Array.isArray(tfm) ||
      (tfm.enabled !== undefined && typeof tfm.enabled !== 'boolean'))) throw new Error('invalid timesfm');
  if (tfm?.enabled && !tfm.cachePath) throw new Error('enabled timesfm requires cachePath');
  const cache = tfm?.cachePath ? fileHash(tfm.cachePath) : state.cacheHash;
  if (tfm?.cachePath) config.timesfm.cachePath = cache!.path;
  return {config,ml,model,cache};
}

function evaluationContext(resolved: ReturnType<typeof resolveConfig>): any {
  // A changed snapshot must fail closed rather than mix cached data/model with new hashes.
  const currentSources = sourceHashes();
  if (configFingerprint(currentSources) !== configFingerprint(state.provenance.source_files))
    throw new Error('source snapshot changed after init; reinitialize worker');
  for (const f of [...state.provenance.dataset_files, ...state.provenance.model_files, ...state.provenance.cache_files,
    ...state.provenance.manifest_files]) {
    if (fileHash(f.path).sha256 !== f.sha256) throw new Error(`snapshot changed after init: ${f.path}`);
  }
  const modelFiles = resolved.model ? [resolved.model] : [];
  const cacheFiles = resolved.cache ? [resolved.cache] : [];
  const provenance = {...state.provenance, model_files:modelFiles, cache_files:cacheFiles};
  return {evaluation_fingerprint:configFingerprint(provenance), provenance,
    evaluation_manifest:state.manifest, config_fingerprint:configFingerprint(resolved.config),
    effective_config:resolved.config, ml_provenance:resolved.ml};
}

// -----------------------------------------------------------------------------
// JSON-RPC helpers
// -----------------------------------------------------------------------------
interface RpcRequest { id: number; method: string; params?: any; }
interface RpcResponse { id: number; result?: any; error?: string; }

function send(msg: RpcResponse): void {
  // Optional engine fields may be undefined (JSON omits them); numeric unknowns
  // must never become null or an invented zero. Build the entire line atomically.
  const line=JSON.stringify(msg,(_key,value)=>{
    if(typeof value==='number'&&!Number.isFinite(value))throw new Error('ProtocolError: non-finite RPC number');
    return value;
  });
  process.stdout.write(line + '\n');
}

function log(msg: string): void {
  process.stderr.write(`[hyperopt-worker] ${msg}\n`);
}

// -----------------------------------------------------------------------------
// Log loading — devuelve strings crudos (prepareEntries los parsea)
// -----------------------------------------------------------------------------
function loadLogsFromDir(ticker: string, baseDir: string): Map<string, string[]> {
  const logs = new Map<string, string[]>();
  const tfToFile: Record<string, string[]> = {
    '5':   ['pine-logs-SMC Master_M5.csv', 'history_M5.csv', 'M5.csv'],
    '15':  ['pine-logs-SMC Master_M15.csv', 'history_M15.csv', 'M15.csv'],
    '60':  ['pine-logs-SMC Master_H1.csv', 'history_H1.csv', 'H1.csv'],
    '240': ['pine-logs-SMC Master_H4.csv', 'history_H4.csv', 'H4.csv'],
    'D':   ['pine-logs-SMC Master_D1.csv', 'history_D1.csv', 'D1.csv'],
  };

  for (const [tfKey, candidates] of Object.entries(tfToFile)) {
    for (const fname of candidates) {
      const fpath = path.join(baseDir, fname);
      if (!fs.existsSync(fpath)) continue;
      try {
        const raw = fs.readFileSync(fpath, 'utf8');
        loadedDatasetFiles.push({path:path.resolve(fpath),sha256:createHash('sha256').update(raw).digest('hex')});
        const lines = raw.split(/\r?\n/);
        let headerIdx = -1;
        let isCsvExport = false;

        for (let i = 0; i < Math.min(5, lines.length); i++) {
          if (lines[i].startsWith('Fecha,') || lines[i].startsWith('"Fecha"')) {
            headerIdx = i;
            isCsvExport = true;
            break;
          }
        }

        const entries: string[] = [];
        for (let i = headerIdx + 1; i < lines.length; i++) {
          const rawLine = lines[i].trim();
          if (!rawLine) continue;

          let logLine: string;
          if (isCsvExport) {
            // Formato: 2026-...-03:00,"HEARTBEAT | TF: 15 | ... TS: 176..."
            const match = rawLine.match(/^"[^"]*","(.*)"$/);
            if (match) {
              logLine = match[1].trim();
            } else {
              const parts = rawLine.split(/,(.+)/);
              if (parts.length >= 2) {
                logLine = parts[1].trim().replace(/^"|"$/g, '');
              } else {
                continue;
              }
            }
          } else {
            logLine = rawLine;
          }

          // Requiere TS timestamp
          if (!logLine.includes(' | TS: ')) continue;
          const tsMatch = logLine.match(/TS:\s*(\d+)/i);
          if (!tsMatch) continue;

          // Guardar como string crudo → prepareEntries hará preParseAlert
          entries.push(logLine);
        }

        logs.set(tfKey, entries);
        log(`TF ${tfKey} ← ${fname} → ${entries.length} lines`);
        break; // primera coincidencia gana
      } catch (e: any) {
        throw new Error(`ERROR ${fpath}: ${e.message}`);
      }
    }
  }
  return logs;
}

// -----------------------------------------------------------------------------
// Compatibility values for TS consumers. Python metrics.py is Optuna's
// authority; objective_adapter.py checks these legacy values before selection.
// -----------------------------------------------------------------------------
interface Metrics {
  trade_count: number; wins: number; losses: number;
  win_rate: number; gross_profit_r: number; gross_loss_r: number;
  net_pnl_r: number; profit_factor: number;
  profit_factor_capped?: number; // 🛡️ sep-2026 opción 5: PF honesto (cap 5 + piso gross_loss 5R)
  expectancy: number;
  max_drawdown_r: number; sharpe_simple: number; avg_trade_r: number;
  max_consec_losses: number; max_consec_wins: number;
}

function computeMetrics(trades: BacktestTrade[]): Metrics {
  let wins = 0, losses = 0;
  let grossProfit = 0, grossLoss = 0;
  let mcLosses = 0, mcWins = 0, curLosses = 0, curWins = 0;
  let equity = 0, peak = 0, maxDD = 0;
  const rList: number[] = [];

  for (const t of trades) {
    const r = t.rMultiple;
    if (r === undefined || r === null) continue;
    if (!Number.isFinite(r)) throw new Error('non-finite realized R');
    rList.push(r);
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    if (r > 0) {
      wins++; grossProfit += r;
      curWins++; curLosses = 0;
      if (curWins > mcWins) mcWins = curWins;
    } else if (r < 0) {
      losses++; grossLoss += -r;
      curLosses++; curWins = 0;
      if (curLosses > mcLosses) mcLosses = curLosses;
    }
  }

  const n = rList.length;
  if (n === 0) {
    return { trade_count: 0, wins: 0, losses: 0, win_rate: 0, gross_profit_r: 0,
             gross_loss_r: 0, net_pnl_r: 0, profit_factor: 0, expectancy: 0,
             max_drawdown_r: 0, sharpe_simple: 0, avg_trade_r: 0,
             max_consec_losses: 0, max_consec_wins: 0 };
  }
  const net = grossProfit - grossLoss;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? grossProfit : 0);
  const exp = net / n;
  const wr = wins / n;
  let sharpe = 0;
  if (n > 1) {
    const mean = net / n;
    const variance = rList.reduce((acc, r) => acc + (r - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(n) : 0;
  }
  return { trade_count: n, wins, losses, win_rate: wr, gross_profit_r: grossProfit,
           gross_loss_r: grossLoss, net_pnl_r: net, profit_factor: pf,
           // 🛡️ sep-2026 (opción 5): PF honesto para el reporte (cap 5 + piso de pérdida
           // bruta 5R) — el crudo se conserva para transparencia.
           profit_factor_capped: Math.min(pf, 5.0) * Math.min(1.0, grossLoss / 5.0),
           expectancy: exp, max_drawdown_r: maxDD, sharpe_simple: sharpe,
           avg_trade_r: net / n, max_consec_losses: mcLosses, max_consec_wins: mcWins };
}

function objectiveFunction(m: Metrics, minTrades=30, ddPenalty=0.5, samplePenalty=0.25, targetTrades=200): number {
  if (m.trade_count < minTrades) {
    if (m.trade_count === 0) return -100.0;
    return -10.0 * (1.0 - m.trade_count / minTrades);
  }
  // 🔧 FIX: cap PF para no premiar configs degeneradas (gross_loss≈0 → PF→∞)
  // 🛡️ sep-2026 (opción 5): piso de pérdida bruta — si gross_loss < 5R el PF está
  // inflado por pocas pérdidas; se degrada gradualmente (mismo criterio que metrics.py).
  const pfCapped = Math.min(m.profit_factor, 5.0) * Math.min(1.0, m.gross_loss_r / 5.0);
  const tradeDev = Math.abs(m.trade_count - targetTrades) / targetTrades;
  // 🔧 FIX: pesos rebalanceados — antes -2·DD dominaba y de facto minimizaba drawdown
  return 0.5 * pfCapped - ddPenalty * m.max_drawdown_r - samplePenalty * tradeDev + 1.0 * m.expectancy;
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------
function closedMetricRecords(trades: any[]): any[] {
  return trades.filter(t => t.label_status === 'closed').map(t => {
    if (!Number.isFinite(t.rMultiple) || !Number.isFinite(t.closeTs)
        || !Number.isFinite(t.timestamp) || t.closeTs < t.timestamp) {
      throw new Error('ProtocolError: invalid confirmed metric record');
    }
    return {timestamp:t.timestamp, closeTimestamp:t.closeTs,
      rMultiple:t.rMultiple, label_status:'closed'};
  }).sort((a,b) => a.closeTimestamp-b.closeTimestamp || a.timestamp-b.timestamp);
}

async function handleInit(params: any): Promise<any> {
  state = null; // an invalid re-init cannot leave an old dataset available
  loadedDatasetFiles = [];
  const ticker = params.ticker;
  const logDir = params.log_dir;
  if (typeof ticker !== 'string' || !/^[A-Z0-9]+$/.test(ticker) || typeof logDir !== 'string' || !logDir)
    throw new Error('init requires exact uppercase ticker and log_dir');
  const manifest = params.evaluation_manifest == null ? null : loadEvaluationManifest(params.evaluation_manifest,ticker);
  const logs = loadLogsFromDir(ticker,logDir);
  const prepared = await prepareEntries(logs);
  if (!prepared.length) throw new Error(`No timestamped events for ${ticker} in ${logDir}`);
  const m5Prices=prepared.filter(e=>e.parsed?.eventTf==='5'&&e.parsed?.prefix==='PING_PRICE')
    .map(e=>e.ts).filter(Number.isSafeInteger).sort((a,b)=>a-b);
  const m5_coverage=m5Prices.length?{from_ms:m5Prices[0],to_ms:m5Prices.at(-1)!+1,
    price_observations:new Set(m5Prices).size,
    coverage_status:'observed_price_range_not_exchange_calendar_certification'}:null;
  let wfaPlan:any=null;
  if(params.wfa_plan!=null){
    if(manifest)throw new Error('WFA and v1 manifests are separate protocols');
    const {validateWfaPlan}=await import('./wfa_window.js');
    wfaPlan=validateWfaPlan(params.wfa_plan,ticker);
    if(!m5_coverage||wfaPlan.coverage.m5_start_ms!==m5_coverage.from_ms||wfaPlan.coverage.m5_end_ms!==m5_coverage.to_ms)
      throw new Error('WFA plan M5 coverage mismatch');
  }
  const m = manifest ?? generateManifest(ticker,prepared[0].ts,prepared[prepared.length-1].ts+1);
  const windows = Object.fromEntries(['train','validation','test'].map(p => [p,filterWindow(prepared,m,p as Partition)]));
  const modelPath = defaultModel(ticker);
  const cacheHash = params.timesfm_cache ? fileHash(params.timesfm_cache) : null;
  const provenance = {version:1, evaluation_manifest:m, manifest_fingerprint:configFingerprint(m),
    manifest_files:typeof params.evaluation_manifest === 'string' ? [fileHash(params.evaluation_manifest)] : [],
    dataset_files:loadedDatasetFiles, source_files:sourceHashes(),
    model_files:modelPath ? [fileHash(modelPath)] : [], cache_files:cacheHash ? [cacheHash] : [],
    protocol:'half-open-isolated-windows-terminal-close-censored-v1'};
  if(wfaPlan)Object.assign(provenance,{wfa_plan:wfaPlan,plan_fingerprint:wfaPlan.fingerprint,
    protocol:'wfa-context-only-reset-execution-v1',objective_schema:'legacy_v1-inner_train-risk_v2-shadow'});
  state = {ticker,logs,prepared,manifest:m,windows,modelPath,cacheHash,provenance,wfaPlan};
  log(`Train=${windows.train.length} Validation=${windows.validation.length} Test=${windows.test.length}; test_independence=${m.test_independence}`);
  return {ticker, logs_loaded:Object.fromEntries([...logs].map(([k,v]) => [k,v.length])),
    total_events:prepared.length, oos_split:Object.fromEntries(Object.entries(windows).map(([k,v]:any) => [k,v.length])),
    evaluation_manifest:m, evaluation_fingerprint:configFingerprint(provenance), provenance,
    ml_provenance:modelPath ? {...modelAvailability(JSON.parse(fs.readFileSync(modelPath,'utf8'))),model_path:modelPath} : {status:'unknown',model_path:null},
    m5_coverage,...(wfaPlan?{wfa_plan:wfaPlan,plan_fingerprint:wfaPlan.fingerprint}:{} )};
}

function reconstruction(descriptor:any,plan:any,fold:any,role:string):any {
  if(role!=='outer_oos')throw new Error('replay_model restricted to outer_oos');
  if(!descriptor||Object.keys(descriptor).sort().join(',')!==['version','kind','fold_id','fit_asof_ms','plan_fingerprint','model_path','model_sha256'].sort().join(',')||
    descriptor.version!==1||descriptor.kind!=='historical_reconstruction'||descriptor.fold_id!==fold.id||
    descriptor.fit_asof_ms!==fold.is_end_ms||descriptor.plan_fingerprint!==plan.fingerprint||
    typeof descriptor.model_sha256!=='string'||!/^[a-f0-9]{64}$/.test(descriptor.model_sha256)||
    typeof descriptor.model_path!=='string'||!path.isAbsolute(descriptor.model_path))throw new Error('invalid replay_model identity/hash');
  const hash=fileHash(descriptor.model_path);
  if(hash.sha256!==descriptor.model_sha256)throw new Error('replay_model bytes hash mismatch');
  const model=JSON.parse(fs.readFileSync(hash.path,'utf8')),meta=model.meta,r=meta?.wfa_reconstruction;
  const available=modelAvailability(model);
  if(!r||r.version!==1||r.fold_id!==fold.id||r.fit_asof_ms!==fold.is_end_ms||r.plan_fingerprint!==plan.fingerprint||
    !Number.isSafeInteger(r.train_label_end_ms)||r.train_label_end_ms<fold.is_start_ms||r.train_label_end_ms>=fold.inner_train_end_ms||
    !Number.isSafeInteger(r.selection_label_end_ms)||r.selection_label_end_ms<fold.inner_validation_start_ms||r.selection_label_end_ms>=fold.is_end_ms||
    meta.ticker!==plan.ticker||meta.train_end_ms!==fold.inner_train_end_ms||available.status!=='verified'||
    !Number.isSafeInteger(meta.trained_at_ms)||meta.trained_at_ms<fold.is_end_ms||meta.trained_at_ms>available.available_at_ms!||
    typeof meta.trained_at!=='string'||Date.parse(meta.trained_at)!==meta.trained_at_ms)
    throw new Error('invalid reconstruction metadata/asof/label cutoffs');
  return {hash,available,reconstruction:r};
}

async function handleEvaluateWindow(params:any):Promise<any>{
  if(!state?.wfaPlan)throw new Error('WFA init required');
  const {validateWfaPlan,foldWindow}=await import('./wfa_window.js');
  const plan=validateWfaPlan(params.plan,state.ticker);
  if(plan.fingerprint!==state.wfaPlan.fingerprint)throw new Error('WFA plan differs from init');
  const {from_ms,to_ms,fold}=foldWindow(plan,params.fold_id,params.role); // Vault rejected before model or replay.
  const descriptor=params.replay_model??null;
  const rebuilt=descriptor?reconstruction(descriptor,plan,fold,params.role):null;
  const input=JSON.parse(JSON.stringify(params.config));
  if(rebuilt){
    if(input.mlGate?.modelPath&&path.resolve(input.mlGate.modelPath)!==rebuilt.hash.path)throw new Error('conflicting replay_model path');
    input.mlGate={...(input.mlGate??{}),modelPath:rebuilt.hash.path};delete input.mlGate.trainedAt;
  }
  const resolved=resolveConfig(input);
  if(rebuilt){
    resolved.ml={...resolved.ml,...rebuilt.available,reconstruction:rebuilt.reconstruction,
      replay_model:descriptor,temporal_mode:'historical_reconstruction',simulated_asof_ms:fold.is_end_ms};
    if(resolved.config.mlGate.enabled)resolved.config.mlGate.trainedAt=fold.is_end_ms;
  }
  const context=evaluationContext(resolved);
  context.provenance={...context.provenance,wfa_window:{fold_id:fold.id,role:params.role,from_ms,to_ms},replay_model:descriptor};
  context.evaluation_fingerprint=configFingerprint(context.provenance);
  const replay_options=planReplayWindow(state.prepared,from_ms,to_ms,
    {warmupDays:plan.policy.warmup_days,minContextObservations:plan.policy.min_context_observations});
  const gate=resolved.config.mlGate;
  setMLGateOverride(state.ticker,!!gate.enabled);
  if(gate.enabled&&!loadModelFromJSON(fs.readFileSync(gate.modelPath,'utf8'),state.ticker))throw new Error('ML model cannot be loaded');
  const result=runBacktest(state.logs,JSON.parse(JSON.stringify(resolved.config)),undefined,state.prepared,replay_options);
  const entries=state.prepared.filter((e:any)=>e.ts>=from_ms&&e.ts<to_ms);
  const partitioned=partitionTrades(result.trades,{from_ms,train_end_ms:to_ms} as EvaluationManifest,'train',entries.at(-1)?.ts??-1);
  const closed=partitioned.filter(t=>t.label_status==='closed').sort((a,b)=>a.closeTimestamp-b.closeTimestamp||a.timestamp-b.timestamp);
  const metrics=computeMetrics(closed);
  const ready=result.replayDiagnostics?.readiness.ready===true;
  return {...context,kind:'wfa_window_v1',wfa_plan:plan,plan_fingerprint:plan.fingerprint,
    fold_id:fold.id,role:params.role,window:{from_ms,to_ms},status:ready?'OK':'HOLD_CONTEXT',
    replay_options,replayDiagnostics:result.replayDiagnostics,trade_records_version:1,
    closed_trades:closed,returns:closed.map(t=>t.rMultiple),metrics,
    selection_objective:ready&&params.role==='inner_train'?objectiveFunction(metrics):null,
    objective_version:'legacy_v1',shadow_consumed_by_sampler:false,apply_eligible:false};
}

function replay(config: any, partition: Partition): any {
  const entries = state.windows[partition];
  const gate = config.mlGate;
  // The shared AlphaModel retains models between trials; explicitly control its
  // override so an OFF candidate never inherits the previous candidate's ML gate.
  setMLGateOverride(state.ticker, !!gate.enabled);
  if (gate.enabled && !loadModelFromJSON(fs.readFileSync(gate.modelPath,'utf8'),state.ticker))
    throw new Error('ML model cannot be loaded; refusing a silently different candidate');
  const result = runBacktest(state.logs,JSON.parse(JSON.stringify(config)),undefined,entries);
  const trades = partitionTrades(result.trades,state.manifest,partition,entries.at(-1)?.ts ?? -1);
  const closed = closedMetricRecords(trades);
  return {result,trades,closed,metrics:computeMetrics(closed),r:closed.map(t => t.rMultiple)};
}

async function handleCollectTrades(params: any): Promise<any> {
  if (!state) throw new Error('Worker no inicializado. Llamar method=init primero.');
  if(state.wfaPlan)throw new Error('WFA sessions only permit evaluate_window');
  const partition: Partition = params.partition ?? 'train';
  if (partition === 'test') throw new Error('Test is only available through evaluate_final');
  const [start,end] = windowBounds(state.manifest,partition);
  const resolved = resolveConfig(params.config);
  const context = evaluationContext(resolved);
  const replayed = replay(resolved.config,partition);
  return {...context, trades:replayed.trades, trade_count:replayed.trades.length,
    closed_trade_count:replayed.metrics.trade_count,
    start_date:replayed.result.startDate, end_date:replayed.result.endDate,
    dataset_meta:{partition,from_ms:start,to_ms:end,events:state.windows[partition].length,
      terminal_close_policy:'censored',evaluation_manifest:state.manifest,
      evaluation_fingerprint:context.evaluation_fingerprint, dataset_files:context.provenance.dataset_files}};
}

async function handleEvaluate(params: any, final = false): Promise<any> {
  if (!state) throw new Error('Worker no inicializado. Llamar method=init primero.');
  if(state.wfaPlan)throw new Error('WFA sessions only permit evaluate_window; Vault blocked');
  const resolved = resolveConfig(params.config);
  const context = evaluationContext(resolved);
  const train = replay(resolved.config,'train');
  const validation = replay(resolved.config,'validation');
  const result:any = {...context, metrics:train.metrics, metrics_train:train.metrics,
    metrics_validation:validation.metrics, metrics_oos:validation.metrics,
    objective:objectiveFunction(train.metrics), objective_authority:'legacy_compatibility_ts',
    trade_records_version:1, train_trades:train.closed, validation_trades:validation.closed,
    trade_count:train.metrics.trade_count,
    start_date:train.result.startDate,end_date:train.result.endDate,
    validation_r:validation.r, oos_r:validation.r};
  if (final) {
    const test = replay(resolved.config,'test');
    result.metrics_test = test.metrics;
    result.test_trades = test.closed;
    result.test_r = test.r;
    result.test_evidence = {partition:'test', config_fingerprint:context.config_fingerprint,
      evaluation_fingerprint:context.evaluation_fingerprint,
      metrics_fingerprint:configFingerprint(test.metrics),
      test_independence:state.manifest.test_independence};
  }
  return result;
}

// -----------------------------------------------------------------------------
// Main loop
// -----------------------------------------------------------------------------
async function main() {
  // 🛡️ F7 (10-sep-2026): el engine y el AlphaModel compartido spammean console.log
  // ([ML] por cada touch de zona, BIAS-DERIVE, etc.) → contaminaba stdout, que ES el
  // canal RPC NDJSON. Configs con muchos legs OTE generaban decenas de miles de líneas
  // y podían saturar el lector del servidor (timeout de 180s por trial). El worker
  // loguea por stderr vía log(); el RPC sale por process.stdout.write directo.
  console.log = () => {};
  log('worker started, waiting for RPC...');
  let buf = '';
  let queue: Promise<void> = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      queue = queue.then(() => handleRpc(line));
    }
  });
  process.stdin.on('end', () => { queue.finally(() => { log('stdin closed'); process.exit(0); }); });
}

async function handleRpc(line: string): Promise<void> {
  let req: RpcRequest;
  try { req = JSON.parse(line); }
  catch (e: any) { send({ id: -1, error: `JSON parse: ${e.message}` }); return; }
  try {
    let result: any;
    switch (req.method) {
      case 'init':     result = await handleInit(req.params || {}); break;
      case 'evaluate': result = await handleEvaluate(req.params || {}); break;
      case 'evaluate_final': result = await handleEvaluate(req.params || {}, true); break;
      case 'evaluate_window': result = await handleEvaluateWindow(req.params || {}); break;
      case 'collect_trades': result = await handleCollectTrades(req.params || {}); break;
      case 'ping':     result = { pong: true, ts: Date.now() }; break;
      case 'shutdown': send({ id: req.id, result: { ok: true } }); log('shutdown'); process.exit(0); return;
      default: throw new Error(`Unknown method: ${req.method}`);
    }
    send({ id: req.id, result });
  } catch (e: any) { send({ id: req.id, error: e.message || String(e) }); }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
