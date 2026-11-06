#!/usr/bin/env tsx
/**
 * Propuesta semanal de APAGADO por evidencia — 05-nov-2026.
 *
 * El auto-disable del semanal (apply_weekly.ts) sólo apaga cuando la PRODUCCIÓN falla el
 * Montecarlo (<80%) y el OOS de producción es negativo durante 2 semanas. No detecta
 * "el activo simplemente pierde en vivo". Este script cubre ese hueco CON UNA PROPUESTA,
 * nunca aplicando: el apagado lo decide el operador (botón del panel / asset_configs).
 *
 * Regla (todas juntas):
 *   - baselineR < 0 en las últimas 4 semanas consecutivas (historial propio en Firestore)
 *   - n_vivo ≥ 20 trades cerrados
 *   - R/tr del vivo < 0
 * → verdict PROPONER_APAGADO
 * Si falta algún requisito → VIGILAR (con el progreso: semanas/4 y trades/20).
 *
 * Uso: npx tsx scripts/ops/shutdown_proposal.ts [--write]
 *      (sin --write sólo imprime la tabla)
 */
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import { isHealthFresh } from './health_freshness_core.js';

const REPO = '/opt/JARVIS';
const WRITE = process.argv.includes('--write');
const MIN_NEG_WEEKS = 4;
const MIN_LIVE_TRADES = 20;
const WEEKS_KEEP = 10;

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

/** Lunes 00:00 UTC de la semana de `ts`. */
function weekStart(ts = Date.now()): string {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7; // 0 = lunes
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

const health = await db.collection('detection_health').get();
const cfgs = await db.collection('asset_configs').get();
const cfgMap = new Map(cfgs.docs.map((d) => [d.id, d.data() as any]));

// R/tr vivo por activo (trades cerrados)
const since = Date.now() - 180 * 864e5;
const journal = await db.collection('trade_journal').where('timestamp', '>=', since).get();
const live = new Map<string, { n: number; sumR: number }>();
for (const d of journal.docs) {
  const t = d.data() as any;
  const r = Number(t.rMultiple);
  if (!t.result || !['WIN', 'LOSS', 'BREAKEVEN'].includes(t.result) || !Number.isFinite(r)) continue;
  const cur = live.get(t.ticker) ?? { n: 0, sumR: 0 };
  cur.n += 1; cur.sumR += r;
  live.set(t.ticker, cur);
}

const week = weekStart();
const rows: Array<{ ticker: string; enabled: boolean; baselineR: number; avgR: number | null; weeksNeg: number; liveN: number; liveAvgR: number | null; verdict: string; note: string }> = [];

for (const doc of health.docs) {
  const ticker = doc.id;
  if (ticker === '_GLOBAL') continue;
  const h = doc.data() as any;
    // H07: health viejo/sin fecha → se trata como SIN_DATOS (no se propone sobre él).
    if (!isHealthFresh(h)) continue;
  const cfg = cfgMap.get(ticker) || {};
  const enabled = cfg.enabled === true && !String(cfg.disabledReason || '').trim();
  const baselineR = Number(h.baselineR);
  const avgR = h.avgR != null ? Number(h.avgR) : (Number.isFinite(Number(h.trades)) && h.trades > 0 ? baselineR / h.trades : null);

  // Historial de baseline semanal (se siembra con la semana actual la primera vez)
  const ref = db.collection('shutdown_proposals').doc(ticker);
  const prev = WRITE ? ((await ref.get()).data() as any) : {};
  const history: Array<{ week: string; baselineR: number }> = Array.isArray(prev?.baselineHistory) ? prev.baselineHistory : [];
  if (WRITE && Number.isFinite(baselineR)) {
    const i = history.findIndex((x) => x.week === week);
    if (i >= 0) history[i].baselineR = Number(baselineR.toFixed(2));
    else history.push({ week, baselineR: Number(baselineR.toFixed(2)) });
  }
  const sorted = history.slice().sort((a, b) => (a.week < b.week ? 1 : -1)); // más reciente primero
  let weeksNeg = 0;
  for (const hw of sorted) {
    if (Number(hw.baselineR) < 0) weeksNeg++;
    else break;
  }

  const l = live.get(ticker) ?? { n: 0, sumR: 0 };
  const liveAvgR = l.n > 0 ? l.sumR / l.n : null;

  let verdict = 'OK';
  let note = '';
  if (!enabled) {
    verdict = 'APAGADO';
  } else if (!Number.isFinite(baselineR)) {
    verdict = 'SIN_DATOS';
  } else if (weeksNeg >= MIN_NEG_WEEKS && l.n >= MIN_LIVE_TRADES && (liveAvgR ?? 0) < 0) {
    verdict = 'PROPONER_APAGADO';
    note = `${weeksNeg} sem. con baseline < 0 · vivo ${l.n} trades · ${(liveAvgR! ).toFixed(3)} R/tr`;
  } else if (baselineR < 0) {
    verdict = 'VIGILAR';
    note = `baseline ${baselineR.toFixed(2)}R · sem. negativas ${weeksNeg}/${MIN_NEG_WEEKS} · vivo ${l.n}/${MIN_LIVE_TRADES}${liveAvgR !== null ? ` (${liveAvgR.toFixed(3)} R/tr)` : ''}`;
  }

  rows.push({ ticker, enabled, baselineR, avgR, weeksNeg, liveN: l.n, liveAvgR, verdict, note });

  if (WRITE) {
    await ref.set({
      ticker, verdict, baselineR: Number.isFinite(baselineR) ? baselineR : null,
      weeksNegative: weeksNeg, minNegativeWeeks: MIN_NEG_WEEKS,
      liveTrades: l.n, liveAvgR: liveAvgR === null ? null : Number(liveAvgR.toFixed(4)),
      note, generatedAt: new Date().toISOString(), week,
      baselineHistory: history.sort((a, b) => (a.week < b.week ? -1 : 1)).slice(-WEEKS_KEEP),
    }, { merge: true });
  }
}

rows.sort((a, b) => (a.baselineR ?? 0) - (b.baselineR ?? 0));
const icon = (v: string) => v === 'PROPONER_APAGADO' ? '🔴' : v === 'VIGILAR' ? '🟡' : v === 'APAGADO' ? '⚪' : v === 'SIN_DATOS' ? '⚫' : '🟢';
console.log(`semana ${week} · regla: baseline<0 × ${MIN_NEG_WEEKS} sem + n_vivo ≥ ${MIN_LIVE_TRADES} + R/tr<0\n`);
console.log('activo        ON   baselineR   sem.neg  vivo(n)  R/tr    veredicto');
for (const r of rows) {
  console.log(`${icon(r.verdict)} ${r.ticker.padEnd(12)} ${(r.enabled ? 'ON ' : 'OFF').padEnd(4)} ${String(r.baselineR?.toFixed(2) ?? '—').padStart(9)} ${String(r.weeksNeg).padStart(8)} ${String(r.liveN).padStart(8)} ${(r.liveAvgR === null ? '—' : r.liveAvgR.toFixed(3)).padStart(7)}  ${r.verdict}${r.note ? ' · ' + r.note : ''}`);
}
const prop = rows.filter((r) => r.verdict === 'PROPONER_APAGADO');
console.log(`\n${prop.length} propuesta(s) de apagado${WRITE ? ' · escritas en shutdown_proposals/' : ' (dry-run: usá --write)'}`);
