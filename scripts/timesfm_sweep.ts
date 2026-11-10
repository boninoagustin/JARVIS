/** TimesFM contrafactual A/B: baseline (sin filtro) vs TimesFM ON (caché as-of).
 *
 * A diferencia del gate ML (que selecciona un umbral), TimesFM es A/B puro: no hay
 * selección. Se compara baseline vs candidato en la ventana cubierta por forecasts as-of.
 * Fail-closed: exige as-of verificable + cobertura + muestra ≥ MIN en AMBAS ramas.
 *
 * Sin I/O de Firestore, sin broker, sin escribir config. Sólo lectura + replay.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine.js';
import { planReplayWindow, contextObservationTf } from '../jarvis-os/src/services/replayWindow.js';
import { readOnlyReplayConfig, stableCanonical } from './hyperopt/evaluation_protocol.js';
import { mapAssetConfig, loadSelectionLogs } from './periodic_opt/selection_context.js';
import { loadTimesfmCache } from '../src/engine/TimesfmFilter.js';
import { auditTimesfmCache, readTriggerTs } from './timesfm_ab.js';
import { completedTrades, metrics } from './ml_threshold_sweep.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (value: any) => JSON.parse(JSON.stringify(value));

export const TIMESFM_MIN_SAMPLE = 30;

/** ts mínimo para evaluar: ≥60 observaciones por TF antes de él (warmup multi-TF). */
export function minEvaluationStart(entries: any[], minObs = 60): number {
  let latest = 0;
  for (const tf of ['5', '15', '60', '240', 'D']) {
    const ts = entries.filter(e => contextObservationTf(e) === tf).map(e => e.ts).sort((a, b) => a - b);
    if (ts.length < minObs) return Number.MAX_SAFE_INTEGER;
    latest = Math.max(latest, ts[minObs - 1]);
  }
  return latest;
}

export interface TmMetrics {
  n: number; wr: number; pf: number; pnlR: number; mdd: number;
}

/** Aísla TimesFM: ML apagado, correlación observando. TimesFM se controla por trial
 * (baseline off / candidate on con caché), así que la base lo deja apagado. */
export function isolateTimesfm(asset: any): any {
  const isolated = json(asset);
  if (isolated.mlGateEnabled !== undefined) isolated.mlGateEnabled = false;
  if (isolated.mlGate && typeof isolated.mlGate === 'object') isolated.mlGate = { ...isolated.mlGate, enabled: false };
  if (isolated.correlationFilter && typeof isolated.correlationFilter === 'object') {
    isolated.correlationFilter = { ...isolated.correlationFilter, shadow: true };
  }
  if (isolated.timesfm && typeof isolated.timesfm === 'object') {
    isolated.timesfm = { ...isolated.timesfm, enabled: false };
  }
  return isolated;
}

export interface TmABResult {
  status: 'valid' | 'insufficient' | 'error';
  reasons?: string[];
  baseline?: TmMetrics;
  candidate?: TmMetrics;
  delta?: number;
  forecastSha256?: string;
  window?: { from: number; to: number };
}

/** Núcleo A/B inyectable (sin credenciales ni datasets en tests). */
export function evaluateTimesfmAB(input: {
  ticker: string; asset: any; entries: any[]; logs: Map<string, string[]>;
  cachePath: string; triggerTsList: number[]; now: number;
}, replay: typeof runBacktest = runBacktest): TmABResult {
  const { ticker, asset, entries, logs, cachePath, triggerTsList, now } = input;
  const audit = auditTimesfmCache(cachePath, triggerTsList);
  if (!audit.ok) return { status: 'insufficient', reasons: audit.reasons };

  const forecasts = loadTimesfmCache(cachePath);
  const minFrom = minEvaluationStart(entries);
  const tsList = [...forecasts.keys()].filter(ts => Number.isSafeInteger(ts) && ts > 0 && ts >= minFrom).sort((a, b) => a - b);
  if (tsList.length < TIMESFM_MIN_SAMPLE) return { status: 'insufficient', reasons: [`forecasts as-of tras warmup insuficientes: ${tsList.length}/${TIMESFM_MIN_SAMPLE}`] };
  const from = tsList[0], to = tsList.at(-1)! + 1;
  if (to > now) return { status: 'insufficient', reasons: ['ventana de forecast en el futuro'] };

  const common = readOnlyReplayConfig(mapAssetConfig(ticker, isolateTimesfm(asset)));
  const frozenHash = sha(stableCanonical(common));

  const trial = (timesfmOn: boolean): TmMetrics | undefined => {
    const cfg = readOnlyReplayConfig({
      ...json(common),
      timesfm: timesfmOn ? { enabled: true, cachePath } : { enabled: false },
    });
    const window = planReplayWindow(entries, from, to);
    const result = replay(logs, cfg, undefined, entries, window);
    if (sha(stableCanonical(common)) !== frozenHash) throw new Error('configuración congelada cambió durante el replay');
    if (!result.replayDiagnostics?.readiness.ready) return undefined;
    const terminal = entries.reduce((last, e) => e.ts >= window.warmupStartMs && e.ts < to ? Math.max(last, e.ts) : last, -1);
    const trades = completedTrades(result.trades ?? [], from, to, terminal);
    return metrics(trades);
  };

  let baseline: TmMetrics | undefined, candidate: TmMetrics | undefined;
  try {
    baseline = trial(false);
    candidate = trial(true);
  } catch (e: any) {
    return { status: 'error', reasons: [e.message] };
  }
  if (!baseline || !candidate) return { status: 'insufficient', reasons: ['warmup incompleto en baseline o candidato'] };
  if (baseline.n < TIMESFM_MIN_SAMPLE || candidate.n < TIMESFM_MIN_SAMPLE) {
    return { status: 'insufficient', baseline, candidate,
      reasons: [`muestra insuficiente: mínimo ${TIMESFM_MIN_SAMPLE} trades en baseline (${baseline.n}) Y candidato (${candidate.n})`] };
  }
  const delta = candidate.pnlR - baseline.pnlR;
  return { status: 'valid', baseline, candidate, delta, forecastSha256: sha(fs.readFileSync(cachePath)), window: { from, to } };
}

export async function main(args = process.argv.slice(2)) {
  const ticker = (args[0] || 'GER40').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(ticker)) throw new Error('ticker inválido');
  const admin = (await import('firebase-admin')).default;
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'))) });
  const db = admin.firestore();
  const snapshot = await db.doc(`asset_configs/${ticker}`).get();
  if (!snapshot.exists) throw new Error(`sin config de asset: ${ticker}`);
  const asset = json(snapshot.data());
  const base = `/opt/JARVIS/logs/${ticker.toLowerCase()}/forecasts`;
  const triggerTsList = readTriggerTs(`${base}/triggers_m5.jsonl`);
  const cachePath = `${base}/forecasts_m5.jsonl`;
  const dir = `/opt/JARVIS/logs/${ticker.toLowerCase()}/history_exported`;
  const logs = loadSelectionLogs({ ticker, logsDir: dir });
  if (logs.size !== 5) throw new Error('se requieren los cinco datasets TF de producción');
  const entries = await prepareEntries(logs);
  console.log(JSON.stringify(evaluateTimesfmAB({ ticker, asset, entries, logs, cachePath, triggerTsList, now: Date.now() }), null, 2));
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  main().catch(e => { console.error('[timesfm-sweep] ERROR:', e?.message ?? e); process.exitCode = 1; });
}
