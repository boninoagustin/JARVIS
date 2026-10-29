// Paso 1b (sep-2026, Opción B aprobada por Bon): fase semanal del optimizador dominical
// que PROPONE (nunca aplica) la mejor confluencia de bias por activo.
// Corre el motor REAL con las variantes V1-V4 (V5 binario viejo EXCLUIDO — descartado
// con datos vivos: what-if del journal mostró que metía las pérdidas grandes).
// Evalúa con el MISMO objective del hyperopt (worker: minTrades=30, ddPenalty=0.5,
// samplePenalty=0.25, targetTrades=200, PF capeado 5) y devuelve JSON en la última línea.
// Uso: npx tsx scripts/bias_confluence_tune.ts <TICKER>
import fs from 'fs';
import path from 'path';
import {parseSelectionArgs, readAssetSnapshot, selectionEntries, selectionReplayOptions, selectionManifest, readSelectionConfig, completedSelectionTrades, loadSelectionLogs, saveSelection} from './periodic_opt/selection_context.js';
const selection = parseSelectionArgs();
const manifest = selectionManifest(selection);

const { runBacktest, prepareEntries } = await import('../jarvis-os/src/services/backtestEngine.ts');

const ticker = (process.argv[2] || '').toUpperCase();
if (!ticker) { console.error('uso: npx tsx scripts/bias_confluence_tune.ts <TICKER>'); process.exit(2); }
const TFS = ['M5', 'M15', 'H1', 'H4', 'D1'];

// ⚠️ V5 (binario viejo) excluida a propósito: ganaba netR en el motor pero los datos VIVOS
// (what-if journal 98 trades, sep-2026) mostraron que mete las pérdidas grandes.
const VARIANTS: Array<{ name: string; bc: any }> = [
  { name: 'V1_macro_3_3', bc: { tfs: ['D', '240', '60'], minForFull: 3, minForHalf: 2, fullPts: 5, halfPts: 2 } },
  { name: 'V2_macro_2_3', bc: { tfs: ['D', '240', '60'], minForFull: 2, minForHalf: 1, fullPts: 5, halfPts: 2 } },
  { name: 'V3_extend_3_5', bc: { tfs: ['5', '15', '60', '240', 'D'], minForFull: 3, minForHalf: 2, fullPts: 5, halfPts: 2 } },
  { name: 'V4_extend_4_5', bc: { tfs: ['5', '15', '60', '240', 'D'], minForFull: 4, minForHalf: 3, fullPts: 5, halfPts: 2 } },
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

function loadLogs(): Map<string, string[]> {
  return loadSelectionLogs(selection);
}
// Métricas COMPLETAS — espejo de computeMetrics del hyperopt worker
function computeMetrics(trades: any[]) {
  const n = trades.length;
  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0, net = 0;
  let mcLosses = 0, mcWins = 0, curLoss = 0, curWin = 0;
  let peak = 0, cur = 0, maxDD = 0;
  const rList: number[] = [];
  for (const t of trades) {
    const r = t.rMultiple ?? 0;
    rList.push(r);
    net += r;
    if (r > 0) { wins++; grossProfit += r; curLoss = 0; curWin++; mcWins = Math.max(mcWins, curWin); }
    else if (r < 0) { losses++; grossLoss += -r; curWin = 0; curLoss++; mcLosses = Math.max(mcLosses, curLoss); }
    else { curWin = 0; curLoss = 0; }
    cur += r;
    if (cur > peak) peak = cur;
    const dd = peak - cur;
    if (dd > maxDD) maxDD = dd;
  }
  const wr = n ? wins / n : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const exp = n ? net / n : 0;
  let sharpe = 0;
  if (n > 1) {
    const mean = net / n;
    const variance = rList.reduce((acc, r) => acc + (r - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(n) : 0;
  }
  return { trade_count: n, win_rate: wr, net_pnl_r: net, profit_factor: pf,
           expectancy: exp, max_drawdown_r: maxDD, sharpe_simple: sharpe,
           max_consec_losses: mcLosses };
}

// MISMO objective que el hyperopt (jarvis_hyperopt_worker.ts:173)
function objective(m: any, minTrades = 30, ddPenalty = 0.5, samplePenalty = 0.25, targetTrades = 200): number {
  if (m.trade_count < minTrades) {
    if (m.trade_count === 0) return -100.0;
    return -10.0 * (1.0 - m.trade_count / minTrades);
  }
  const pfCapped = Math.min(m.profit_factor, 5.0);
  const tradeDev = Math.abs(m.trade_count - targetTrades) / targetTrades;
  return 0.5 * pfCapped - ddPenalty * m.max_drawdown_r - samplePenalty * tradeDev + 1.0 * m.expectancy;
}

(async () => {
  const fb = await readAssetSnapshot(selection);
  if (fb.enabled === false) {
    console.log(JSON.stringify({ ticker, status: 'DISABLED', reason: 'asset_configs.enabled=false' }));
    process.exit(0);
  }
  const logs = loadLogs();
  if (logs.size === 0) {
    console.log(JSON.stringify({ ticker, status: 'NO_CSVS' }));
    process.exit(0);
  }
  const prepared = selectionEntries(await prepareEntries(logs), manifest, selection);
  const replayOptions = selectionReplayOptions(selection, manifest);
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
  const baseConfig: any = readSelectionConfig(selection, fb);

  const results: any[] = [];
  for (const v of VARIANTS) {
    const config = { ...baseConfig, biasConfluence: v.bc };
    try {
      const res = runBacktest(logs, config, undefined, prepared, replayOptions);
      const m = computeMetrics(completedSelectionTrades(res.trades, manifest, prepared));
      const obj = objective(m);
      results.push({ variant: v.name, bc: v.bc, metrics: { ...m, profit_factor: m.profit_factor === Infinity ? null : +m.profit_factor.toFixed(2), net_pnl_r: +m.net_pnl_r.toFixed(2), max_drawdown_r: +m.max_drawdown_r.toFixed(2), win_rate: +(m.win_rate * 100).toFixed(1), expectancy: +m.expectancy.toFixed(3) }, objective: +obj.toFixed(3) });
    } catch (e: any) {
      results.push({ variant: v.name, error: e.message });
    }
  }
  const ok = results.filter(r => !r.error && r.metrics);
  if (ok.length === 0) {
    console.log(JSON.stringify({ ticker, status: 'ERROR', reason: 'todas las variantes fallaron', results }));
    process.exit(0);
  }
  const best = ok.reduce((a, b) => (b.objective > a.objective ? b : a), ok[0]);
  const baseline = ok.find(r => r.variant === 'V1_macro_3_3');
  let status = 'HOLD';
  let recommended = null;
  let margin = null;
  if (!baseline || baseline.metrics.trade_count < 30) {
    status = 'INSUFFICIENT';
  } else if (best.variant !== 'V1_macro_3_3' && best.objective > baseline.objective + 0.05) {
    status = 'RECOMMEND';
    recommended = best;
    margin = +(best.objective - baseline.objective).toFixed(3);
  }
  const out: any = { ticker, status, recommended: recommended ? { bc: recommended.bc, metrics: recommended.metrics, objective: recommended.objective, margin_vs_baseline: margin } : null, baseline_variant: baseline ? { metrics: baseline.metrics, objective: baseline.objective } : null, variants: results, note: 'PROPUESTA — no aplica. Aplicación manual (regla de oro: el optimizador propone, nunca aplica).' };
  out.selection_partition = 'train';
  out.evaluation_manifest = manifest;
  saveSelection(selection, out);
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
