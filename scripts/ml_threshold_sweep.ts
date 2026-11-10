/** Exact-model chronological threshold selection + untouched holdout.
 * Default: read-only dry run. --apply writes ONLY validated ml_gate_evals evidence.
 * Usage: npx tsx scripts/ml_threshold_sweep.ts --ticker EURUSD [--apply] [--assume-trained-at]
 * --assume-trained-at: corte temporal CONSERVADOR derivado de trained_at (supuesto, no dato
 * medido) para modelos sin train_end_ms. Sin él, el sweep falla cerrado por proveniencia.
 * No model edits, model-mtime provenance, broker calls or asset-config writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine.js';
import { planReplayWindow } from '../jarvis-os/src/services/replayWindow.js';
import { configFingerprint, validateMLGateEvaluation } from '../jarvis-os/src/services/mlGateDeployment.js';
import { stableCanonical, readOnlyReplayConfig } from './hyperopt/evaluation_protocol.js';
import { mapAssetConfig, loadSelectionLogs } from './periodic_opt/selection_context.js';
import { loadModelFromJSON, setMLGateOverride, setMLGateDeployment, setMLWindowStart, getMLGateStatus } from '../src/engine/MLFilter.js';

export const THRESHOLDS = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75];
const ROOT = '/opt/JARVIS';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (value: any) => JSON.parse(JSON.stringify(value));
export function parseSweepArgs(args: string[]) {
  let ticker: string | undefined, apply = false, assumeTrainedAt = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') { if (apply) throw new Error('duplicate --apply'); apply = true; }
    else if (args[i] === '--assume-trained-at') { if (assumeTrainedAt) throw new Error('duplicate --assume-trained-at'); assumeTrainedAt = true; }
    else if (args[i] === '--ticker') {
      if (ticker || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--ticker requires one ticker');
      ticker = args[++i].toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(ticker) || ticker === 'ALL') throw new Error('invalid ticker');
    } else throw new Error(`unknown option: ${args[i]}`);
  }
  if (!ticker) throw new Error('--ticker is required (no implicit full-roster sweep)');
  return { ticker, apply, assumeTrainedAt };
}
/** Corte temporal del modelo. Autoritativo si registra train_end_ms/available_at_ms.
 * --assume-trained-at (opt-in) deriva un corte CONSERVADOR de trained_at (sin Z → UTC):
 * el modelo no juzga nada anterior a su fecha de entrenamiento. Es un supuesto, no un dato medido. */
export function temporalBounds(model: any, assumeNaiveUtc = false): {status: 'verified' | 'unknown'; train_end_ms?: number; available_at_ms?: number; derived?: string} {
  const meta = model?.meta ?? model?.metadata ?? {};
  const train = meta.train_end_ms;
  let available = meta.available_at_ms;
  // trained_at con Z (formato autoritativo) aporta available_at_ms.
  if (available === undefined && typeof meta.trained_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(meta.trained_at)) {
    available = Date.parse(meta.trained_at);
  }
  // trained_at sin Z: solo con opt-in, asumiendo UTC.
  if (available === undefined && assumeNaiveUtc && typeof meta.trained_at === 'string') {
    const parsed = Date.parse(meta.trained_at);
    if (Number.isSafeInteger(parsed) && parsed > 0) available = parsed;
  }
  // train_end_ms: autoritativo si está; si falta, con opt-in se usa el corte conservador (= available).
  let trainEnd = Number.isSafeInteger(train) && train >= 0 ? train : undefined;
  let derived: string | undefined;
  if (trainEnd === undefined && assumeNaiveUtc && Number.isSafeInteger(available)) {
    trainEnd = available;
    derived = 'derived_from_trained_at_conservative_cutoff';
  }
  if (!Number.isSafeInteger(trainEnd) || trainEnd < 0 || !Number.isSafeInteger(available) || available < trainEnd)
    return { status: 'unknown' };
  return { status: 'verified', train_end_ms: trainEnd, available_at_ms: available, ...(derived ? { derived } : {}) };
}
export function completedTrades(trades: any[], from: number, to: number, terminal: number) {
  return trades.filter(t => {
    const close = t.closeTimestamp ?? t.closedAt ?? t.closeTs;
    return Number.isSafeInteger(t.timestamp) && t.timestamp >= from && t.timestamp < to &&
      Number.isSafeInteger(close) && close >= t.timestamp && close < to && close < terminal &&
      Number.isFinite(t.rMultiple) && ['WIN', 'LOSS', 'BE', 'TIMEOUT', 'REVERSAL'].includes(t.result) &&
      t.executionBacktest?.closeReason !== 'FINAL_CENSOR';
  }).sort((a, b) => (a.closeTimestamp ?? a.closedAt ?? a.closeTs) - (b.closeTimestamp ?? b.closedAt ?? b.closeTs));
}
export function metrics(trades: any[]) {
  let wins = 0, gp = 0, gl = 0, equity = 0, peak = 0, mdd = 0;
  for (const t of trades) {
    if (!Number.isFinite(t.rMultiple)) throw new Error('invalid closed-trade return');
    const r = t.rMultiple;
    if (r > 0) wins++;
    gp += Math.max(0, r); gl += Math.max(0, -r); equity += r;
    peak = Math.max(peak, equity); mdd = Math.max(mdd, peak - equity);
  }
  // Finite PF for loss-free samples, consistent with existing reporting convention.
  return { n: trades.length, wr: trades.length ? wins / trades.length * 100 : 0,
    pf: gp / Math.max(0.0001, gl), pnlR: equity, mdd };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Aísla el gate ML: evalúa su contribución con los demás filtros contrafactuales
 * apagados (TimesFM) o en observación (correlación). El fingerprint resultante queda
 * vinculado a ESTA configuración aislada; activar con otro estado de filtros no coincide. */
export function isolateML(asset: any): any {
  const isolated = json(asset);
  if (isolated.timesfm && typeof isolated.timesfm === 'object') {
    isolated.timesfm = { ...isolated.timesfm, enabled: false };
  }
  if (isolated.correlationFilter && typeof isolated.correlationFilter === 'object') {
    isolated.correlationFilter = { ...isolated.correlationFilter, shadow: true };
  }
  return isolated;
}
export function chronologicalWindows(entries: readonly {ts: number}[], availableAt: number, now: number) {
  const post = entries.map(e => e.ts).filter(t => Number.isSafeInteger(t) && t > availableAt && t < now).sort((a,b) => a-b);
  if (post.length < 4) return undefined;
  const from = post[0], to = post.at(-1)! + 1;
  const split = from + Math.floor((to - from) / 2);
  if (!(from < split && split + 1 < to && to <= now)) return undefined;
  return { selection: { from, to: split }, validation: { from: split + 1, to } };
}

/** Injectable replay keeps producer tests hermetic: no credentials, datasets or writes. */
export function evaluateSweep(input: {ticker: string; asset: any; rawModel: Buffer; modelPath: string;
  entries: any[]; logs: Map<string, string[]>; now: number; assumeTrainedAt?: boolean}, replay: typeof runBacktest = runBacktest) {
  const { ticker, asset, rawModel, modelPath, entries, logs, now, assumeTrainedAt = false } = input;
  const modelSha256 = sha(rawModel);
  const model = JSON.parse(rawModel.toString('utf8'));
  const provenance = temporalBounds(model, assumeTrainedAt);
  if (provenance.status !== 'verified') return { status: 'insufficient', reasons: [`modelo sin proveniencia temporal (train_end_ms ausente)${assumeTrainedAt ? '' : '; usá --assume-trained-at para un corte conservador de trained_at'}`] };
  const windows = chronologicalWindows(entries, provenance.available_at_ms!, now);
  if (!windows) return { status: 'insufficient', reasons: ['insufficient post-availability chronology'] };
  // Freeze one full production projection. Each replay receives an isolated copy
  // because the engine normalizes friction fields in place.
  const common = freeze(readOnlyReplayConfig(mapAssetConfig(ticker, json(asset))));
  const originalConfigHash = sha(stableCanonical(common));
  const trial = (from: number, to: number, threshold?: number) => {
    const enabled = threshold !== undefined;
    const window = planReplayWindow(entries, from, to); // >=60 observations in EVERY TF
    setMLGateOverride(ticker, enabled);
    setMLGateDeployment(ticker, enabled ? { schemaVersion: 2, modelSha256, threshold, evidenceId: '0'.repeat(64) } : undefined);
    if (enabled && !loadModelFromJSON(rawModel.toString('utf8'), ticker, modelSha256)) throw new Error('model rejected by production loader');
    const cfg = readOnlyReplayConfig({ ...json(common), mlGateEnabled: enabled,
      mlGate: enabled ? { enabled: true, modelPath, trainedAt: provenance.available_at_ms } : { enabled: false } });
    const result = replay(logs, cfg, undefined, entries, window);
    if (sha(stableCanonical(common)) !== originalConfigHash) throw new Error('frozen common config changed');
    if (enabled) {
      const status = getMLGateStatus(ticker);
      if (!status.ready || status.modelSha256 !== modelSha256 || status.threshold !== threshold || !status.gateEnabled)
        throw new Error(`exact-model/threshold replay unavailable: ${status.reason}`);
    }
    if (!result.replayDiagnostics?.readiness.ready) return undefined;
    const terminal = entries.reduce((last, e) => e.ts >= window.warmupStartMs && e.ts < to ? Math.max(last, e.ts) : last, -1);
    return metrics(completedTrades(result.trades ?? [], from, to, terminal));
  };
  try {
    const runs: any[] = [];
    // Select once using ONLY the earlier period. No holdout is inspected here.
    for (const threshold of THRESHOLDS) {
      const stats = trial(windows.selection.from, windows.selection.to, threshold);
      if (!stats) return { status: 'insufficient', reasons: ['selection warmup incomplete'] };
      runs.push({ threshold, ...stats });
    }
    const best = runs.filter(r => r.n > 0).sort((a,b) => b.pnlR - a.pnlR || a.threshold - b.threshold)[0];
    if (!best) return { status: 'insufficient', reasons: ['no completed selection trades'] };
    const baseline = trial(windows.validation.from, windows.validation.to);
    const gate = trial(windows.validation.from, windows.validation.to, best.threshold);
    if (!baseline || !gate) return { status: 'insufficient', reasons: ['validation warmup incomplete'] };
    const body = { schemaVersion: 2, ticker, evaluatedAt: now, configFingerprint: configFingerprint(asset),
      model: { sha256: modelSha256, availableAt: provenance.available_at_ms!, trainingCutoffAt: provenance.train_end_ms!, ...(provenance.derived ? { cutoffAssumption: provenance.derived } : {}) },
      selection: { method: 'chronological-holdout', selectedThreshold: best.threshold, ...windows.selection },
      validation: { independent: true, threshold: best.threshold, ...windows.validation, baseline, gate } };
    const evidence = { ...body, evidenceId: sha(stableCanonical(body)) };
    const checked = validateMLGateEvaluation(evidence, { ticker, config: asset, now, modelSha256 });
    return { status: checked.ok ? 'valid' : 'insufficient', evidence, reasons: checked.reasons, selectionRuns: runs };
  } finally {
    setMLGateOverride(ticker, undefined); setMLGateDeployment(ticker, undefined); setMLWindowStart(0);
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSweepArgs(args); // validate BEFORE credentials/network
  const admin = (await import('firebase-admin')).default;
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(`${ROOT}/service-account.json`, 'utf8'))) });
  const db = admin.firestore(), ticker = options.ticker;
  const snapshot = await db.doc(`asset_configs/${ticker}`).get();
  if (!snapshot.exists) throw new Error(`missing asset config: ${ticker}`);
  const asset = json(snapshot.data());
  const configHash = sha(stableCanonical(asset));
  // Aislar el gate ML: la evidencia queda vinculada a la config con TimesFM apagado y
  // correlación observando (no a la config de producción con TimesFM encendido).
  const evalAsset = isolateML(asset);
  const modelPath = path.join(ROOT, 'scripts/hyperopt/models', `ml_model_${ticker}.json`);
  // Never silently substitute a generic model for a missing ticker model.
  const rawModel = fs.readFileSync(modelPath);
  const dir = path.join(ROOT, 'logs', ticker.toLowerCase(), 'history_exported');
  const inputPaths = fs.readdirSync(dir).filter(f => f.endsWith('.csv')).map(f => path.join(dir, f));
  const mapped = readOnlyReplayConfig(mapAssetConfig(ticker, evalAsset));
  inputPaths.push(modelPath);
  const hashes = new Map(inputPaths.map(file => [file, sha(fs.readFileSync(file))]));
  const logs = loadSelectionLogs({ticker, logsDir: dir});
  if (logs.size !== 5) throw new Error('all five production TF datasets are required');
  const entries = await prepareEntries(logs);
  const result = evaluateSweep({ticker, asset: evalAsset, rawModel, modelPath, entries, logs, now: Date.now(), assumeTrainedAt: options.assumeTrainedAt});
  for (const [file, hash] of hashes) if (sha(fs.readFileSync(file)) !== hash) throw new Error(`input changed during replay: ${file}`);
  const current = await db.doc(`asset_configs/${ticker}`).get();
  if (!current.exists || sha(stableCanonical(json(current.data()))) !== configHash) throw new Error('asset config changed during replay');
  const currentCsv = fs.readdirSync(dir).filter(f => f.endsWith('.csv')).map(f => path.join(dir, f)).sort();
  if (JSON.stringify(currentCsv) !== JSON.stringify(inputPaths.filter(f => f.endsWith('.csv')).sort())) throw new Error('dataset file set changed during replay');
  if (options.apply && result.status === 'valid') {
    // Sole allowed write: evidence document, never deployment/config/filter/broker.
    await db.collection('ml_gate_evals').doc(ticker).set(result.evidence!);
  }
  console.log(JSON.stringify({ mode: options.apply ? 'apply-evidence-only' : 'dry-run', ...result }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error('[ml-threshold-sweep] ERROR:', error?.message ?? error); process.exitCode = 1; });
}
