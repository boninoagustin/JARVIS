// One production snapshot + worker-resolved final evaluation; no external writes.
// TICKER [--config-file ASSET.json] [--backtest-config-file ENGINE.json]
// --evaluation-manifest PATH [--logs-dir DIR] [--save PATH]
// --snapshot-only --snapshot-out PATH --manifest-out PATH creates the cycle contract
// and evaluates production once (required to freeze the worker's effective config).
import {spawn} from 'node:child_process';
import {readFileSync, existsSync, writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mapAssetConfig, readAssetSnapshot} from './selection_context.js';
import {configFingerprint, loadEvaluationManifest} from '../hyperopt/evaluation_protocol.js';

const REPO = '/opt/JARVIS';
function save(file: string | undefined, value: any) {
  if (!file) return;
  mkdirSync(path.dirname(path.resolve(file)), {recursive:true});
  writeFileSync(file, JSON.stringify(value, null, 2));
}
export class RpcWorker {
  proc: any; buf = ''; id = 0;
  pending = new Map<number, {resolve: (v:any)=>void; reject:(e:Error)=>void; timer:any}>();
  constructor() {
    this.proc = spawn(`${REPO}/node_modules/.bin/tsx`, [`${REPO}/scripts/hyperopt/jarvis_hyperopt_worker.ts`], {cwd:REPO, stdio:['pipe','pipe','inherit']});
    const fail = (e: Error) => {for (const p of this.pending.values()) {clearTimeout(p.timer); p.reject(e);} this.pending.clear();};
    this.proc.on('error', fail);
    this.proc.on('exit', (code:any) => fail(new Error(`worker exited ${code}`)));
    this.proc.stdout.on('data', (d:Buffer) => {
      this.buf += d.toString(); let i;
      while ((i=this.buf.indexOf('\n'))>=0) {
        const line=this.buf.slice(0,i); this.buf=this.buf.slice(i+1);
        let msg:any; try {msg=JSON.parse(line);} catch {continue;}
        const p=this.pending.get(msg.id); if (!p) continue;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        msg.error ? p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    });
  }
  call(method:string, params:any): Promise<any> {
    const id=++this.id;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`timeout ${method}`));}, 1800000);
      this.pending.set(id,{resolve,reject,timer});
      this.proc.stdin.write(JSON.stringify({id,method,params})+'\n');
    });
  }
  close() {this.proc.kill();}
}

/** Resolve against the actual RPC contract. Init fingerprints provenance, not the
 * manifest. evaluate_final can resolve gate/cache fields and adds their hashes.
 * Never infer ML availability from filesystem mtime or certify the input config.
 */
export async function resolveEvaluation(w: Pick<RpcWorker,'call'>, options:any): Promise<any> {
  const {ticker, logsDir, manifestOut, cache} = options;
  const input = JSON.parse(JSON.stringify(options.config));
  let manifestPath = options.manifestPath;
  if (manifestPath) {
    const manifest = loadEvaluationManifest(manifestPath, ticker);
    if (manifestOut) {save(manifestOut, manifest); manifestPath = path.resolve(manifestOut);}
  }
  const initParams = () => ({ticker, log_dir:logsDir,
    ...(manifestPath ? {evaluation_manifest:manifestPath} : {}),
    ...(cache ? {timesfm_cache:cache} : {})});
  let init = await w.call('init', initParams());
  if (!init.provenance || init.evaluation_fingerprint !== configFingerprint(init.provenance))
    throw new Error('worker init provenance fingerprint mismatch');
  const manifest = loadEvaluationManifest(init.evaluation_manifest,ticker);
  if (!manifestPath && manifestOut) {
    // Reinitialize BEFORE evaluating so production/hyperopt/final all hash the
    // same explicit manifest file, including its path and bytes.
    save(manifestOut, manifest); manifestPath = path.resolve(manifestOut);
    init = await w.call('init', initParams());
    if (init.evaluation_fingerprint !== configFingerprint(init.provenance) ||
        configFingerprint(init.evaluation_manifest) !== configFingerprint(manifest))
      throw new Error('worker reinit provenance/manifest fingerprint mismatch');
  }
  const result = await w.call('evaluate_final', {config:input});
  const effective = result.effective_config ?? result.config;
  if (!effective || result.config_fingerprint !== configFingerprint(effective))
    throw new Error('worker final effective config fingerprint mismatch');
  if (!result.provenance || result.evaluation_fingerprint !== configFingerprint(result.provenance) ||
      configFingerprint(result.provenance.evaluation_manifest) !== configFingerprint(manifest))
    throw new Error('worker final provenance/manifest fingerprint mismatch');
  return {...result, ticker, config:effective, evaluation_manifest:manifest, oos_split:init.oos_split};
}

export async function main(argv=process.argv.slice(2)) {
  const value = (flag: string) => {const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i+1];};
  const ticker = (argv[0] || '').toUpperCase();
  if (!ticker || ticker.startsWith('--')) throw new Error('TICKER required');
  if (argv.includes('--map-only')) {
    if (!value('--config-file')) throw new Error('--map-only requires --config-file; no live reads');
    if (argv.includes('--snapshot-only') || value('--backtest-config-file') || value('--evaluation-manifest'))
      throw new Error('--map-only cannot evaluate or resolve an evaluation manifest');
    const asset = await readAssetSnapshot({ticker,configFile:value('--config-file')});
    let mappingCache=value('--timesfm-cache');
    if (!mappingCache && asset.timesfm?.enabled) {
      const candidate=asset.timesfm.cachePath ?? `${REPO}/logs/${ticker.toLowerCase()}/forecasts/forecasts_m5.jsonl`;
      if (existsSync(candidate)) mappingCache=path.resolve(candidate);
    }
    const out = {ticker,config:mapAssetConfig(ticker,asset,mappingCache),
      production_asset_snapshot:asset,production_asset_fingerprint:configFingerprint(asset),mapping_only:true};
    save(value('--save'),out);
    console.log(JSON.stringify(out));
    return out;
  }
  if (!value('--evaluation-manifest') && !argv.includes('--snapshot-only')) throw new Error('--evaluation-manifest PATH required for final evaluation');
  if (argv.includes('--snapshot-only') && (!value('--snapshot-out') || !value('--manifest-out')))
    throw new Error('snapshot-only requires --snapshot-out and --manifest-out');
  const asset = await readAssetSnapshot({ticker, configFile:value('--config-file')});
  let cache = value('--timesfm-cache');
  if (!cache && asset.timesfm?.enabled) {
    const fallback=asset.timesfm.cachePath ?? `${REPO}/logs/${ticker.toLowerCase()}/forecasts/forecasts_m5.jsonl`;
    if (existsSync(fallback)) cache=path.resolve(fallback);
  }
  const config = value('--backtest-config-file') ? JSON.parse(readFileSync(value('--backtest-config-file')!, 'utf8')) : mapAssetConfig(ticker, asset, cache);
  // ML gate is intentionally untouched: worker trusts explicit model metadata.
  const w=new RpcWorker();
  try {
    const result=await resolveEvaluation(w, {ticker, config, logsDir:value('--logs-dir') ?? `${REPO}/logs/${ticker.toLowerCase()}/history_exported`,
      manifestPath:value('--evaluation-manifest'), manifestOut:value('--manifest-out'), cache});
    const out={...result, production_asset_snapshot:asset, production_asset_fingerprint:configFingerprint(asset)};
    save(value('--snapshot-out'), asset); save(value('--save'),out);
    console.log(JSON.stringify(out));
    return out;
  } finally {w.close();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(e=>{console.error('ERROR:', e.message); process.exitCode=1;});
