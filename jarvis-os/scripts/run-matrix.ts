/**
 * Runner standalone de matriz de gestión de trades (SL/BE/TP1/TP2/parcial/trailing).
 * Uso: tsx scripts/run-matrix.ts [dirLogs]
 * Parsea los CSV una sola vez y corre runBacktest sobre la matriz de configs.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCSV, runBacktest } from '../src/services/backtestEngine';
import type { BacktestConfig, BacktestTrade, LogEntry } from '../src/services/backtestTypes';

const LOGS_DIR = resolve(process.argv[2] ?? '../../logs/eurusd');
const TICKER = process.argv[3] ?? 'EURUSD';

// --- 1. Cargar y parsear logs una sola vez ---
const entries: LogEntry[] = [];
for (const f of readdirSync(LOGS_DIR).filter(f => f.endsWith('.csv'))) {
  const content = readFileSync(join(LOGS_DIR, f), 'utf8');
  const { lines } = parseCSV(content);
  entries.push(...lines);
  console.log(`📄 ${f}: ${lines.length} eventos`);
}
console.log(`Total eventos parseados: ${entries.length}\n`);

const logsMap = new Map<string, LogEntry[]>([['5', entries]]);

// --- 2. Config baseline (defaults de la UI de jarvis-os) ---
const sessionDefaults = (maxSell: number, maxBuy: number) => ({
  choch5m: { enabled: true, minScore: 5 }, choch15m: { enabled: true, minScore: 5 },
  bos5m: { enabled: true, minScore: 10 }, bos15m: { enabled: true, minScore: 10 },
  oteChoch5m: { enabled: true, minScore: 8, entryPercent: 62 }, oteChoch15m: { enabled: true, minScore: 8, entryPercent: 62 },
  oteBos5m: { enabled: true, minScore: 8, entryPercent: 62 }, oteBos15m: { enabled: true, minScore: 8, entryPercent: 62 },
  slBufferPercent: 0.1,
  fixedRR: 2.0,
  maxSellLosses: maxSell,
  maxBuyLosses: maxBuy
});

const baseConfig: BacktestConfig = {
  ticker: TICKER,
  minBuyPoints: 5,
  minSellPoints: 5,
  slBufferPercent: 0.1,
  fixedRR: 2.0,
  oteEntryPercent: 50,
  entryTrigger: 'BOTH',
  sessions: {
    OFF: sessionDefaults(0, 0),
    LONDON: sessionDefaults(1, 1),
    NY: sessionDefaults(2, 2),
    ASIA: sessionDefaults(1, 1)
  }
};

// --- 3. Métricas ---
interface Metrics {
  n: number; winrate: number; ev: number; totalR: number; pf: number; maxDD: number; avgWin: number; avgLoss: number;
}

function computeMetrics(trades: BacktestTrade[]): Metrics {
  const closed = trades.filter(t => t.rMultiple !== undefined && !Number.isNaN(t.rMultiple));
  const n = closed.length;
  const wins = closed.filter(t => t.rMultiple! > 0.05);
  const losses = closed.filter(t => t.rMultiple! < -0.05);
  const grossW = wins.reduce((s, t) => s + t.rMultiple!, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.rMultiple!, 0));
  const totalR = closed.reduce((s, t) => s + t.rMultiple!, 0);
  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...closed].sort((a, b) => (a.closeTimestamp ?? a.timestamp) - (b.closeTimestamp ?? b.timestamp));
  for (const t of sorted) {
    cum += t.rMultiple!;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  return {
    n,
    winrate: n ? (wins.length / n) * 100 : 0,
    ev: n ? totalR / n : 0,
    totalR,
    pf: grossL > 0 ? grossW / grossL : (grossW > 0 ? Infinity : 0),
    maxDD,
    avgWin: wins.length ? grossW / wins.length : 0,
    avgLoss: losses.length ? grossL / losses.length : 0
  };
}

const isOte = (t: BacktestTrade) => t.events?.some(e => e.includes('OTE_Retracement'));

// --- 4. Configs a comparar ---
// Modo 'full': matriz completa 72 combos (búsqueda por activo).
// Modo default: configs nombradas (segunda pasada EURUSD).
const MODE = process.argv[4] ?? 'named';

interface NamedConfig { name: string; config: Partial<BacktestConfig>; }

const oteBest = { partialClosePct: 0.0, slAfterTp1: 'midpoint' as const, atrTrailEnabled: false, structuralTrailEnabled: true };
const dirBest = { partialClosePct: 0.3, slAfterTp1: 'breakeven' as const, atrTrailEnabled: false, structuralTrailEnabled: false };

let configsToTest: NamedConfig[] = [];

if (MODE === 'full') {
  for (const partial of [0.5, 0.3, 0.0])
    for (const sl of ['midpoint', 'breakeven', 'none'] as const)
      for (const atr of [true, false])
        for (const str of [true, false])
          for (const tp1s of [1.2, 99]) {
            configsToTest.push({
              name: `p=${partial.toFixed(1)} sl=${sl} atr=${atr ? 'on' : 'off'} struct=${str ? 'on' : 'off'} tp1s=${tp1s}`,
              config: { partialClosePct: partial, slAfterTp1: sl, atrTrailEnabled: atr, structuralTrailEnabled: str, tp1StructuralMinRR: tp1s }
            });
          }
} else {
  configsToTest = [
    // Referencias
    { name: 'baseline-produccion (p0.5 mid atrON structON tp1fijo)', config: { tp1StructuralMinRR: 99 } },
    { name: 'mejor-global (p0.3 BE atrOFF structOFF tp1fijo)', config: { partialClosePct: 0.3, slAfterTp1: 'breakeven', atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 99 } },
    // Config combinada elegida
    { name: 'COMBINADA tp1fijo', config: { oteManagement: oteBest, directManagement: dirBest, tp1StructuralMinRR: 99 } },
    { name: 'COMBINADA tp1struct', config: { oteManagement: oteBest, directManagement: dirBest, tp1StructuralMinRR: 1.2 } },
    // Variantes finas sobre la combinada
    { name: 'COMB ote-partial0.15', config: { oteManagement: { ...oteBest, partialClosePct: 0.15 }, directManagement: dirBest, tp1StructuralMinRR: 99 } },
    { name: 'COMB dir-partial0.5', config: { oteManagement: oteBest, directManagement: { ...dirBest, partialClosePct: 0.5 }, tp1StructuralMinRR: 99 } },
    { name: 'COMB ote-slNone', config: { oteManagement: { ...oteBest, slAfterTp1: 'none' }, directManagement: dirBest, tp1StructuralMinRR: 99 } },
    { name: 'COMB ote-slBE', config: { oteManagement: { ...oteBest, slAfterTp1: 'breakeven' }, directManagement: dirBest, tp1StructuralMinRR: 99 } },
    { name: 'COMB ote-tp15off', config: { oteManagement: { ...oteBest, tp15BeEnabled: false }, directManagement: dirBest, tp1StructuralMinRR: 99 } },
    { name: 'COMB dir-structON', config: { oteManagement: oteBest, directManagement: { ...dirBest, structuralTrailEnabled: true }, tp1StructuralMinRR: 99 } },
  ];
}

interface Row {
  name: string;
  all: Metrics; ote: Metrics; direct: Metrics;
}

const rows: Row[] = [];
let runIdx = 0;
for (const { name, config: partialCfg } of configsToTest) {
  runIdx++;
  const config: BacktestConfig = { ...baseConfig, ...partialCfg };
  const t0 = Date.now();
  const result = runBacktest(logsMap, config);
  const oteTrades = result.trades.filter(isOte);
  const directTrades = result.trades.filter(t => !isOte(t));
  rows.push({
    name,
    all: computeMetrics(result.trades),
    ote: computeMetrics(oteTrades),
    direct: computeMetrics(directTrades)
  });
  console.log(`[${runIdx}/${configsToTest.length}] ${name} → trades=${result.trades.length} (${Date.now() - t0}ms)`);
}

// --- 5. Reporte ordenado por EV ---
rows.sort((a, b) => b.all.ev - a.all.ev);

const fmt = (m: Metrics) =>
  `n=${String(m.n).padStart(4)} win%=${m.winrate.toFixed(1).padStart(5)} EV=${m.ev.toFixed(3).padStart(7)} totR=${m.totalR.toFixed(1).padStart(7)} PF=${(m.pf === Infinity ? 'Inf' : m.pf.toFixed(2)).padStart(5)} DD=${m.maxDD.toFixed(1).padStart(6)} avgW=${m.avgWin.toFixed(2).padStart(5)}`;

console.log('\n=== RANKING (ordenado por EV global) ===');
for (const r of rows) {
  console.log(`${r.name}\n   ALL: ${fmt(r.all)}\n   OTE: ${fmt(r.ote)}\n   DIR: ${fmt(r.direct)}`);
}

writeFileSync(join(LOGS_DIR, `matrix-${MODE}-${TICKER}-results.json`), JSON.stringify(rows, null, 2));
console.log(`\nResultados guardados en ${join(LOGS_DIR, `matrix-${MODE}-${TICKER}-results.json`)}`);
