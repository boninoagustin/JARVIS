import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest, prepareEntries } from '/opt/JARVIS/jarvis-os/src/services/backtestEngine.js';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_ROOT = '/opt/JARVIS/logs';

function loadLogs(ticker, tfs) {
  const dir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
  const logs = new Map();
  const tfNum = { 'M5': '5', 'M15': '15', 'H1': '60', 'H4': '240', 'D1': 'D' };
  for (const tf of tfs) {
    const cands = [path.join(dir, `pine-logs-SMC Master_${tf}.csv`), path.join(dir, `pine-logs-SMC Master_${tf.toUpperCase()}.csv`)];
    const alt = tfNum[tf];
    const all = alt ? cands.concat([path.join(dir, `pine-logs-SMC Master_${alt}.csv`)]) : cands;
    const f = all.find(c => fs.existsSync(c));
    if (f) logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim().length > 0));
  }
  return logs;
}

const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const ticker = 'XAUUSD';
const current = (await db.doc(`asset_configs/${ticker}`).get()).data() || {};
const logs = loadLogs(ticker, ['M5', 'M15', 'H1', 'H4', 'D1']);
const prepared = await prepareEntries(logs);

const finalConfig = {
  ticker, entryTrigger: current.entryTrigger || 'SMART',
  minBuyPoints: current.minPointsForBuy ?? 4, minSellPoints: current.minPointsForSell ?? 4,
  slBufferPercent: current.slBufferPercent ?? 0.1, fixedRR: current.fixedRR ?? 2.0, oteEntryPercent: current.oteEntryPercent ?? 50,
  sessions: current.sessions || {},
  maxDailyLossR: current.maxDailyLossR || undefined,
  dailyProfitTargetR: current.dailyProfitTargetR || undefined,
  maxConsecutiveLosses: current.maxConsecutiveLosses || undefined,
  maxTradesPerDay: current.maxTradesPerDay || undefined,
  trailingDrawdownR: current.trailingDrawdownR || undefined,
  enabled: current.enabled ?? true,
  spreadPips: 0.1, commissionPerLot: 3.0,
  // F3-etapa1: reflejar la gestión real de producción (antes hardcodeado en 1.2 y sin ROI)
  tp1StructuralMinRR: current.tp1StructuralMinRR ?? 1.2,
  minimal_roi: current.minimal_roi,
};
const res = runBacktest(logs, finalConfig, undefined, prepared);
const ft = res.trades;
const fw = ft.filter(t => (t.rMultiple ?? 0) > 0).length;
const fpnl = ft.reduce((s, t) => s + (t.rMultiple ?? 0), 0);
let peak = 0, eq = 0, mdd = 0;
for (const t of ft) { eq += (t.rMultiple ?? 0); if (eq > peak) peak = eq; mdd = Math.max(mdd, peak - eq); }
const fpf = ft.reduce((s, t) => s + Math.max(0, t.rMultiple ?? 0), 0) / Math.max(0.0001, ft.reduce((s, t) => s + Math.max(0, -(t.rMultiple ?? 0)), 0));
console.log(JSON.stringify({ ticker, ANTES: { trades: ft.length, winRate: +(ft.length ? (fw / ft.length) * 100 : 0).toFixed(1), profitFactor: +fpf.toFixed(2), pnlR: +fpnl.toFixed(1), maxDD: +mdd.toFixed(2) } }));
process.exit(0);
