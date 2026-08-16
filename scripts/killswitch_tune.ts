import fs from 'fs';
import path from 'path';
import { runBacktest, prepareEntries } from '/opt/JARVIS/jarvis-os/src/services/backtestEngine.js';
import admin from 'firebase-admin';

const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const LOGS_ROOT = '/opt/JARVIS/logs';
const tfNum = { 'M5': '5', 'M15': '15', 'H1': '60', 'H4': '240', 'D1': 'D' };
function loadLogs(ticker: string, tfs: string[]) {
  const dir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
  const logs = new Map<string, string[]>();
  for (const tf of tfs) {
    const cands = [path.join(dir, `pine-logs-SMC Master_${tf}.csv`), path.join(dir, `pine-logs-SMC Master_${tf.toUpperCase()}.csv`)];
    const alt = tfNum[tf];
    const all = alt ? cands.concat([path.join(dir, `pine-logs-SMC Master_${alt}.csv`)]) : cands;
    const f = all.find(c => fs.existsSync(c));
    if (f) logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim().length > 0));
  }
  return logs;
}

function m(trades: any[]) {
  const n = trades.length;
  const wins = trades.filter(t => (t.rMultiple ?? 0) > 0).length;
  const pnl = trades.reduce((s, t) => s + (t.rMultiple ?? 0), 0);
  const gp = trades.reduce((s, t) => s + Math.max(0, t.rMultiple ?? 0), 0);
  const gl = trades.reduce((s, t) => s + Math.max(0, -(t.rMultiple ?? 0)), 0);
  let eq = 0, peak = 0, mdd = 0;
  for (const t of trades) { eq += (t.rMultiple ?? 0); if (eq > peak) peak = eq; mdd = Math.max(mdd, peak - eq); }
  return { n, wr: n ? (wins / n) * 100 : 0, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), pnl, mdd, score: mdd > 0 ? pnl / mdd : pnl };
}

const DLR = [0, 1, 1.5, 2, 2.5, 3, 4, 5];
const MCL = [0, 2, 3, 4, 5, 6];

const arg = process.argv[2] || 'all';
const ASSETS = arg === 'all'
  ? ['XAUUSD', 'AUDCAD', 'BTCUSD', 'EURUSD', 'GBPUSD', 'NZDUSD', 'USDCAD', 'USDJPY', 'USOIL']
  : arg.split(',').map(s => s.trim().toUpperCase());

for (const ticker of ASSETS) {
  const current = (await db.doc(`asset_configs/${ticker}`).get()).data() || {};
  const logs = loadLogs(ticker, ['M5', 'M15', 'H1', 'H4', 'D1']);
  const prepared = await prepareEntries(logs);
  const base = {
    ticker, entryTrigger: 'SMART', minBuyPoints: 4, minSellPoints: 4,
    slBufferPercent: current.slBufferPercent ?? 0.1, fixedRR: current.fixedRR ?? 2.0, oteEntryPercent: current.oteEntryPercent ?? 50,
    sessions: current.sessions || {}, spreadPips: 0.1, commissionPerLot: 3.0, tp1StructuralMinRR: 1.2,
  };

  let best: any = null, baseM = m(runBacktest(logs, { ...base }, undefined, prepared).trades);

  for (const dlr of DLR) {
    for (const mcl of MCL) {
      const cfg = { ...base, maxDailyLossR: dlr || undefined, maxConsecutiveLosses: mcl || undefined };
      const res = runBacktest(logs, cfg, undefined, prepared);
      const mm = m(res.trades);
      if (!best || mm.score > best.score) best = { dlr, mcl, ...mm };
    }
  }

  // escribir el mejor a Firestore
  await db.doc(`asset_configs/${ticker}`).set(
    { maxDailyLossR: best.dlr, maxConsecutiveLosses: best.mcl, updatedAt: new Date().toISOString(), source: 'killswitch_tune' },
    { merge: true }
  );

  console.log(`=== ${ticker} ===`);
  console.log(`  base(0,0)        : PnL=${baseM.pnl.toFixed(1)}R DD=${baseM.mdd.toFixed(1)}R PF=${baseM.pf.toFixed(2)}`);
  console.log(`  BEST maxDLR=${best.dlr} maxCL=${best.mcl} : PnL=${best.pnl.toFixed(1)}R DD=${best.mdd.toFixed(1)}R PF=${best.pf.toFixed(2)} WR=${best.wr.toFixed(0)}% trades=${best.n}  (score=${best.score.toFixed(2)})`);
}
console.log('\nDONE');
process.exit(0);
