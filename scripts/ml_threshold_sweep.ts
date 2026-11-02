// ml_threshold_sweep.ts — barrido de umbral del gate ML por activo (sep-2026).
// Para cada activo live: corre el backtest de producción (config real de Firestore + logs
// Pine exportados) con el gate ML en umbrales 0.40→0.75 (y baseline SIN gate).
// Walk-forward honesto: el gate solo actúa sobre trades con ts > trainedAt (mtime del modelo).
// No escribe nada: solo reporta. Umbral del modelo en vivo se cambia editando meta.threshold.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest, prepareEntries } from '/opt/JARVIS/jarvis-os/src/services/backtestEngine.js';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_ROOT = '/opt/JARVIS/logs';
const MODELS = '/opt/JARVIS/scripts/hyperopt/models';
const SWEEP_DIR = '/tmp/ml_sweep';
fs.mkdirSync(SWEEP_DIR, { recursive: true });

const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

function loadLogs(ticker: string, tfs: string[]) {
  const dir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
  const logs = new Map<string, string[]>();
  const tfNum: Record<string, string> = { 'M5': '5', 'M15': '15', 'H1': '60', 'H4': '240', 'D1': 'D' };
  for (const tf of tfs) {
    const cands = [path.join(dir, `pine-logs-SMC Master_${tf}.csv`), path.join(dir, `pine-logs-SMC Master_${tf.toUpperCase()}.csv`)];
    const alt = tfNum[tf];
    const all = alt ? cands.concat([path.join(dir, `pine-logs-SMC Master_${alt}.csv`)]) : cands;
    const f = all.find(c => fs.existsSync(c));
    if (f) logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim().length > 0));
  }
  return logs;
}

function metrics(ft: any[]) {
  const pnlR = ft.reduce((s, t) => s + (t.rMultiple ?? 0), 0);
  const wins = ft.filter(t => (t.rMultiple ?? 0) > 0).length;
  const gp = ft.reduce((s, t) => s + Math.max(0, t.rMultiple ?? 0), 0);
  const gl = ft.reduce((s, t) => s + Math.max(0, -(t.rMultiple ?? 0)), 0);
  let peak = 0, eq = 0, mdd = 0;
  for (const t of ft) { eq += (t.rMultiple ?? 0); if (eq > peak) peak = eq; mdd = Math.max(mdd, peak - eq); }
  return {
    n: ft.length,
    wr: ft.length ? +(wins / ft.length * 100).toFixed(1) : 0,
    pf: +(gp / Math.max(0.0001, gl)).toFixed(2),
    pnlR: +pnlR.toFixed(1),
    mdd: +mdd.toFixed(2),
  };
}

const THRESHOLDS = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75];
// Activos oficiales del roster con historia SMC lista para sweep
const atSnap = await db.collection('optimization_config').doc('active_tickers').get();
const TICKERS: string[] = (atSnap.exists && Array.isArray(atSnap.data()?.tickers))
  ? atSnap.data().tickers
  : ['AUDCAD', 'AUDJPY', 'EURUSD', 'GBPJPY', 'GBPUSD', 'JP225', 'NZDUSD', 'USDJPY', 'XAUUSD'];

const out: any = {};
for (const T of TICKERS) {
  const cfgDoc = (await db.doc(`asset_configs/${T}`).get()).data() || {};
  const logs = loadLogs(T, ['M5', 'M15', 'H1', 'H4', 'D1']);
  const prepared = await prepareEntries(logs);
  const base: any = {
    ticker: T, entryTrigger: cfgDoc.entryTrigger || 'SMART',
    minBuyPoints: cfgDoc.minPointsForBuy ?? 4, minSellPoints: cfgDoc.minPointsForSell ?? 4,
    slBufferPercent: cfgDoc.slBufferPercent ?? 0.1, fixedRR: cfgDoc.fixedRR ?? 2.0, oteEntryPercent: cfgDoc.oteEntryPercent ?? 50,
    sessions: cfgDoc.sessions || {},
    maxDailyLossR: cfgDoc.maxDailyLossR || undefined,
    dailyProfitTargetR: cfgDoc.dailyProfitTargetR || undefined,
    maxConsecutiveLosses: cfgDoc.maxConsecutiveLosses || undefined,
    maxTradesPerDay: cfgDoc.maxTradesPerDay || undefined,
    trailingDrawdownR: cfgDoc.trailingDrawdownR || undefined,
    enabled: cfgDoc.enabled ?? true,
    spreadPips: 0.1, commissionPerLot: 3.0,
    tp1StructuralMinRR: cfgDoc.tp1StructuralMinRR ?? 1.2,
    minimal_roi: cfgDoc.minimal_roi,
  };
  const modelPath = fs.existsSync(path.join(MODELS, `ml_model_${T}.json`))
    ? path.join(MODELS, `ml_model_${T}.json`)
    : path.join(MODELS, 'ml_model.json');
  const trainedAt = fs.statSync(modelPath).mtimeMs;
  const modelJson = JSON.parse(fs.readFileSync(modelPath, 'utf8'));

  const row: any = { modelo: path.basename(modelPath), trainedAt: new Date(trainedAt).toISOString().slice(0, 10), runs: {} };

  // baseline sin gate
  const baseRes = runBacktest(logs, { ...base }, undefined, prepared);
  row.runs['sin-gate'] = metrics(baseRes.trades ?? []);

  for (const th of THRESHOLDS) {
    const tempPath = path.join(SWEEP_DIR, `ml_${T}_th${String(th).replace('.', '')}.json`);
    const m2 = JSON.parse(JSON.stringify(modelJson));
    m2.meta = { ...(m2.meta ?? {}), threshold: th };
    fs.writeFileSync(tempPath, JSON.stringify(m2));
    const cfg = { ...base, mlGate: { enabled: true, modelPath: tempPath, trainedAt } };
    const res = runBacktest(logs, cfg, undefined, prepared);
    row.runs[`th_${th}`] = metrics(res.trades ?? []);
  }
  out[T] = row;
  console.log(`${T} ok`);
}

// ─── reporte ───
console.log('\n=== SWEEP UMBRAL ML (walk-forward, gate post-trainedAt) ===\n');
for (const T of TICKERS) {
  const row = out[T];
  const r = row.runs;
  console.log(`\n── ${T} (${row.modelo}, train hasta ${row.trainedAt}) ──`);
  const base0 = r['sin-gate'];
  console.log(`  sin-gate : n=${base0.n} WR=${base0.wr}% PF=${base0.pf} pnl=${base0.pnlR}R DD=${base0.mdd}`);
  for (const th of THRESHOLDS) {
    const m = r[`th_${th}`];
    const delta = +(m.pnlR - base0.pnlR).toFixed(1);
    console.log(`  umbral ${th.toFixed(2)}: n=${String(m.n).padStart(3)} WR=${String(m.wr).padStart(4)}% PF=${String(m.pf).padStart(5)} pnl=${String(m.pnlR).padStart(6)}R DD=${String(m.mdd).padStart(5)}  (Δ vs sin-gate: ${delta >= 0 ? '+' : ''}${delta}R)`);
  }
}
fs.writeFileSync('/opt/JARVIS/scripts/hyperopt/ml_threshold_sweep.json', JSON.stringify(out, null, 2));
console.log('\n[sweep] resultados → scripts/hyperopt/ml_threshold_sweep.json');

// 🆕 16-sep-2026: publicar a Firestore (ml_gate_evals/{TICKER}) para el botón GATE ML del panel.
// El bot de producción NO debe correr mientras esto escribe (usa admin SDK, colección aparte).
try {
    for (const T of TICKERS) {
        const row = out[T];
        if (!row || !row.runs || !row.runs['sin-gate']) continue;
        const sinGate = row.runs['sin-gate'];
        let best: any = null; let bestKey = '';
        for (const th of THRESHOLDS) {
            const m = row.runs[`th_${th}`];
            if (!m) continue;
            if (!best || m.pnlR > best.pnlR) { best = m; bestKey = `th_${th}`; }
        }
        if (!best) continue;
        await db.collection('ml_gate_evals').doc(T).set({
            ticker: T,
            modelo: row.modelo,
            trainedAt: row.trainedAt,
            evaluatedAt: Date.now(),
            sinGate,
            bestGate: { umbral: Number(bestKey.replace('th_', '')), ...best },
            delta: +(best.pnlR - sinGate.pnlR).toFixed(1),
        }, { merge: true });
    }
    console.log(`[sweep] ✅ publicado a Firestore (ml_gate_evals × ${TICKERS.length}) — visible en el panel GATE ML`);
} catch (err: any) {
    console.log('[sweep] ⚠️ no se pudo publicar a Firestore:', err?.message ?? err);
}
process.exit(0);
