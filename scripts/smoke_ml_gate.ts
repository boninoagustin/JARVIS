// Smoke ML gate (ML F3): GBPUSD con la config de producción + mlGate → ver rechazos walk-forward.
import fs from 'fs';
import path from 'path';
const admin = (await import('firebase-admin')).default;
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const { runBacktest, prepareEntries } = await import('./jarvis-os/src/services/backtestEngine.ts');

const ticker = process.argv[2] || 'GBPUSD';
const TFS = ['M5', 'M15', 'H1', 'H4', 'D1'];
function buildTrigger(fb: any): any {
  return { enabled: fb?.enabled ?? true, minScore: fb?.minScore ?? 4, slBuff: fb?.slBuff ?? 0.1,
    tp2: fb?.tp2 ?? 1.5, partialClosePct: fb?.partialClosePct ?? 0.5, slAfterTp1: fb?.slAfterTp1 ?? 'midpoint',
    tp15BeEnabled: fb?.tp15BeEnabled ?? true, atrTrailEnabled: fb?.atrTrailEnabled ?? true,
    structuralTrailEnabled: fb?.structuralTrailEnabled ?? true, tp1StructuralMinRR: fb?.tp1StructuralMinRR ?? 1.2 };
}
const dir = path.join('/opt/JARVIS', 'logs', ticker.toLowerCase(), 'history_exported');
const logs = new Map<string, string[]>();
for (const tf of TFS) {
  const f = path.join(dir, `pine-logs-SMC Master_${tf}.csv`);
  if (fs.existsSync(f)) logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim().length > 0));
}
const snap = await db.collection('asset_configs').doc(ticker).get();
const fb = snap.exists ? snap.data() || {} : {};
const sessions: any = {};
for (const [sess, sc] of Object.entries(fb.sessions || {})) {
  const c: any = sc || {};
  sessions[sess] = { choch15m: buildTrigger(c.choch15m), bos15m: buildTrigger(c.bos15m),
    oteChoch15m: buildTrigger(c.oteChoch15m), oteBos15m: buildTrigger(c.oteBos15m),
    choch5m: buildTrigger(c.choch5m), bos5m: buildTrigger(c.bos5m),
    oteChoch5m: buildTrigger(c.oteChoch5m), oteBos5m: buildTrigger(c.oteBos5m) };
}
const mlPath = `/opt/JARVIS/scripts/hyperopt/models/ml_model_${ticker}.json`;
const trainedAt = fs.existsSync(mlPath) ? Math.floor(fs.statSync(mlPath).mtimeMs) : 0;
console.log(`modelo ${mlPath} mtime=${new Date(trainedAt).toISOString()}`);

const base: any = { ticker, minBuyPoints: fb.minPointsForBuy ?? 4, minSellPoints: fb.minPointsForSell ?? 4,
  oteEntryPercent: fb.oteEntryPercent ?? 50, entryTrigger: fb.entryTrigger ?? 'SMART', sessions,
  sessionFilter: ['LONDON', 'NY', 'ASIA', 'OFF'], minimal_roi: fb.minimal_roi ?? { "0": 0.01, "30": 0.003, "60": 0 } };
const prepared = await prepareEntries(logs);

function run(label: string, mlGate?: any) {
  const res = runBacktest(logs, { ...base, mlGate }, undefined, prepared);
  let wins = 0, losses = 0, netR = 0;
  for (const t of res.trades) { const r = t.rMultiple ?? 0; if (r > 0) wins++; else if (r < 0) losses++; netR += r; }
  // walk-forward check: rechazos deben ser post-trainedAt
  let postTrained = 0, totalTrades = 0;
  for (const t of res.trades) { totalTrades++; if (t.timestamp > trainedAt) postTrained++; }
  console.log(`${label}: trades=${res.trades.length} (post-mtime=${postTrained}) | wins=${wins} losses=${losses} | netR=${netR.toFixed(2)} | mlRejected=${res.mlRejected ?? 0} | gateEnabled=${res.mlGateEnabled ?? false}`);
}
run('SIN gate', undefined);
run('CON gate', { enabled: true, modelPath: mlPath, trainedAt });
process.exit(0);
