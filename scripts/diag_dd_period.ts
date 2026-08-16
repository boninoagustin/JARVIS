import fs from 'fs';
import path from 'path';
import { runBacktest, prepareEntries, getSessionForTimestamp } from '/opt/JARVIS/jarvis-os/src/services/backtestEngine.js';

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
const dt = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

async function analyze(ticker: string) {
  const tuned = JSON.parse(fs.readFileSync(`/opt/JARVIS/backups/${ticker}_tuned.json`, 'utf8'));
  const logs = loadLogs(ticker, ['M5', 'M15', 'H1', 'H4', 'D1']);
  const prepared = await prepareEntries(logs);
  const config = { ticker, entryTrigger: 'SMART', minBuyPoints: 4, minSellPoints: 4, slBufferPercent: 0.1, fixedRR: 2.0, oteEntryPercent: 50, sessions: tuned.sessions, spreadPips: 0.1, commissionPerLot: 3.0, tp1StructuralMinRR: 1.2 };
  const res = runBacktest(logs, config, undefined, prepared);

  // localizar período de max DD
  let eq = 0, peak = 0, mdd = 0, peakTs = 0, troughTs = 0;
  for (const t of res.trades) {
    eq += (t.rMultiple ?? 0);
    if (eq > peak) { peak = eq; peakTs = t.timestamp; }
    if (peak - eq > mdd) { mdd = peak - eq; troughTs = t.timestamp; }
  }
  console.log(`\n### ${ticker}  MaxDD=${mdd.toFixed(1)}R  (pico ${dt(peakTs)} → valle ${dt(troughTs)})`);
  // trades en el valle (ventana del DD)
  const ddTrades = res.trades.filter(t => t.timestamp >= peakTs && t.timestamp <= troughTs);
  console.log(`  trades en la ventana del DD: ${ddTrades.length}`);
  const losers = ddTrades.filter(t => (t.rMultiple ?? 0) < 0);
  console.log(`  perdedores en esa ventana (${losers.length}):`);
  for (const t of losers) {
    console.log(`    ${dt(t.timestamp)}  ${t.triggerType ?? '?'}/${getSessionForTimestamp(t.timestamp)}  ${t.direction}  ${(t.rMultiple ?? 0).toFixed(2)}R  result=${t.result}`);
  }
  // trades "?" (sin triggerType)
  const mystery = res.trades.filter(t => !t.triggerType);
  console.log(`  trades sin triggerType: ${mystery.length}`);
  for (const t of mystery) {
    console.log(`    ${dt(t.timestamp)}  ${getSessionForTimestamp(t.timestamp)}  ${t.direction}  ${(t.rMultiple ?? 0).toFixed(2)}R  grade=${t.grade}`);
  }
}

await analyze('EURUSD');
await analyze('GBPUSD');
process.exit(0);
