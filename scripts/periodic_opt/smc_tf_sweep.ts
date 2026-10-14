/**
 * smc_tf_sweep.ts — BRUTEFORCER 2.0 v2 (22-sep-2026, corrección de Bon).
 *
 * Evalúa variantes de bloques TF (pivot_len/wick_pct/div_len/z_window) usando el
 * GENERADOR CANÓNICO de logs (scripts/export_smc_csv.ts — motor TS + velas cTrader,
 * el mismo que usa el ciclo semanal vía Kronos). NO hay TradingView en el pipeline.
 *
 * Por variante: escribe los bloques en optimized_preset_<T>.json → corre
 * export_smc_csv.ts (genera pine-logs para todas las TFs) → lee los CSVs →
 * runBacktest con la config viva de Firestore → métricas.
 * Al terminar RESTAURA el preset original (finally + handlers de señal).
 *
 * Uso: npx tsx scripts/periodic_opt/smc_tf_sweep.ts XAUUSD [--full] [--out PATH]
 *   --fast (default): 16 variantes/TF (~20 min) | --full: 81 variantes/TF.
 * Salida: optimized_preset_<T>_tfproposal.json (baseline vs propuesta + veredicto).
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import admin from 'firebase-admin';
import { runBacktest, prepareEntries } from '../../jarvis-os/src/services/backtestEngine.js';
import type { BacktestConfig } from '../../jarvis-os/src/services/backtestTypes.js';

const REPO = '/opt/JARVIS';
const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'service-account.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const ticker = (process.argv[2] || '').toUpperCase();
const FULL = process.argv.includes('--full');
if (!ticker) { console.error('Uso: npx tsx scripts/periodic_opt/smc_tf_sweep.ts TICKER [--full]'); process.exit(1); }

const TF_KEYS = ['15', '60', '240', 'D'] as const;          // TFs con bloques en el preset
const TF_FILES: Record<string, string> = { '5': 'M5', '15': 'M15', '60': 'H1', '240': 'H4', 'D': 'D1' };
const PRESET_TF: Record<string, string> = { '15': 'M15', '60': 'H1', '240': 'H4', 'D': 'D1' };
const MIN_TRADES = 20;

type Blocks = { pivot_len?: number; wick_pct?: number; div_len?: number; z_window?: number };
const GRID_FAST = { pivot_len: [3, 8], wick_pct: [0.1, 0.3], div_len: [2, 5], z_window: [14, 50] };
const GRID_FULL = { pivot_len: [3, 5, 8, 13, 21], wick_pct: [0.1, 0.3, 0.5, 0.7], div_len: [2, 3, 5], z_window: [14, 20, 50, 100] };
const GRID = FULL ? GRID_FULL : GRID_FAST;

const presetPath = path.join(REPO, `optimized_preset_${ticker}.json`);
const logsDir = path.join(REPO, 'logs', ticker.toLowerCase(), 'history_exported');

// ─── config viva desde Firestore ───
async function buildLiveConfig(): Promise<BacktestConfig> {
  const snap = await db.doc(`asset_configs/${ticker}`).get();
  const d = (snap.data() || {}) as any;
  const sessions: any = {};
  for (const [sess, trigs] of Object.entries<any>(d.sessions || {})) {
    sessions[sess] = {};
    for (const [trig, cfg] of Object.entries<any>(trigs)) {
      if (cfg.enabled === false || (cfg.minScore ?? 0) >= 99) continue;
      sessions[sess][trig] = {
        enabled: true,
        minScore: cfg.minScore ?? 4,
        entryPercent: cfg.entryPercent ?? 100,
        partialClosePct: (cfg.partialClosePct ?? 0.5) > 1 ? (cfg.partialClosePct ?? 0.5) / 100 : (cfg.partialClosePct ?? 0.5),
        slAfterTp1: cfg.slAfterTp1 ?? 'breakeven',
        tp15BeEnabled: cfg.tp15BeEnabled ?? true,
        atrTrailEnabled: cfg.atrTrailEnabled ?? false,
        structuralTrailEnabled: cfg.structuralTrailEnabled ?? false,
      };
    }
  }
  const fixedRR = Number(d.fixedRR ?? 1.5);
  return {
    ticker, entryTrigger: 'SMART',
    minBuyPoints: d.minPointsForBuy ?? 4,
    minSellPoints: d.minPointsForSell ?? 4,
    minRR: Number(d.minRR ?? Math.max(1.0, fixedRR * 0.8)),
    slBufferPercent: d.slBufferPercent ?? 0,
    fixedRR,
    oteEntryPercent: d.oteEntryPercent ?? 50,
    sessions,
  } as BacktestConfig;
}

function writeBlocks(blocksByTf: Record<string, Blocks>) {
  // 🛡️ MERGE sobre el archivo original: preserva Risk/Scoring/Meta y cualquier otra
  // clave. Antes se escribía SOLO bloques → un kill a mitad del sweep dejaba el preset
  // mutilado (pitfall real 22-sep). El finally/handlers igual restauran.
  const prev: any = fs.existsSync(presetPath) ? JSON.parse(fs.readFileSync(presetPath, 'utf8')) : {};
  const preset: any = { ...prev };
  for (const tf of TF_KEYS) {
    const b = blocksByTf[tf];
    if (b && Object.keys(b).length) preset[PRESET_TF[tf]] = b;
  }
  fs.writeFileSync(presetPath, JSON.stringify(preset, null, 2));
}

// exporta con export_smc_csv.ts y lee los CSVs como strings crudos (igual que el worker)
function exportAndLoad(): Map<string, string[]> {
  const npx = '/root/.nvm/versions/node/v24.19.0/bin/npx';
  // stdio: stdout ignorado — export_smc_csv spamea [SMC-ENGINE] por vela (>1MB) y
  // con pipe revienta ENOBUFS. stderr sí se captura para diagnóstico.
  execFileSync(npx, ['tsx', path.join(REPO, 'scripts/export_smc_csv.ts'), ticker],
    { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'], timeout: 20 * 60 * 1000, env: { ...process.env, PATH: '/root/.nvm/versions/node/v24.19.0/bin:' + process.env.PATH } });
  const logs = new Map<string, string[]>();
  for (const [tfKey, tfName] of Object.entries(TF_FILES)) {
    const fp = path.join(logsDir, `pine-logs-SMC Master_${tfName}.csv`);
    if (!fs.existsSync(fp)) { console.warn(`⚠ sin ${fp}`); continue; }
    const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
    const entries: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('Fecha,')) continue;
      let logLine: string;
      const m = line.match(/^"[^"]*","(.*)"$/);
      if (m) logLine = m[1].trim();
      else { const parts = line.split(/,(.+)/); if (parts.length < 2) continue; logLine = parts[1].trim().replace(/^"|"$/g, ''); }
      if (!logLine.includes(' | TS: ')) continue;
      if (!logLine.match(/TS:\s*(\d+)/i)) continue;
      entries.push(logLine);
    }
    logs.set(tfKey, entries);
  }
  return logs;
}

interface Metrics { trades: number; wins: number; wr: number; pf: number; exp: number; maxDD: number; maxAbsR: number; }
function computeMetrics(trades: any[]): Metrics {
  const rs = trades.map((t: any) => Number(t.rMultiple ?? 0));
  const wins = trades.filter((t: any) => t.result === 'WIN').length;
  const grossWin = rs.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rs.filter(r => r < 0).reduce((a, b) => a + b, 0));
  let cum = 0, peak = 0, maxDD = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  return { trades: trades.length, wins, wr: trades.length ? wins / trades.length : 0,
    pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0),
    exp: trades.length ? cum / trades.length : 0, maxDD,
    maxAbsR: rs.reduce((m, r) => Math.max(m, Math.abs(r)), 0) };
}

// 🛡️ Guard anti-artefacto (22-sep): rMultiples absurdos (|R|>10) indican métrica rota
// (caso AUDJPY: trades de 172R — imposibles; bug de pipSize/R en ese activo).
function metricsSane(m: Metrics): boolean { return m.maxAbsR <= 10; }

async function evalBlocks(blocksByTf: Record<string, Blocks>, config: BacktestConfig): Promise<Metrics> {
  writeBlocks(blocksByTf);
  const logs = exportAndLoad();
  const prepared = await prepareEntries(logs);
  const res = runBacktest(logs as Map<string, (string | any)[]>, config, undefined, prepared);
  return computeMetrics(res.trades || []);
}

function objective(m: Metrics): number {
  return m.trades < MIN_TRADES ? m.exp - (MIN_TRADES - m.trades) * 0.05 : m.exp;
}

async function main() {
  console.log(`🏭 BRUTEFORCER 2.0 — ${ticker} — grilla ${FULL ? 'FULL (81/TF)' : 'fast (16/TF)'} — generador canónico export_smc_csv`);
  if (!fs.existsSync(presetPath)) fs.writeFileSync(presetPath, '{}');
  const original = fs.readFileSync(presetPath, 'utf8');

  // bloques actuales
  const cur: Record<string, Blocks> = {};
  try {
    const p = JSON.parse(original);
    for (const tf of TF_KEYS) if (p[PRESET_TF[tf]]) cur[tf] = p[PRESET_TF[tf]];
  } catch {}

  const config = await buildLiveConfig();
  // 🛡️ Blindaje anti-kill (22-sep): kills de tests dejaron el preset con una variante a
  // medio probar. Handlers para SIGINT/SIGTERM + exit restauran el original
  // (SIGKILL no se puede atrapar, pero systemd/timeout matan con SIGTERM primero).
  const restore = () => {
    try { fs.writeFileSync(presetPath, original); } catch {}
  };
  process.on('SIGINT', () => { restore(); process.exit(130); });
  process.on('SIGTERM', () => { restore(); process.exit(143); });
  process.on('exit', restore);
  try {
    console.log('  evaluando BASELINE (bloques actuales)…');
    const baseMetrics = await evalBlocks(cur, config);
    console.log(`  BASELINE: trades=${baseMetrics.trades} wr=${(baseMetrics.wr * 100).toFixed(1)}% PF=${baseMetrics.pf.toFixed(2)} exp=${baseMetrics.exp.toFixed(3)}R/t maxDD=${baseMetrics.maxDD.toFixed(1)}R`);

    const best: Record<string, Blocks> = { ...cur };
    const t0 = Date.now();
    for (const tf of TF_KEYS) {
      let bestMetric = -Infinity;
      const combos: Blocks[] = [];
      for (const p of GRID.pivot_len) for (const w of GRID.wick_pct) for (const d of GRID.div_len) for (const z of GRID.z_window)
        combos.push({ pivot_len: p, wick_pct: w, div_len: d, z_window: z });
      for (const variant of combos) {
        const trial = { ...best, [tf]: variant };
        const m = await evalBlocks(trial, config);
        const obj = objective(m);
        if (obj > bestMetric) {
          bestMetric = obj;
          best[tf] = variant;
          console.log(`  TF ${tf}: mejor ${variant.pivot_len}/${variant.wick_pct}/${variant.div_len}/${variant.z_window} → trades=${m.trades} exp=${m.exp.toFixed(3)}R/t (obj=${obj.toFixed(3)})`);
        }
      }
    }

    const propMetrics = await evalBlocks(best, config);
    const sane = metricsSane(propMetrics) && metricsSane(baseMetrics);
    const better = sane && propMetrics.trades >= MIN_TRADES
      && propMetrics.exp >= baseMetrics.exp + 0.05
      && propMetrics.maxDD <= baseMetrics.maxDD * 1.3 + 0.5;
    const verdict = better ? 'RECOMMEND' : 'HOLD';

    const out = {
      ticker, generatedAt: new Date().toISOString(),
      engine: 'motor-TS canónico (export_smc_csv) — mismo mundo que el refresh semanal',
      baseline: { blocks: cur, metrics: baseMetrics },
      proposal: { blocks: best, metrics: propMetrics },
      verdict,
      reason: better ? `mejora ≥+0.05R/t con ≥${MIN_TRADES} trades y DD controlada`
        : (propMetrics.trades < MIN_TRADES ? `pocos trades (${propMetrics.trades}<${MIN_TRADES})` : 'sin mejora suficiente vs baseline'),
      elapsedSec: Math.round((Date.now() - t0) / 1000),
    };
    const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(REPO, `optimized_preset_${ticker}_tfproposal.json`);
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`\n🏁 ${ticker}: ${verdict} | baseline exp=${baseMetrics.exp.toFixed(3)} → propuesta exp=${propMetrics.exp.toFixed(3)}R/t | ${outPath}`);
  } finally {
    fs.writeFileSync(presetPath, original); // restaurar SIEMPRE el preset original
    // Y re-exportar con los bloques originales: el sweep deja los pine-logs de
    // history_exported con la ÚLTIMA variante probada → devolverlos al baseline
    // (los consume el hyperopt semanal hasta el próximo refresh).
    try {
      exportAndLoad();
      console.log('♻️ preset original restaurado + pine-logs re-exportados al baseline');
    } catch (e: any) {
      console.error(`⚠️ no se pudo re-exportar el baseline (${e?.message}) — correr export_smc_csv manual o esperar el refresh semanal`);
    }
  }
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
