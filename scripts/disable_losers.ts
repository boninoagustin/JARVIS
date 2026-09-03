import fs from 'fs';
import path from 'path';
import { runBacktest, prepareEntries, getSessionForTimestamp } from '/opt/JARVIS/jarvis-os/src/services/backtestEngine.js';
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

function metrics(trades: any[]) {
  const n = trades.length;
  const wins = trades.filter(t => (t.rMultiple ?? 0) > 0).length;
  const pnl = trades.reduce((s, t) => s + (t.rMultiple ?? 0), 0);
  const gp = trades.reduce((s, t) => s + Math.max(0, t.rMultiple ?? 0), 0);
  const gl = trades.reduce((s, t) => s + Math.max(0, -(t.rMultiple ?? 0)), 0);
  let eq = 0, peak = 0, mdd = 0;
  for (const t of trades) { eq += (t.rMultiple ?? 0); if (eq > peak) peak = eq; mdd = Math.max(mdd, peak - eq); }
  return { n, wr: n ? (wins / n) * 100 : 0, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), pnl, mdd };
}

const arg = process.argv[2] || 'all';
const ASSETS = arg === 'all'
  ? ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40']
  : arg.split(',').map(s => s.trim().toUpperCase());

for (const ticker of ASSETS) {
  const current = (await db.doc(`asset_configs/${ticker}`).get()).data() || {};
  const logs = loadLogs(ticker, ['M5', 'M15', 'H1', 'H4', 'D1']);
  const prepared = await prepareEntries(logs);
  const buildConfig = (sessions: any) => ({ ticker, entryTrigger: 'SMART', minBuyPoints: 4, minSellPoints: 4, slBufferPercent: 0.1, fixedRR: 2.0, oteEntryPercent: 50, sessions, spreadPips: 0.1, commissionPerLot: 3.0, tp1StructuralMinRR: 1.2 });

  const sessions = JSON.parse(JSON.stringify(current.sessions || {}));
  const before = runBacktest(logs, buildConfig(sessions), undefined, prepared);

  // desglose por (sesión, gatillo)
  const by: Record<string, { n: number; wins: number; pnl: number }> = {};
  for (const t of before.trades) {
    const r = t.rMultiple ?? 0;
    const sess = getSessionForTimestamp(t.timestamp);
    const trig = t.triggerType || '?';
    const key = `${sess}/${trig}`;
    if (!by[key]) by[key] = { n: 0, wins: 0, pnl: 0 };
    by[key].n++; if (r > 0) by[key].wins++; by[key].pnl += r;
  }

  // perdedores (pnl < 0, con gatillo conocido)
  const losers = Object.entries(by).filter(([k, v]) => v.pnl < 0 && !k.endsWith('/?'));
  const disabled: string[] = [];
  for (const [k] of losers) {
    const [sess, trig] = k.split('/');
    if (sessions[sess]?.[trig] && sessions[sess][trig].enabled !== false) {
      sessions[sess][trig].enabled = false;
      disabled.push(k);
    }
  }

  const after = runBacktest(logs, buildConfig(sessions), undefined, prepared);
  const mb = metrics(before.trades), ma = metrics(after.trades);

  await db.doc(`asset_configs/${ticker}`).set({ sessions, updatedAt: new Date().toISOString(), source: 'disable_losers' }, { merge: true });

  console.log(`\n=== ${ticker} ===`);
  console.log(`  ANTES : trades=${mb.n} WR=${mb.wr.toFixed(0)}% PF=${mb.pf.toFixed(2)} PnL=${mb.pnl.toFixed(1)}R DD=${mb.mdd.toFixed(1)}R`);
  console.log(`  DESPUÉS: trades=${ma.n} WR=${ma.wr.toFixed(0)}% PF=${ma.pf.toFixed(2)} PnL=${ma.pnl.toFixed(1)}R DD=${ma.mdd.toFixed(1)}R`);
  console.log(`  desactivados (${disabled.length}): ${disabled.join(', ') || 'ninguno'}`);
}
console.log('\nDONE');
process.exit(0);
