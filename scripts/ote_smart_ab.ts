// A/B OTE (sep-2026): ¿el SMART rinde más CON el diferimiento a OTE o SIN él?
// SMART (actual) vs CHOCH (mismas entradas directas, OTE desactivado — mismo motor, solo
// cambia el flag entryTrigger). El motor comparte el AlphaModel del vivo → los 4 filtros
// duros del OTE aplican en ambas variantes. No escribe nada en Firestore.
// Uso: npx tsx scripts/ote_smart_ab.ts [--tickers EURUSD,GBPUSD]
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

function computeMetrics(trades: any[]) {
  const n = trades.length;
  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0, net = 0;
  let peak = 0, cur = 0, maxDD = 0;
  let oteCount = 0;
  for (const t of trades) {
    const r = t.rMultiple ?? 0;
    net += r;
    if (r > 0) { wins++; grossProfit += r; }
    else if (r < 0) { losses++; grossLoss += -r; }
    cur += r;
    if (cur > peak) peak = cur;
    const dd = peak - cur;
    if (dd > maxDD) maxDD = dd;
    const isOte = t.triggerType === 'OTE' || (t.events || []).some((e: string) => String(e).includes('OTE_Retracement'));
    if (isOte) oteCount++;
  }
  const wr = n ? wins / n : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const exp = n ? net / n : 0;
  return { n, oteCount, wr: +(wr * 100).toFixed(1), netR: +net.toFixed(2),
           pf: pf === Infinity ? '∞' : +pf.toFixed(2), maxDD: +maxDD.toFixed(2),
           expectancy: +exp.toFixed(3) };
}

const pad = (s: any, n: number) => String(s).padEnd(n);
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
    sessions,
    sessionFilter: ['LONDON', 'NY', 'ASIA', 'OFF'],
    minimal_roi: fb.minimal_roi ?? { "0": 0.01, "30": 0.003, "60": 0 },
  };
  const logs = loadLogs(ticker);
  if (logs.size === 0) { console.log(`${ticker}: SIN CSVs — omitido`); continue; }
  const prepared = await prepareEntries(logs);
  console.log(`\n=== ${ticker} ===`);
  console.log('variante   | trades | OTE  | WR%   | netR    | PF    | maxDD | expectancy');
  const results: any = {};
  for (const mode of ['SMART', 'CHOCH'] as const) {
    const config = { ...baseConfig, entryTrigger: mode };
    try {
      const res = runBacktest(logs, config, undefined, prepared);
      const m = computeMetrics(res.trades);
      results[mode] = m;
      console.log(`${pad(mode, 11)}| ${pad(m.n, 6)} | ${pad(m.oteCount, 4)} | ${pad(m.wr, 5)} | ${pad(m.netR, 7)} | ${pad(m.pf, 5)} | ${pad(m.maxDD, 5)} | ${m.expectancy}`);
    } catch (e: any) {
      console.log(`${pad(mode, 11)}| ERROR: ${e.message}`);
    }
  }
  if (results.SMART && results.CHOCH) {
    const d = results.CHOCH.netR - results.SMART.netR;
    const verdict = d > 0 ? '🏆 SIN OTE (CHOCH)' : d < 0 ? '🏆 CON OTE (SMART)' : 'EMPATE';
    console.log(`→ ΔnetR (CHOCH−SMART) = ${d.toFixed(2)}R | ${verdict}${results.SMART.oteCount > 0 ? ` | OTE aportó ${results.SMART.oteCount} trades en SMART` : ''}`);
  }
}
process.exit(0);
