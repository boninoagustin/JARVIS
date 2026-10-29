// directional_mcl_tune.ts — sweep dominical del MCL direccional por sesión.
// (sep-2026, opción 2 de Bon): para cada activo y cada sesión CON trades en la ventana,
// barre maxBuyLosses y maxSellLosses ∈ {0,1,2} (coordinate ascent por dirección, todo lo
// demás en su valor actual) usando el motor real con los gates direccionales portados.
// Misma restricción de cuenta prop que killswitch_tune: descarta configs cuyo peor día
// supere PROP_MAX_DAY_LOSS_R.
// Escribe a Firestore CON dot-paths (update) para NO clobberear otros campos de la sesión,
// con source='directional_mcl_tune'. NO toca gatillos (enabled/minScore/etc.).
// Nota de paridad: el check MCL del vivo (y del backtest portado) lee SOLO
// sessions[currentSession] — el valor en 'ALL' es config muerta y este sweep no lo usa.
import fs from 'fs';
import path from 'path';
import { runBacktest, prepareEntries } from '/opt/JARVIS/jarvis-os/src/services/backtestEngine.js';
import admin from 'firebase-admin';
import {parseSelectionArgs, readAssetSnapshot, selectionEntries, selectionReplayOptions, selectionManifest, readSelectionConfig, completedSelectionTrades, loadSelectionLogs, saveSelection} from './periodic_opt/selection_context.js';

const selection = parseSelectionArgs();
const manifest = selectionManifest(selection);
if (selection.configFile && !selection.dryRun) throw new Error('config-file requires --dry-run');

const LOGS_ROOT = '/opt/JARVIS/logs';
const tfNum = { 'M5': '5', 'M15': '15', 'H1': '60', 'H4': '240', 'D1': 'D' };
const PROP_MAX_DAY_LOSS_R = 4; // igual que killswitch_tune (límite diario prop con buffer)
const MCL_VALUES = [0, 1, 2];  // 0 = apagado
const SESSIONS = ['ASIA', 'LONDON', 'NY', 'OFF'];

function loadLogs(ticker: string, tfs: string[]) {
  return loadSelectionLogs(selection);
}
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
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const d = tradingDay(t.closeTimestamp ?? t.timestamp);
    byDay.set(d, (byDay.get(d) ?? 0) + (t.rMultiple ?? 0));
  }
  let worstDay = 0;
  for (const v of byDay.values()) if (v < worstDay) worstDay = v;
  return { n, wr: n ? (wins / n) * 100 : 0, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), pnl, mdd, worstDay, score: mdd > 0 ? pnl / mdd : pnl };
}

function fmt(m: any) {
  return `PnL=${m.pnl.toFixed(1)}R DD=${m.mdd.toFixed(1)}R PF=${m.pf.toFixed(2)} n=${m.n} peorDia=${m.worstDay.toFixed(2)}R`;
}

const arg = process.argv[2] || 'all';
const ASSETS = arg === 'all'
  ? ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40', 'JP225']
  : arg.split(',').map(s => s.trim().toUpperCase());

for (const ticker of ASSETS) {
  const current = await readAssetSnapshot(selection);
  const logs = loadLogs(ticker, ['M5', 'M15', 'H1', 'H4', 'D1']);
  if (logs.size === 0) { console.log(`=== ${ticker} === SIN LOGS → skip`); continue; }
  const prepared = selectionEntries(await prepareEntries(logs), manifest, selection);
  const replayOptions = selectionReplayOptions(selection, manifest);

  const base: any = readSelectionConfig(selection, current);

  // Sesiones CON actividad: las que tienen trades en la corrida base (btSession del port)
  const baseTrades = completedSelectionTrades(runBacktest(logs, { ...base, sessions: JSON.parse(JSON.stringify(base.sessions)) }, undefined, prepared, replayOptions).trades, manifest, prepared);
  const activeSessions = new Set<string>();
  for (const t of baseTrades) {
    const s = String((t as any).btSession ?? '').split('-').pop();
    if (s && SESSIONS.includes(s)) activeSessions.add(s);
  }

  const updates: Record<string, number> = {};
  console.log(`=== ${ticker} === (sesiones con trades: ${[...activeSessions].join(',') || 'ninguna'})`);

  for (const sess of SESSIONS) {
    const sessCfg = base.sessions?.[sess] || {};
    const hasActivity = activeSessions.has(sess);
    // Solo barrer sesiones con actividad; las demás conservan su valor actual (o quedan 0).
    if (!hasActivity) continue;

    for (const dir of ['BUY', 'SELL'] as const) {
      const field = dir === 'BUY' ? 'maxBuyLosses' : 'maxSellLosses';
      const curVal = typeof sessCfg[field] === 'number' ? sessCfg[field] : 0;
      let bestVal = curVal, bestScore = -Infinity, bestM: any = null;
      // 🛡️ Desempate prop-safe: en empate (EPS) se prefiere el valor MÁS protector (mayor).
      const EPS = 0.02;

      for (const v of MCL_VALUES) {
        const cfg: any = { ...base, sessions: JSON.parse(JSON.stringify(base.sessions)) };
        cfg.sessions[sess] = cfg.sessions[sess] || {};
        if (v === 0) delete cfg.sessions[sess][field]; // apagado = campo ausente (semántica del motor)
        else cfg.sessions[sess][field] = v;
        const mm = metrics(completedSelectionTrades(runBacktest(logs, cfg, undefined, prepared, replayOptions).trades, manifest, prepared));
        if (mm.worstDay < -PROP_MAX_DAY_LOSS_R) continue; // 🛡️ viola límite prop
        const better = mm.score > bestScore + EPS;
        const equivalent = Math.abs(mm.score - bestScore) <= EPS;
        if (better || (equivalent && v > bestVal)) {
          bestScore = mm.score; bestVal = v; bestM = mm;
        }
      }

      const changed = bestVal !== curVal;
      updates[`sessions.${sess}.${field}`] = bestVal;
      if (bestM) {
        console.log(`  ${sess} ${dir}: ${field} ${curVal}→${bestVal}${changed ? ' ⚡' : ''} (${fmt(bestM)}, score=${bestScore.toFixed(2)})`);
      }
    }
  }

  const proposal = {ticker, updates, selection_partition:'train', evaluation_manifest:manifest};
  saveSelection(selection, proposal);
  console.log(JSON.stringify(proposal));
  // Escribir con dot-paths (update) para NO clobberearear el resto de la sesión.
  if (Object.keys(updates).length > 0) {
    if (process.argv.includes('--dry-run')) {
      console.log(`[DRY-RUN] directional_mcl_tune ${ticker}: NO escribe a Firestore (congelado). ${Object.keys(updates).join(', ')}`);
    } else {
      await admin.firestore().doc(`asset_configs/${ticker}`).update({
        ...updates,
        updatedAt: new Date().toISOString(),
        source: 'directional_mcl_tune',
      });
    }
    console.log(`  ✓ aplicado: ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  } else {
    console.log('  (sin sesiones activas — nada que barrer)');
  }
}
console.log('\nDONE');
process.exit(0);
