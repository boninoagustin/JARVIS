import fs from 'fs';
import path from 'path';
import { runBacktest, prepareEntries } from '/opt/JARVIS/jarvis-os/src/services/backtestEngine.js';

const LOGS_ROOT = '/opt/JARVIS/logs';
const tfNum = { 'M5': '5', 'M15': '15', 'H1': '60', 'H4': '240', 'D1': 'D' };
function loadLogs(ticker, tfs) {
  const dir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
  const logs = new Map();
  for (const tf of tfs) {
    const cands = [path.join(dir, `pine-logs-SMC Master_${tf}.csv`), path.join(dir, `pine-logs-SMC Master_${tf.toUpperCase()}.csv`)];
    const alt = tfNum[tf];
    const all = alt ? cands.concat([path.join(dir, `pine-logs-SMC Master_${alt}.csv`)]) : cands;
    const f = all.find(c => fs.existsSync(c));
    if (f) logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim().length > 0));
  }
  return logs;
}

const ticker = 'EURUSD';
const tuned = JSON.parse(fs.readFileSync('/opt/JARVIS/backups/EURUSD_tuned.json', 'utf8'));
const logs = loadLogs(ticker, ['M5', 'M15', 'H1', 'H4', 'D1']);
const prepared = await prepareEntries(logs);

const config = {
  ticker, entryTrigger: 'SMART',
  minBuyPoints: 4, minSellPoints: 4, slBufferPercent: 0.1, fixedRR: 2.0, oteEntryPercent: 50,
  sessions: tuned.sessions,
  spreadPips: 0.1, commissionPerLot: 3.0, tp1StructuralMinRR: 1.2,
};
const res = runBacktest(logs, config, undefined, prepared);

// desglose por (sesión, gatillo)
const by: Record<string, { n: number; wins: number; pnl: number }> = {};
for (const t of res.trades) {
  const r = t.rMultiple ?? 0;
  const key = `${(t as any).session || '?'}/${t.triggerType || '?'}`;
  if (!by[key]) by[key] = { n: 0, wins: 0, pnl: 0 };
  by[key].n++;
  if (r > 0) by[key].wins++;
  by[key].pnl += r;
}
console.log('=== PnL por sesión/gatillo (ordenado por peor PnL) ===');
const rows = Object.entries(by).sort((a, b) => a[1].pnl - b[1].pnl);
for (const [k, v] of rows) {
  console.log(`${k.padEnd(20)} n=${String(v.n).padStart(3)}  WR=${((v.wins / v.n) * 100).toFixed(0).padStart(3)}%  PnL=${v.pnl.toFixed(1).padStart(7)}R`);
}

// equity path para localizar el DD
let eq = 0, peak = 0, mdd = 0, ddStart = null, ddEnd = null;
for (const t of res.trades) {
  eq += (t.rMultiple ?? 0);
  if (eq > peak) peak = eq;
  const dd = peak - eq;
  if (dd > mdd) { mdd = dd; ddEnd = (t as any).timestamp; }
  if (dd > 0 && !ddStart) ddStart = (t as any).timestamp;
}
console.log(`\nMaxDD=${mdd.toFixed(1)}R`);
process.exit(0);
