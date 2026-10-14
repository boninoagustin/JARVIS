// A/B de la confluencia de bias (Paso 1, sep-2026): corre el motor REAL con 5 variantes
// de biasConfluence por activo y compara métricas. No escribe nada en Firestore.
// Uso: npx tsx scripts/bias_confluence_ab.ts [--tickers EURUSD,GBPUSD]
import fs from 'fs';
import path from 'path';
const admin = (await import('firebase-admin')).default;
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const { runBacktest, prepareEntries } = await import('../jarvis-os/src/services/backtestEngine.ts');

const argIdx = process.argv.indexOf('--tickers');
const TICKERS = argIdx !== -1
  ? process.argv[argIdx + 1].split(',').map(t => t.trim().toUpperCase())
  : ['AUDCAD', 'BTCUSD', 'EURUSD', 'GBPUSD', 'NZDUSD', 'US500', 'USDCAD', 'USDJPY', 'USOIL', 'XAUUSD'];
const TFS = ['M5', 'M15', 'H1', 'H4', 'D1'];

const VARIANTS: Array<{ name: string; bc: any }> = [
  { name: 'V1 macro 3/3 (ACTUAL)', bc: { tfs: ['D', '240', '60'], minForFull: 3, minForHalf: 2, fullPts: 5, halfPts: 2 } },
  { name: 'V2 macro laxo 2/3', bc: { tfs: ['D', '240', '60'], minForFull: 2, minForHalf: 1, fullPts: 5, halfPts: 2 } },
  { name: 'V3 extend 3/5', bc: { tfs: ['5', '15', '60', '240', 'D'], minForFull: 3, minForHalf: 2, fullPts: 5, halfPts: 2 } },
  { name: 'V4 extend 4/5', bc: { tfs: ['5', '15', '60', '240', 'D'], minForFull: 4, minForHalf: 3, fullPts: 5, halfPts: 2 } },
  { name: 'V5 binario viejo (ref)', bc: { tfs: ['D', '240', '60'], minForFull: 1, minForHalf: 1, fullPts: 5, halfPts: 0 } },
];

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
  let wins = 0, losses = 0, totalR = 0, grossWin = 0, grossLoss = 0;
  let peak = 0, cur = 0, maxDD = 0;
  for (const t of trades) {
    const r = t.rMultiple ?? 0;
    if (r > 0) { wins++; grossWin += r; }
    else if (r < 0) { losses++; grossLoss += -r; }
    totalR += r;
    cur += r;
    if (cur > peak) peak = cur;
    const dd = peak - cur;
    if (dd > maxDD) maxDD = dd;
  }
  const n = trades.length;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return {
    n, wins, losses,
    wr: n ? +(wins / n * 100).toFixed(1) : 0,
    totalR: +totalR.toFixed(2),
    pf: pf === Infinity ? '∞' : +pf.toFixed(2),
    maxDD: +maxDD.toFixed(2),
  };
}

// Tabla final: por ticker, la mejor variante según totalR
const bestByTicker: Record<string, string> = {};

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
  const baseConfig: any = {
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
    console.log(`${ticker}: SIN CSVs — omitido`);
    continue;
  }
  const prepared = await prepareEntries(logs);
  console.log(`\n=== ${ticker} ===`);
  console.log('variante                  | trades | WR%   | netR    | PF    | maxDD(R)');
  console.log('--------------------------|--------|-------|---------|-------|---------');
  let bestR = -Infinity; let bestName = '';
  const pad = (s: any, n: number) => String(s).padEnd(n);
  for (const v of VARIANTS) {
    const config = { ...baseConfig, biasConfluence: v.bc };
    try {
      const res = runBacktest(logs, config, undefined, prepared);
      const m = metrics(res.trades);
      console.log(`${pad(v.name, 25)} | ${pad(m.n, 6)} | ${pad(m.wr, 5)} | ${pad(m.totalR, 7)} | ${pad(m.pf, 5)} | ${m.maxDD}`);
      if (m.totalR > bestR) { bestR = m.totalR; bestName = v.name; }
    } catch (e: any) {
      console.log(`${pad(v.name, 25)} | ERROR: ${e.message}`);
    }
  }
  bestByTicker[ticker] = `${bestName} (${bestR.toFixed(2)}R)`;
}

console.log('\n=== MEJOR VARIANTE POR ACTIVO (por netR) ===');
for (const [t, b] of Object.entries(bestByTicker)) console.log(`${t.padEnd(8)} → ${b}`);
process.exit(0);
