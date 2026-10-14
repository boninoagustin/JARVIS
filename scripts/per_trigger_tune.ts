/**
 * per_trigger_tune.ts — Auto-Tune por gatillo/sesión, headless.
 *
 * Lee los gatillos habilitados de asset_configs/{ticker} en Firestore, corre un GA
 * por cada (sesión, gatillo) en paralelo, arma la config completa por gatillo y la
 * escribe de vuelta a Firestore preservando los demás campos (killswitches, etc.).
 * Al final corre UN backtest full-fidelity con la config ensamblada para reportar
 * las métricas finales (con killswitches).
 *
 * Uso: npx tsx scripts/per_trigger_tune.ts XAUUSD [--budget 300] [--concurrency 4]
 *        [--dry-run] [--sessions LONDON,NY]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine.js';
import { geneticSearch, type TriggerGenome } from '../jarvis-os/src/services/optimizer.js';
import type { LogEntry } from '../jarvis-os/src/services/backtestTypes.js';
import admin from 'firebase-admin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_ROOT = path.join(__dirname, '..', 'logs');

const ALL_SESSIONS = ['OFF', 'LONDON', 'NY', 'ASIA'];
const ALL_TRIGGERS = ['choch5m', 'bos5m', 'oteChoch5m', 'oteBos5m', 'choch15m', 'bos15m', 'oteChoch15m', 'oteBos15m'];
// 🛡️ sep-2026: gatillos 15m RETIRADOS (A/B temporalidades: solo-5M +94% PnL, solo-15M −37%).
// El tune los excluye SIEMPRE para no reactivarlos (el domingo solo tunea 5m).
const DISABLED_15M = ['choch15m', 'bos15m', 'oteChoch15m', 'oteBos15m'];

function loadLogs(ticker: string, tfs: string[]): Map<string, string[]> {
  const tickerDir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
  if (!fs.existsSync(tickerDir)) throw new Error(`No existe: ${tickerDir}`);
  const logs = new Map<string, string[]>();
  const tfNum: Record<string, string> = { 'M5': '5', 'M15': '15', 'H1': '60', 'H4': '240', 'D1': 'D' };
  for (const tf of tfs) {
    const candidates = [
      path.join(tickerDir, `pine-logs-SMC Master_${tf}.csv`),
      path.join(tickerDir, `pine-logs-SMC Master_${tf.toUpperCase()}.csv`),
    ];
    const alt = tfNum[tf];
    const all = alt ? candidates.concat([path.join(tickerDir, `pine-logs-SMC Master_${alt}.csv`)]) : candidates;
    const found = all.find(c => fs.existsSync(c));
    if (!found) continue;
    logs.set(tf, fs.readFileSync(found, 'utf8').split('\n').filter(l => l.trim().length > 0));
  }
  return logs;
}

function parseArgs(argv: string[]) {
  const args: Record<string, any> = { ticker: null, budget: 300, concurrency: 4, dryRun: false, sessions: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--budget') args.budget = parseInt(argv[++i], 10);
    else if (a === '--concurrency') args.concurrency = parseInt(argv[++i], 10);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--sessions') args.sessions = argv[++i].split(',').map((s: string) => s.trim());
    else if (a === '--save') args.save = argv[++i];
    else if (!args.ticker) args.ticker = a.toUpperCase();
  }
  if (!args.ticker) { console.error('Uso: per_trigger_tune.ts <TICKER> [--budget N] [--concurrency N] [--dry-run] [--sessions LONDON,NY]'); process.exit(1); }
  return args;
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const { ticker, budget, concurrency, dryRun, sessions: sessionFilter } = argv;

  // Firebase
  const sa = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'service-account.json'), 'utf8'));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  // Cargar logs + preparar (una sola vez)
  const t0 = Date.now();
  const logs = loadLogs(ticker, ['M5', 'M15', 'H1', 'H4', 'D1']);
  const prepared: LogEntry[] = await prepareEntries(logs);
  console.error(`[tune] ${ticker}: ${prepared.length} eventos preparados en ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Leer config actual de Firestore
  const docSnap = await db.doc(`asset_configs/${ticker}`).get();
  const current = docSnap.exists ? (docSnap.data() as any) : {};
  const currentSessions: Record<string, any> = current.sessions || {};

  // Construir lista de tareas (gatillos habilitados)
  const tasks: { sessionKey: string; triggerKey: string }[] = [];
  const seen = new Set<string>();
  const push = (s: string, t: string) => {
    const k = `${s}/${t}`;
    if (seen.has(k)) return;
    seen.add(k);
    tasks.push({ sessionKey: s, triggerKey: t });
  };

  // 1) Gatillos explícitamente habilitados en Firestore (solo sesiones reales)
  for (const s of Object.keys(currentSessions)) {
    if (!ALL_SESSIONS.includes(s)) continue; // 🔧 saltar 'ALL' (capa base, no es una sesión de trading)
    if (sessionFilter && !sessionFilter.includes(s)) continue;
    const trigs = currentSessions[s] || {};
    for (const t of Object.keys(trigs)) {
      if (trigs[t] && typeof trigs[t] === 'object' && trigs[t].enabled === true && !DISABLED_15M.includes(t)) push(s, t);
    }
  }
  // 2) Si no hay ninguno habilitado, usar default conservador (5m en todas las sesiones)
  if (tasks.length === 0) {
    console.error('[tune] ⚠️ No hay gatillos habilitados en Firestore → usando default 5m × 4 sesiones');
    for (const s of sessionFilter || ALL_SESSIONS) {
      for (const t of ['choch5m', 'bos5m', 'oteChoch5m', 'oteBos5m']) push(s, t);
    }
  }

  console.error(`[tune] ${tasks.length} gatillos a optimizar (budget=${budget}, concurrency=${concurrency})`);

  // Función de evaluación (misma que backtest_optimize_server.ts)
  // 🛡️ sep-2026: guard de muestra mínima — si un gatillo tiene < MIN_TRADES trades en
  // aislamiento, el GA no tiene señal (fitness plano) y su genoma es ruido: se descarta
  // en el ensamblado (se conserva la config vigente del gatillo).
  const MIN_TRADES = 5;
  const tradeCounts = new Map<string, number>();
  const evaluate = (sessionKey: string, triggerKey: string) => (genome: TriggerGenome): number => {
    const sessions: Record<string, any> = {};
    for (const s of ALL_SESSIONS) {
      sessions[s] = {};
      for (const t of ALL_TRIGGERS) sessions[s][t] = { enabled: false };
    }
    if (!sessions[sessionKey]) sessions[sessionKey] = {};
    sessions[sessionKey][triggerKey] = {
      enabled: true,
      minScore: genome.minScore,
      slBuff: genome.slBuff,
      tp2: genome.tp2,
      partialClosePct: genome.partialClosePct,
      slAfterTp1: genome.slAfterTp1,
      tp15BeEnabled: genome.tp15BeEnabled,
      atrTrailEnabled: genome.atrTrailEnabled,
      structuralTrailEnabled: genome.structuralTrailEnabled,
      minimal_roi: genome.minimal_roi || undefined,
      entryPercent: genome.entryPercent,
      tp1StructuralMinRR: 1.2,
    };
    const configToRun: any = {
      ticker, entryTrigger: 'SMART',
      minBuyPoints: 4, minSellPoints: 4, slBufferPercent: 0.1, fixedRR: 2.0, oteEntryPercent: 50,
      sessions, sessionFilter: [sessionKey], enabled: true,
      spreadPips: 0.1, commissionPerLot: 3.0, tp1StructuralMinRR: 1.2,
    };
    const res = runBacktest(logs, configToRun, undefined, prepared);
    let pnlR = 0, wins = 0, totalTrades = 0;
    for (const t of res.trades) {
      if (t.triggerType === triggerKey && (t.points || 0) >= genome.minScore) {
        if (t.rMultiple !== undefined && !Number.isNaN(t.rMultiple)) {
          pnlR += t.rMultiple; totalTrades++;
          if (t.rMultiple > 0) wins++;
        }
      }
    }
    tradeCounts.set(`${sessionKey}/${triggerKey}`, totalTrades);
    if (totalTrades < MIN_TRADES) return -1000 + totalTrades;
    return pnlR + (totalTrades > 0 ? wins / totalTrades : 0) * 0.001;
  };

  // Pool con concurrencia limitada
  const results: Record<string, { genome: TriggerGenome; fitness: number; evaluated: number; pnlR: number; trades: number }> = {};
  let idx = 0;
  const worker = async () => {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      const { sessionKey, triggerKey } = task;
      const tStart = Date.now();
      const r = await geneticSearch({ evaluate: evaluate(sessionKey, triggerKey), budget, seed: 42, populationSize: 24, maxGenerations: 20, elite: 2, tournamentK: 3, mutationRate: 0.15, earlyStopGens: 6 });
      // re-evaluar el best para pnl/trades reales
      const bestFitness = evaluate(sessionKey, triggerKey)(r.best);
      results[`${sessionKey}/${triggerKey}`] = { genome: r.best, fitness: bestFitness, evaluated: r.evaluated, pnlR: 0, trades: 0 };
      console.error(`[tune] ${sessionKey}/${triggerKey}: ${r.evaluated} evals en ${((Date.now() - tStart) / 1000).toFixed(1)}s → minScore=${r.best.minScore} tp2=${r.best.tp2} partialClose=${r.best.partialClosePct} slAfterTp1=${r.best.slAfterTp1} trails=${r.best.atrTrailEnabled}/${r.best.structuralTrailEnabled} (fitness=${bestFitness.toFixed(2)})`);
    }
  };
  const pool = Array.from({ length: concurrency }, worker);
  await Promise.all(pool);

  // Ensamblar config completa
  const newSessions: Record<string, any> = JSON.parse(JSON.stringify(currentSessions));
  for (const s of ALL_SESSIONS) if (!newSessions[s]) newSessions[s] = {};
  for (const [key, r] of Object.entries(results)) {
    const [sessionKey, triggerKey] = key.split('/');
    // 🛡️ guard de muestra mínima: si el gatillo aislado no junta MIN_TRADES trades,
    // el GA trabajó sobre fitness plano → se descarta el genoma (ruido) y se conserva
    // la config vigente del gatillo.
    const nTrades = tradeCounts.get(key) ?? 0;
    if (nTrades < MIN_TRADES) {
      console.error(`[tune] ⏭️ ${sessionKey}/${triggerKey}: solo ${nTrades} trades en aislamiento (< ${MIN_TRADES}) → se conserva la config vigente`);
      continue;
    }
    if (!newSessions[sessionKey][triggerKey]) newSessions[sessionKey][triggerKey] = { enabled: true };
    const g = r.genome;
    const tgt = newSessions[sessionKey][triggerKey];
    tgt.enabled = true;
    tgt.minScore = g.minScore;
    tgt.slBuff = g.slBuff;
    tgt.tp2 = g.tp2;
    tgt.partialClosePct = g.partialClosePct;
    tgt.slAfterTp1 = g.slAfterTp1;
    tgt.tp15BeEnabled = g.tp15BeEnabled;
    tgt.atrTrailEnabled = g.atrTrailEnabled;
    tgt.structuralTrailEnabled = g.structuralTrailEnabled;
    tgt.entryPercent = g.entryPercent;
    // 🔧 FIX: Firestore no acepta undefined. ROI off → eliminar la clave (no dejar undefined).
    if (g.minimal_roi) tgt.minimal_roi = g.minimal_roi;
    else delete tgt.minimal_roi;
  }

  // Backtest final full-fidelity con la config ensamblada + killswitches de producción
  const finalConfig: any = {
    ticker, entryTrigger: current.entryTrigger || 'SMART',
    minBuyPoints: current.minPointsForBuy ?? 4, minSellPoints: current.minPointsForSell ?? 4,
    slBufferPercent: current.slBufferPercent ?? 0.1, fixedRR: current.fixedRR ?? 2.0, oteEntryPercent: current.oteEntryPercent ?? 50,
    sessions: newSessions,
    maxDailyLossR: current.maxDailyLossR || undefined,
    dailyProfitTargetR: current.dailyProfitTargetR || undefined,
    maxConsecutiveLosses: current.maxConsecutiveLosses || undefined,
    maxTradesPerDay: current.maxTradesPerDay || undefined,
    trailingDrawdownR: current.trailingDrawdownR || undefined,
    enabled: current.enabled ?? true,
    spreadPips: 0.1, commissionPerLot: 3.0, tp1StructuralMinRR: 1.2,
  };
  const finalRes = runBacktest(logs, finalConfig, undefined, prepared);
  const ft = finalRes.trades;
  const fw = ft.filter(t => (t.rMultiple ?? 0) > 0).length;
  const fl = ft.filter(t => (t.rMultiple ?? 0) < 0).length;
  const fpnl = ft.reduce((s, t) => s + (t.rMultiple ?? 0), 0);
  let peak = 0, eq = 0, mdd = 0;
  for (const t of ft) { eq += (t.rMultiple ?? 0); if (eq > peak) peak = eq; mdd = Math.max(mdd, peak - eq); }
  const fwr = ft.length ? (fw / ft.length) * 100 : 0;
  const fpf = ft.reduce((s, t) => s + Math.max(0, t.rMultiple ?? 0), 0) / Math.max(0.0001, ft.reduce((s, t) => s + Math.max(0, -(t.rMultiple ?? 0)), 0));
  console.error(`\n[tune] 📊 MÉTRICAS FINALES (config ensamblada, full-fidelity):`);
  console.error(`  trades=${ft.length}  WR=${fwr.toFixed(1)}%  PF=${fpf.toFixed(2)}  PnL=${fpnl.toFixed(1)}R  MaxDD=${mdd.toFixed(2)}R`);

  // Guardar config localmente (si se pidió) para inspección/resumen sin re-optimizar
  if (argv.save) {
    fs.writeFileSync(path.resolve(argv.save), JSON.stringify({ ticker, sessions: newSessions, final: { trades: ft.length, winRate: fwr, profitFactor: fpf, pnlR: fpnl, maxDD: mdd } }, null, 2));
    console.error(`[tune] 💾 config guardada en ${argv.save}`);
  }

  // Escribir a Firestore
  const payload = {
    sessions: newSessions,
    updatedAt: new Date().toISOString(),
    source: 'per_trigger_tune',
  };
  if (dryRun) {
    console.error('[tune] DRY-RUN: no se escribió a Firestore.');
    console.log(JSON.stringify({ ticker, optimized: results, sessions: newSessions, final: { trades: ft.length, winRate: fwr, profitFactor: fpf, pnlR: fpnl, maxDD: mdd } }, null, 2));
  } else {
    await db.doc(`asset_configs/${ticker}`).set(payload, { merge: true });
    console.error(`[tune] ✅ Escrito a asset_configs/${ticker} (merge, ${Object.keys(results).length} gatillos)`);
    console.log(JSON.stringify({ ticker, optimizedCount: Object.keys(results).length, final: { trades: ft.length, winRate: fwr, profitFactor: fpf, pnlR: fpnl, maxDD: mdd } }));
  }
  process.exit(0);
}

main().catch(e => { console.error('[tune] ERROR:', e.message); process.exit(1); });
