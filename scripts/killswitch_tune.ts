// killswitch_tune.ts — sweep dominical de killswitches diarios por activo.
// v2 (sep-2026): grilla extendida en 2 etapas + restricción dura de cuenta prop.
//   Etapa 1: maxDailyLossR × maxConsecutiveLosses (como antes).
//   Etapa 2: maxTradesPerDay × trailingDrawdownR (fijando lo mejor de la etapa 1).
//   Restricción Funding Pips: rechaza configs cuyo peor DÍA (suma de R cerrados,
//   día de trading anclado 17:00 ART, igual que el motor) supere PROP_MAX_DAY_LOSS_R.
//   Con ~1% de riesgo por trade, el límite diario de prop (5%) ≈ 5R; el cap en 4R
//   deja buffer de ~1R por slippage/spread y por trades solapados.
// Escribe a Firestore asset_configs/{ticker} (merge, source='killswitch_tune') — el
// mismo patrón de auto-aplicación del dominical para killswitches (no toca gatillos).
import fs from 'fs';
import path from 'path';
import { runBacktest, prepareEntries } from '/opt/JARVIS/jarvis-os/src/services/backtestEngine.js';
import admin from 'firebase-admin';

const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const LOGS_ROOT = '/opt/JARVIS/logs';
const tfNum = { 'M5': '5', 'M15': '15', 'H1': '60', 'H4': '240', 'D1': 'D' };

// 🛡️ RESTRICCIÓN DE CUENTA PROP (Funding Pips): ningún día puede perder más que esto.
// El límite diario de Funding Pips es 5%; con riesgo ~1% por trade = ~5R de techo,
// 4R deja margen de seguridad. NO bajar sin OK de Bon.
const PROP_MAX_DAY_LOSS_R = 4;

// Grillas. 0 = gate apagado.
const DLR = [0, 1, 1.5, 2, 2.5, 3, 4];        // maxDailyLossR (sin 5: tocaría el límite prop)
const MCL = [0, 2, 3, 4, 5, 6];               // maxConsecutiveLosses
const MTD = [0, 4, 6, 8, 10];                 // maxTradesPerDay
const TDDR = [0, 2, 3, 4, 5];                 // trailingDrawdownR

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

// Día de trading igual que el motor (anclado 17:00 ART — convención FX).
function tradingDay(ts: number): string {
  return new Date(ts - 3 * 3600e3 - 17 * 3600e3).toISOString().split('T')[0];
}

function metrics(trades: any[]) {
  const n = trades.length;
  const wins = trades.filter(t => (t.rMultiple ?? 0) > 0).length;
  const pnl = trades.reduce((s, t) => s + (t.rMultiple ?? 0), 0);
  const gp = trades.reduce((s, t) => s + Math.max(0, t.rMultiple ?? 0), 0);
  const gl = trades.reduce((s, t) => s + Math.max(0, -(t.rMultiple ?? 0)), 0);
  let eq = 0, peak = 0, mdd = 0;
  for (const t of trades) { eq += (t.rMultiple ?? 0); if (eq > peak) peak = eq; mdd = Math.max(mdd, peak - eq); }
  // Peor día: suma de R cerrados por día de trading (usa closeTimestamp, igual que el motor).
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const d = tradingDay(t.closeTimestamp ?? t.timestamp);
    byDay.set(d, (byDay.get(d) ?? 0) + (t.rMultiple ?? 0));
  }
  let worstDay = 0, worstDayStr = '';
  for (const [d, v] of byDay) if (v < worstDay) { worstDay = v; worstDayStr = d; }
  return { n, wr: n ? (wins / n) * 100 : 0, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), pnl, mdd, worstDay, worstDayStr, score: mdd > 0 ? pnl / mdd : pnl };
}

function fmt(m: any) {
  return `PnL=${m.pnl.toFixed(1)}R DD=${m.mdd.toFixed(1)}R PF=${m.pf.toFixed(2)} WR=${m.wr.toFixed(0)}% n=${m.n} peorDia=${m.worstDay.toFixed(2)}R (${m.worstDayStr})`;
}

const arg = process.argv[2] || 'all';
const ASSETS = arg === 'all'
  ? ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40', 'JP225']
  : arg.split(',').map(s => s.trim().toUpperCase());

for (const ticker of ASSETS) {
  const current = (await db.doc(`asset_configs/${ticker}`).get()).data() || {};
  const logs = loadLogs(ticker, ['M5', 'M15', 'H1', 'H4', 'D1']);
  if (logs.size === 0) { console.log(`=== ${ticker} === SIN LOGS → skip`); continue; }
  const prepared = await prepareEntries(logs);
  const base = {
    ticker, entryTrigger: 'SMART', minBuyPoints: 4, minSellPoints: 4,
    slBufferPercent: current.slBufferPercent ?? 0.1, fixedRR: current.fixedRR ?? 2.0, oteEntryPercent: current.oteEntryPercent ?? 50,
    sessions: current.sessions || {}, spreadPips: 0.1, commissionPerLot: 3.0, tp1StructuralMinRR: 1.2,
  } as any;

  const baseM = metrics(runBacktest(logs, { ...base }, undefined, prepared).trades);

  // ── Etapa 1: DLR × MCL ──
  // 🛡️ Desempate prop-safe: mejoras reales exigen superar el score por EPS; entre
  // configs equivalentes se prefiere la MÁS PROTECTORA (DLR más bajo, MCL más alto).
  const EPS = 0.02;
  let best: any = null;
  for (const dlr of DLR) {
    for (const mcl of MCL) {
      const cfg = { ...base, maxDailyLossR: dlr || undefined, maxConsecutiveLosses: mcl || undefined };
      const mm = metrics(runBacktest(logs, cfg, undefined, prepared).trades);
      if (mm.worstDay < -PROP_MAX_DAY_LOSS_R) continue; // 🛡️ viola el límite prop → descartar
      if (!best) { best = { dlr, mcl, ...mm }; continue; }
      const better = mm.score > best.score + EPS;
      const equivalent = Math.abs(mm.score - best.score) <= EPS;
      const moreProtective = dlr < best.dlr || (dlr === best.dlr && mcl > best.mcl);
      if (better || (equivalent && moreProtective)) best = { dlr, mcl, ...mm };
    }
  }

  // ── Etapa 2: MTD × TDDR (con lo mejor de la etapa 1 fijo) ──
  let best2: any = null;
  for (const mtd of MTD) {
    for (const tddr of TDDR) {
      const cfg = {
        ...base,
        maxDailyLossR: best.dlr || undefined,
        maxConsecutiveLosses: best.mcl || undefined,
        maxTradesPerDay: mtd || undefined,
        trailingDrawdownR: tddr || undefined,
      };
      const mm = metrics(runBacktest(logs, cfg, undefined, prepared).trades);
      if (mm.worstDay < -PROP_MAX_DAY_LOSS_R) continue; // 🛡️ viola el límite prop → descartar
      if (!best2) { best2 = { mtd, tddr, ...mm }; continue; }
      const better = mm.score > best2.score + EPS;
      const equivalent = Math.abs(mm.score - best2.score) <= EPS;
      const moreProtective = mtd < best2.mtd || (mtd === best2.mtd && tddr < best2.tddr);
      if (better || (equivalent && moreProtective)) best2 = { mtd, tddr, ...mm };
    }
  }

  // Escribir a Firestore (mismo patrón que la v1: merge, source='killswitch_tune').
  // NO toca gatillos de sesión — solo los 4 límites diarios top-level.
  if (process.argv.includes('--dry-run')) {
    console.log(`[DRY-RUN] killswitch_tune ${ticker}: NO escribe a Firestore (congelado). maxDLR=${best.dlr} maxCL=${best.mcl} maxTPD=${best2.mtd} maxTDD=${best2.tddr}`);
  } else {
    await db.doc(`asset_configs/${ticker}`).set(
      {
        maxDailyLossR: best.dlr,
        maxConsecutiveLosses: best.mcl,
        maxTradesPerDay: best2.mtd,
        trailingDrawdownR: best2.tddr,
        updatedAt: new Date().toISOString(),
        source: 'killswitch_tune',
      },
      { merge: true }
    );
  }

  console.log(`=== ${ticker} ===`);
  console.log(`  base            : ${fmt(baseM)}`);
  console.log(`  BEST maxDLR=${best.dlr} maxCL=${best.mcl} : ${fmt(best)}  (score=${best.score.toFixed(2)})`);
  console.log(`  BEST2 maxTPD=${best2.mtd} maxTDD=${best2.tddr} : ${fmt(best2)}  (score=${best2.score.toFixed(2)})`);
}
console.log('\nDONE');
process.exit(0);
