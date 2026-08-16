import fs from 'fs';
import path from 'path';
const admin = (await import('firebase-admin')).default;
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const { runBacktest, prepareEntries } = await import('../jarvis-os/src/services/backtestEngine.ts');

const TICKERS = ['AUDCAD', 'BTCUSD', 'EURUSD', 'GBPUSD', 'NZDUSD', 'US500', 'USDCAD', 'USDJPY', 'USOIL', 'XAUUSD'];
const TFS = ['M5', 'M15', 'H1', 'H4', 'D1'];

function buildTrigger(fb: any, entryPercent?: number): any {
  return {
    enabled: fb?.enabled ?? true,
    minScore: fb?.minScore ?? 4,
    slBuff: fb?.slBuff ?? 0.1,
    tp2: fb?.tp2 ?? 1.5,
    partialClosePct: fb?.partialClosePct ?? 0.5,
    slAfterTp1: fb?.slAfterTp1 ?? 'midpoint',
    tp15BeEnabled: fb?.tp15BeEnabled ?? true,
    atrTrailEnabled: fb?.atrTrailEnabled ?? true,
    structuralTrailEnabled: fb?.structuralTrailEnabled ?? true,
    tp1StructuralMinRR: fb?.tp1StructuralMinRR ?? 1.2,
    ...(entryPercent !== undefined ? { entryPercent } : {}),
  };
}

function loadLogs(ticker: string): Map<string, string[]> {
  const dir = path.join('/opt/JARVIS', 'logs', ticker.toLowerCase(), 'history_exported');
  const logs = new Map<string, string[]>();
  if (!fs.existsSync(dir)) return logs;
  for (const tf of TFS) {
    const f = path.join(dir, `pine-logs-SMC Master_${tf}.csv`);
    if (!fs.existsSync(f)) continue;
    logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim().length > 0));
  }
  return logs;
}

function metrics(trades: any[]) {
  let wins = 0, losses = 0, be = 0, totalR = 0, grossWin = 0, grossLoss = 0;
  let peak = 0, cur = 0, maxDD = 0;
  for (const t of trades) {
    const r = t.rMultiple ?? 0;
    if (r > 0) { wins++; grossWin += r; }
    else if (r < 0) { losses++; grossLoss += -r; }
    else be++;
    totalR += r;
    cur += r;
    if (cur > peak) peak = cur;
    const dd = peak - cur;
    if (dd > maxDD) maxDD = dd;
  }
  const n = trades.length;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return {
    n, wins, losses, be,
    wr: n ? +(wins / n * 100).toFixed(1) : 0,
    totalR: +totalR.toFixed(2),
    avgR: n ? +(totalR / n).toFixed(3) : 0,
    pf: pf === Infinity ? '∞' : +pf.toFixed(2),
    maxDD: +maxDD.toFixed(2),
  };
}

console.log('TICKER   | trades | WR%   | netR   | avgR   | PF    | maxDD(R)');
console.log('---------|--------|-------|--------|--------|-------|---------');
for (const ticker of TICKERS) {
  const snap = await db.collection('asset_configs').doc(ticker).get();
  const fb = snap.exists ? snap.data() || {} : {};
  const sessions: any = {};
  for (const [sess, sc] of Object.entries(fb.sessions || {})) {
    const c: any = sc || {};
    sessions[sess] = {
      choch15m: buildTrigger(c.choch15m),
      bos15m: buildTrigger(c.bos15m),
      oteChoch15m: buildTrigger(c.oteChoch15m, 62),
      oteBos15m: buildTrigger(c.oteBos15m, 62),
      choch5m: buildTrigger(c.choch5m),
      bos5m: buildTrigger(c.bos5m),
      oteChoch5m: buildTrigger(c.oteChoch5m, 62),
      oteBos5m: buildTrigger(c.oteBos5m, 62),
    };
  }
  const config: any = {
    ticker,
    minBuyPoints: fb.minPointsForBuy ?? 4,
    minSellPoints: fb.minPointsForSell ?? 4,
    oteEntryPercent: fb.oteEntryPercent ?? 50,
    entryTrigger: fb.entryTrigger ?? 'SMART',
    sessions,
    sessionFilter: ['LONDON', 'NY', 'ASIA', 'OFF'],
    minimal_roi: fb.minimal_roi ?? { "0": 0.01, "30": 0.003, "60": 0 },
  };
  const logs = loadLogs(ticker);
  if (logs.size === 0) {
    console.log(`${ticker.padEnd(8)} | (sin CSVs)`);
    continue;
  }
  try {
    const prepared = await prepareEntries(logs);
    const res = runBacktest(logs, config, undefined, prepared);
    const m = metrics(res.trades);
    console.log(`${ticker.padEnd(8)} | ${String(m.n).padEnd(6)} | ${String(m.wr).padEnd(5)} | ${String(m.totalR).padEnd(6)} | ${String(m.avgR).padEnd(6)} | ${String(m.pf).padEnd(5)} | ${m.maxDD}`);
  } catch (e: any) {
    console.log(`${ticker.padEnd(8)} | ERROR: ${e.message}`);
  }
}
process.exit(0);
