/** Shared selection boundary. All tuning receives TRAIN only, never validation/test.
 * CLI: TICKER --evaluation-manifest PATH [--config-file PATH] [--logs-dir DIR]
 *      [--save PATH] [--dry-run]. Fixtures avoid Firebase initialization entirely.
 */
import fs from 'node:fs';
import path from 'node:path';
import { filterWindow, loadEvaluationManifest, readOnlyReplayConfig, modelAvailability } from '../hyperopt/evaluation_protocol.js';
import {setMLGateOverride, loadModelFromJSON} from '../../src/engine/MLFilter.js';
import {validateReplayWindow, type ReplayWindowOptions} from '../../jarvis-os/src/services/replayWindow.js';

export function parseSelectionArgs(argv = process.argv.slice(2)): any {
  const value = (flag: string) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  const ticker = (value('--ticker') ?? argv.find(a => !a.startsWith('--')) ?? '').toUpperCase();
  const manifestPath = value('--evaluation-manifest');
  if (!manifestPath) throw new Error('--evaluation-manifest PATH is required: unbounded selection is forbidden');
  if (!ticker || ticker === 'ALL' || ticker.includes(',')) throw new Error('one ticker per evaluation manifest is required');
  return {ticker, manifestPath, configFile: value('--config-file'), backtestConfigFile: value('--backtest-config-file'), logsDir: value('--logs-dir'), save: value('--save'), dryRun: argv.includes('--dry-run'), wfaReplayFile:value('--wfa-replay-window')};
}

export function selectionReplayOptions(args:any, manifest:any):ReplayWindowOptions|undefined {
  if (!args?.wfaReplayFile) return undefined;
  if (!args.dryRun) throw new Error('WFA selection replay requires --dry-run');
  const replay=JSON.parse(fs.readFileSync(args.wfaReplayFile,'utf8'));
  validateReplayWindow(replay);
  if (replay.evaluationStartMs!==manifest.from_ms || replay.evaluationEndMs!==manifest.train_end_ms)
    throw new Error('WFA selection window must match exact Train bounds');
  return replay;
}

export function selectionEntries<T extends {ts: number}>(entries: T[], manifest: any, args?:any): T[] {
  const replay=selectionReplayOptions(args,manifest);
  if (replay) return entries.filter(e=>e.ts>=replay.warmupStartMs && e.ts<replay.evaluationEndMs);
  return filterWindow(entries, manifest, 'train') as T[];
}

export async function readAssetSnapshot(args: any): Promise<any> {
  if (args.configFile) return JSON.parse(fs.readFileSync(args.configFile, 'utf8'));
  const admin = (await import('firebase-admin')).default;
  if (admin.apps.length === 0) admin.initializeApp({credential: admin.credential.cert(JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8')))});
  return (await admin.firestore().doc(`asset_configs/${args.ticker}`).get()).data() ?? {};
}

/** Preserve all active engine fields, including explicit false/zero. Never force
 * TimesFM enabled or synthesize a separate ML gate: the worker resolves one gate.
 */
export function mapAssetConfig(ticker: string, asset: any, timesfmCache?: string): any {
  const config = {
    entryTrigger: 'SMART',
    slBufferPercent: 0.1, fixedRR: 2, oteEntryPercent: 50,
    vwapPts: 2, sessions: {}, enabled: true,
    spreadPips: 0.1, commissionPerLot: 3, tp1StructuralMinRR: 1.2,
    ...JSON.parse(JSON.stringify(asset)), ticker,
    minBuyPoints: asset.minPointsForBuy ?? asset.minBuyPoints ?? 4,
    minSellPoints: asset.minPointsForSell ?? asset.minSellPoints ?? 4,
  };
  delete config.minPointsForBuy; delete config.minPointsForSell;
  config.mlGateEnabled = asset.mlGateEnabled === true;
  if (!config.mlGateEnabled) config.mlGate = {enabled:false};  // live permission is authoritative
  // Metadata is not an engine input and must not contaminate config fingerprints.
  for (const key of ['updatedAt', 'source', 'disabledReason', 'createdAt']) delete config[key];
  if (timesfmCache && config.timesfm) config.timesfm = {...config.timesfm, cachePath: timesfmCache};
  return config;
}

/** Same filename precedence, numeric TF keys and CSV unwrapping as the worker.
 * Using this common dataset tuple prevents Train ranking a different event stream. */
export function loadSelectionLogs(args: any): Map<string, string[]> {
  const dir = args.logsDir ?? `/opt/JARVIS/logs/${args.ticker.toLowerCase()}/history_exported`;
  const logs = new Map<string,string[]>();
  for (const [tf,name] of [['5','M5'],['15','M15'],['60','H1'],['240','H4'],['D','D1']]) {
    const file = [`pine-logs-SMC Master_${name}.csv`, `history_${name}.csv`, `${name}.csv`].map(f=>path.join(dir,f)).find(f=>fs.existsSync(f));
    if (!file) continue;
    const lines = fs.readFileSync(file,'utf8').split(/\r?\n/);
    const header = lines.slice(0,5).findIndex(l=>l.startsWith('Fecha,') || l.startsWith('"Fecha"'));
    const entries:string[] = [];
    for (const line of lines.slice(header+1)) {
      let value = line.trim();
      if (!value) continue;
      if (header >= 0) {
        const match = value.match(/^"[^"]*","(.*)"$/);
        if (match) value=match[1].trim();
        else {
          const parts=value.split(/,(.+)/);
          if (parts.length<2) continue;
          value=parts[1].trim().replace(/^"|"$/g,'');
        }
      }
      if (value.includes(' | TS: ') && /TS:\s*(\d+)/i.test(value)) entries.push(value);
    }
    logs.set(tf,entries);
  }
  return logs;
}

/** Consume the same effective engine JSON as hyperopt/final, not new defaults. */
export function readSelectionConfig(args: any, asset: any): any {
  const raw = args.backtestConfigFile ? JSON.parse(fs.readFileSync(args.backtestConfigFile, 'utf8')) : mapAssetConfig(args.ticker, asset);
  const config = readOnlyReplayConfig(raw);
  if (config.ticker !== args.ticker) throw new Error('selection config ticker mismatch');
  if (config.mlGateEnabled !== undefined && typeof config.mlGateEnabled !== 'boolean')
    throw new Error('invalid ML permission');
  if (config.mlGate != null && (typeof config.mlGate !== 'object' || Array.isArray(config.mlGate) ||
      typeof config.mlGate.enabled !== 'boolean')) throw new Error('invalid ML gate');
  if (config.mlGate?.enabled === true && config.mlGateEnabled !== true)
    throw new Error('enabled ML gate requires live permission');
  setMLGateOverride(args.ticker, !!config.mlGate?.enabled);
  if (config.mlGate?.enabled) {
    const model = JSON.parse(fs.readFileSync(config.mlGate.modelPath, 'utf8'));
    const meta = modelAvailability(model);
    if (meta.status !== 'verified' || meta.available_at_ms !== config.mlGate.trainedAt ||
        !loadModelFromJSON(JSON.stringify(model), args.ticker))
      throw new Error('selection model metadata/gate mismatch');
  }
  return config;
}

/** Isolate only trading eligibility; keep the production strategy and management.
 * Explicit minScore=99 closes SMART OTE fallback for every non-selected trigger. */
export function isolateTriggerConfig(base: any, session: string, trigger: string, genome: any): any {
  const config = JSON.parse(JSON.stringify(base));
  // The replay engine reads local management directly (no ALL merge). Entry
  // eligibility uses session-or-OFF, but management does NOT use that fallback.
  const inherited = {...(config.sessions?.[session]?.[trigger] ?? {})};
  config.sessions ??= {};
  for (const s of ['OFF','LONDON','NY','ASIA','ALL']) {
    config.sessions[s] ??= {};
    for (const t of ['choch5m','bos5m','oteChoch5m','oteBos5m','choch15m','bos15m','oteChoch15m','oteBos15m'])
      config.sessions[s][t] = {...config.sessions[s][t], enabled:false, minScore:99};
  }
  config.sessions[session][trigger] = {...inherited, ...genome, enabled:true};
  if ('minimal_roi' in genome && !genome.minimal_roi) delete config.sessions[session][trigger].minimal_roi;
  config.sessionFilter = [session];
  return config;
}

/** Match the worker's conservative terminal-close censoring during Train selection. */
export function completedSelectionTrades(trades: any[], manifest: any, entries: {ts:number}[]): any[] {
  const last = entries.at(-1)?.ts ?? -1;
  return trades.filter(t => {
    const close = t.closeTimestamp ?? t.closedAt ?? t.closeTs;
    return Number.isSafeInteger(t.timestamp) && t.timestamp >= manifest.from_ms && t.timestamp < manifest.train_end_ms &&
      Number.isSafeInteger(close) && close >= t.timestamp && close < manifest.train_end_ms && close < last &&
      typeof t.rMultiple === 'number' && Number.isFinite(t.rMultiple) && ['WIN','LOSS','BE','TIMEOUT','REVERSAL'].includes(t.result);
  });
}

export function selectionManifest(args: any): any {
  return loadEvaluationManifest(args.manifestPath, args.ticker);
}

export function saveSelection(args: any, result: any): void {
  if (args.save) { fs.mkdirSync(path.dirname(path.resolve(args.save)), {recursive: true}); fs.writeFileSync(args.save, JSON.stringify(result, null, 2)); }
}
