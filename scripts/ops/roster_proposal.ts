#!/usr/bin/env tsx
/**
 * Propuesta de ROSTER semanal — 05-nov-2026.
 *
 * Pregunta que resuelve: ¿cuántos activos operar y cuáles? Hoy el roster lo decide el
 * operador (enabled + active_tickers) y el semanal sólo optimiza lo que está en la lista.
 * Este job clasifica TODO el pool en tres estados con evidencia:
 *
 *   TRADE → operar (edge medido, muestra suficiente, lote mínimo viable)
 *   WATCH → seguir evaluando sin operar (buena pinta, muestra insuficiente o cluster lleno)
 *   OFF   → fuera del ciclo (sin edge o estructuralmente inoperable)
 *
 * Regla: mu = R/tr del backtest (health), n = trades backtest, vivo = journal.
 *   score = mu × sqrt(min(n,200))       (premia muestra y edge)
 *   TRADE: mu ≥ 0.05, n ≥ 30, lote mínimo viable, ≤ MAX_PER_CLUSTER por cluster, ≤ MAX_TRADE
 *   WATCH: mu > 0 pero n < 30, o buen mu que no entró por cupo de cluster
 *   OFF:   mu ≤ 0, no viable por lote mínimo, o shutdown_proposals dice PROPONER_APAGADO
 *
 * Uso:
 *   npx tsx scripts/ops/roster_proposal.ts             # tabla (dry-run)
 *   npx tsx scripts/ops/roster_proposal.ts --write     # publica roster_proposals/*
 *   npx tsx scripts/ops/roster_proposal.ts --apply     # además marca WATCH y alinea
 *                                                      # active_tickers = TRADE ∪ WATCH
 *                                                      # (NUNCA activa ni apaga el vivo)
 */
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import { isHealthFresh } from './health_freshness_core.js';
import { buildLiveSample, describeLiveSample } from './live_sample_core.js';
import { getAdrPrice } from '../../src/engine/tp2Cap.js';

const REPO = '/opt/JARVIS';
const WRITE = process.argv.includes('--write') || process.argv.includes('--apply');
const APPLY = process.argv.includes('--apply');

const MIN_MU_TRADE = 0.05;
const MIN_N = 30;
const MAX_PER_CLUSTER = 2;
const MAX_TRADE = 10;
const WATCH_MIN_MU = 0.02;
const OFF_MU = 0.10;     // mu ≤ -0.10 para apagar de verdad
const OFF_MIN_N = 50;    // y al menos 50 trades de backtest
const OFF_LIVE_N = 20;   // y al menos 20 trades vivos (evidencia propia, no la vieja)

const FX: Record<string, number> = { USD: 1, EUR: 1.08, JPY: 0.0063, GBP: 1.33, AUD: 0.66, NZD: 0.60, CAD: 0.72, CHF: 1.12 };
function quoteCurrency(t: string): string | undefined {
  const u = t.toUpperCase();
  if (/^[A-Z]{6}$/.test(u)) return u.slice(3);
  if (/^(XAU|XAG|XPT|XPD)/.test(u)) return 'USD';
  if (/^(XTI|XBR|BTC|NATGAS|NGAS)/.test(u)) return 'USD';
  if (/^(US500|US30|USTECH100|US100|NAS100)$/.test(u)) return 'USD';
  if (/^(JP225|JAPAN225)$/.test(u)) return 'JPY';
  if (/^(GER40|FRA40|NL25|EUROPE50|UK100|ITALY40|SPAIN35|AUSTRALIA200)$/.test(u)) return 'EUR';
  return undefined;
}
function riskClusterOf(ticker: string): string {
  const t = String(ticker || '').toUpperCase();
  if (/^(XAU|XAG|XPT|XPD)/.test(t)) return 'METALS';
  if (/^(XTI|XBR|USOIL|NATGAS|NGAS)/.test(t)) return 'ENERGY';
  if (/^(BTC|ETH)/.test(t)) return 'CRYPTO';
  if (/^(US500|US30|USTECH100|US100|NAS100)/.test(t)) return 'US_INDICES';
  if (/^(JP225|JAPAN225)/.test(t)) return 'ASIA_INDICES';
  if (/^(GER40|FRA40|NL25|EUROPE50|UK100|ITALY40|SPAIN35|AUSTRALIA200)/.test(t)) return 'EU_INDICES';
  if (/^[A-Z]{6}$/.test(t)) return t.includes('USD') ? 'FX_USD' : 'FX_CROSS';
  return 'OTHER';
}

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const caps: Record<string, any> = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/ops/symbol_caps.json'), 'utf8')).symbols || {}; } catch { return {}; }
})();
const accountState = (await db.collection('system').doc('account_state').get()).data() || {};
const equity = Number(accountState.equity) || 5000;
const acCurrency = String(accountState.currency || 'USD');

const health = await db.collection('detection_health').get();
const cfgs = await db.collection('asset_configs').get();
const shutdown = await db.collection('shutdown_proposals').get();
const cfgMap = new Map(cfgs.docs.map((d) => [d.id, d.data() as any]));
const shutMap = new Map(shutdown.docs.map((d) => [d.id, d.data() as any]));

// Vivo (journal del último trimestre)
const since = Date.now() - 180 * 864e5;
const journal = await db.collection('trade_journal').where('timestamp', '>=', since).get();
// H08: muestra viva sólo con operaciones reales, únicas y verificadas.
const sample = buildLiveSample(journal.docs as any);
const live = sample.byTicker;
console.log('Muestra viva: ' + describeLiveSample(sample));

type Row = {
  ticker: string; cluster: string; mu: number; n: number; score: number;
  feasible: boolean; minFeasible: number | null; liveN: number; liveAvgR: number | null;
  enabled: boolean; reason: string; verdict: string;
};
const rows: Row[] = [];

const staleHealth: string[] = [];
for (const doc of health.docs) {
  const ticker = doc.id;
  if (ticker === '_GLOBAL') continue;
  const h = doc.data() as any;
    // H07: health viejo/sin fecha → SIN_DATOS explícito (no se omite en silencio).
    if (!isHealthFresh(h)) { staleHealth.push(ticker); continue; }
  const cfg = cfgMap.get(ticker) || {};
  const n = Number(h.trades ?? 0);
  const mu = Number(h.avgR ?? (n > 0 ? Number(h.baselineR) / n : 0));
  const enabled = cfg.enabled === true && !String(cfg.disabledReason || '').trim();

  // Viabilidad por lote mínimo (igual criterio que risk_allocator)
  const cap = caps[ticker];
  const adr = Number(getAdrPrice(ticker));
  const qc = quoteCurrency(ticker);
  const rate = qc && FX[qc] && FX[acCurrency] ? FX[qc] / FX[acCurrency] : undefined;
  let minFeasible: number | null = null;
  if (cap && Number.isFinite(adr) && adr > 0 && Number.isFinite(rate) && (rate as number) > 0) {
    minFeasible = ((cap.minVolume * ((adr / 4) / 100) * (rate as number)) / equity) * 100;
  }
  const feasible = minFeasible === null ? true : minFeasible <= 3.0;

  const l = live.get(ticker) ?? { n: 0, sumR: 0 };
  const liveAvgR = l.n > 0 ? l.sumR / l.n : null;
  const score = mu * Math.sqrt(Math.min(n, 200));
  rows.push({
    ticker, cluster: riskClusterOf(ticker), mu, n, score, feasible, minFeasible,
    liveN: l.n, liveAvgR, enabled, reason: String(cfg.disabledReason || ''), verdict: 'OFF',
  });
}

// 05-nov-2026: overrides del operador. Si marcó un activo como TRADE (y sigue habilitado),
// la propuesta lo respeta y no lo "advierte" cada semana.
const clusterCount: Record<string, number> = {};
let tradeCount = 0;
for (const r of rows) {
  const ov = (cfgMap.get(r.ticker) || {}).rosterOverride;
  if (ov?.verdict === 'TRADE' && r.enabled) {
    r.verdict = 'TRADE';
    r.reason = `override del operador${ov.reason ? ': ' + String(ov.reason).slice(0, 60) : ''}`;
    // Un override NO consume cupo de cluster: es una decisión del operador por encima de la
    // propuesta y no debe desplazar a un activo con mejor edge (evitó que USDJPY sacara a NZDUSD).
    tradeCount++;
  }
}

if (staleHealth.length) console.log(`⚫ SIN_DATOS por health stale (>8 días): ${staleHealth.length} activo(s) · ${staleHealth.join(', ')}`);

// TRADE: mejores por cluster
const candidates = rows.filter((r) => r.verdict !== 'TRADE' && r.mu >= MIN_MU_TRADE && r.n >= MIN_N && r.feasible)
  .sort((a, b) => b.score - a.score);
for (const r of candidates) {
  if (tradeCount >= MAX_TRADE) break;
  if ((clusterCount[r.cluster] ?? 0) >= MAX_PER_CLUSTER) continue;
  if (shutMap.get(r.ticker)?.verdict === 'PROPONER_APAGADO') continue;
  r.verdict = 'TRADE';
  clusterCount[r.cluster] = (clusterCount[r.cluster] ?? 0) + 1;
  tradeCount++;
}
// WATCH / OFF
for (const r of rows) {
  if (r.verdict === 'TRADE') continue;
  if (!r.feasible) { r.verdict = 'OFF'; r.reason = `lote mínimo exige ~${r.minFeasible?.toFixed(2)}% (>3%) — inoperable`; continue; }
  if (shutMap.get(r.ticker)?.verdict === 'PROPONER_APAGADO') { r.verdict = 'OFF'; r.reason = 'shutdown_proposal: PROPONER_APAGADO'; continue; }
  // 05-nov-2026 (criterio de Bon): con historia vieja "sucia" no se abandona por poco.
  // OFF sólo con evidencia FUERTE: ede negativo claro (mu ≤ -0.10) y muestra suficiente (n≥50).
  // Todo lo demás con mu ≤ 0 queda en WATCH: se sigue midiendo (costo 0 en capital) por si
  // el engine/preset nuevos lo cambian.
  // 05-nov-2026 (criterio de Bon): apagar de verdad exige evidencia VIVA. Un backtest
  // negativo con la historia vieja no alcanza: PARKED = fuera del ciclo caro pero con health
  // semanal (se sigue midiendo barato). OFF sólo si el vivo también confirma.
  if (r.mu <= -OFF_MU && r.n >= OFF_MIN_N) {
    const liveConfirms = r.liveN >= OFF_LIVE_N && (r.liveAvgR ?? 0) < 0;
    if (liveConfirms) { r.verdict = 'OFF'; r.reason = `backtest y vivo negativos (${r.mu.toFixed(3)} R/tr, vivo ${r.liveAvgR!.toFixed(3)} en ${r.liveN})`; }
    else { r.verdict = 'PARKED'; r.reason = `backtest negativo (${r.mu.toFixed(3)}) sin evidencia viva (${r.liveN}/${OFF_LIVE_N}) — health semanal`; }
    continue;
  }
  if (r.mu <= 0) { r.verdict = 'WATCH'; r.reason = `edge negativo leve (${r.mu.toFixed(3)}) — se sigue midiendo en el ciclo`; continue; }
  if (r.n < MIN_N) { r.verdict = 'WATCH'; r.reason = `muestra insuficiente (${r.n}/${MIN_N} trades backtest)`; continue; }
  if (r.mu >= MIN_MU_TRADE) { r.verdict = 'WATCH'; r.reason = `buen edge pero cluster ${r.cluster} lleno`; continue; }
  // Todo lo que no sea negativo fuerte se sigue midiendo: plano y fino → WATCH.
  r.verdict = 'WATCH';
  r.reason = r.mu >= WATCH_MIN_MU
    ? `edge fino para operar (${r.mu.toFixed(3)} < ${MIN_MU_TRADE})`
    : `plano (${r.mu.toFixed(3)} R/tr) — se sigue midiendo`;
}

const byVerdict = (v: string) => rows.filter((r) => r.verdict === v);
const RO = { TRADE: byVerdict('TRADE'), WATCH: byVerdict('WATCH'), PARKED: byVerdict('PARKED'), OFF: byVerdict('OFF') };

console.log(`equity ${equity.toFixed(0)} ${acCurrency} · mu = R/tr backtest · score = mu×√n · clusters: máx ${MAX_PER_CLUSTER}\n`);
console.log('estado  activo        cluster        mu      n   vivo(n)  R/tr vivo   motivo');
for (const v of ['TRADE', 'WATCH', 'PARKED', 'OFF'] as const) {
  const icon = v === 'TRADE' ? '🟢' : v === 'WATCH' ? '👁 ' : v === 'PARKED' ? '🅿️ ' : '⚪';
  for (const r of RO[v].sort((a, b) => b.score - a.score)) {
    console.log(`${icon} ${r.verdict === 'TRADE' ? 'TRADE' : r.verdict.padEnd(5)} ${r.ticker.padEnd(12)} ${r.cluster.padEnd(13)} ${r.mu.toFixed(3).padStart(6)} ${String(r.n).padStart(4)} ${String(r.liveN).padStart(8)}  ${(r.liveAvgR === null ? '—' : r.liveAvgR.toFixed(3)).padStart(8)}   ${r.reason}`);
  }
}
console.log(`\nTRADE ${RO.TRADE.length} · WATCH ${RO.WATCH.length} · PARKED ${RO.PARKED.length} · OFF ${RO.OFF.length}`);

if (WRITE) {
  const at = new Date().toISOString();
  for (const r of rows) {
    await db.collection('roster_proposals').doc(r.ticker).set({
      ticker: r.ticker, verdict: r.verdict, cluster: r.cluster, mu: Number(r.mu.toFixed(4)),
      backtestTrades: r.n, score: Number(r.score.toFixed(3)), feasible: r.feasible,
      minFeasiblePct: r.minFeasible === null ? null : Number(r.minFeasible.toFixed(2)),
      liveTrades: r.liveN, liveAvgR: r.liveAvgR === null ? null : Number(r.liveAvgR.toFixed(4)),
      reason: r.reason, generatedAt: at, enabledAtGeneration: r.enabled,
    }, { merge: true });
  }
  await db.collection('roster_proposals').doc('_SUMMARY').set({
    generatedAt: at, equity,
    trade: RO.TRADE.map((r) => r.ticker), watch: RO.WATCH.map((r) => r.ticker),
    parked: RO.PARKED.map((r) => r.ticker), off: RO.OFF.map((r) => r.ticker),
    maxPerCluster: MAX_PER_CLUSTER, maxTrade: MAX_TRADE,
  }, { merge: true });
  console.log(`\n✅ ${rows.length} propuestas publicadas en roster_proposals/`);
}

if (APPLY) {
  const at = new Date().toISOString();
  // WATCH: marcar como aparcado (reversible). NUNCA toca enabled de un activo operando.
  for (const r of RO.WATCH) {
    if (r.enabled) continue; // si está operando, no lo degradamos automáticamente
    const cur = (await db.collection('asset_configs').doc(r.ticker).get()).data() || {};
    const prevReason = String(cur.disabledReason || '').trim();
    // Preservar el motivo previo (decisión del operador, allocator, etc.) y marcarlo como watch.
    const reason = /^watch:/i.test(prevReason)
      ? prevReason
      : prevReason
        ? `watch: ${prevReason} · ${r.mu.toFixed(3)} R/tr (n=${r.n})`
        : `watch: en evaluación — ${r.mu.toFixed(3)} R/tr (n=${r.n}), vivo ${r.liveN} trades`;
    await db.collection('asset_configs').doc(r.ticker).set({
      enabled: false, disabledReason: reason, updatedAt: at, updatedBy: 'roster_proposal',
    }, { merge: true });
  }
  // active_tickers = TRADE ∪ WATCH ∪ (los que ya operan). Los OFF-apagados salen del ciclo;
  // un activo ON que la propuesta no elegiría sigue optimizándose mientras se decida apagarlo.
  const list = [...new Set([
    ...RO.TRADE.map((r) => r.ticker),
    ...RO.WATCH.map((r) => r.ticker),
    ...rows.filter((r) => r.enabled).map((r) => r.ticker),
  ])].sort();
  await db.collection('optimization_config').doc('active_tickers').set({
    tickers: list, source: 'roster_proposal', updatedAt: at,
  }, { merge: true });
  const onButNotTrade = rows.filter((r) => r.enabled && r.verdict !== 'TRADE' && r.verdict !== 'PARKED');
  if (onButNotTrade.length) {
    console.log(`\n⚠️  Operando hoy pero la propuesta NO los pondría a operar (decisión tuya): ${onButNotTrade.map((r) => `${r.ticker}(${r.verdict})`).join(', ')}`);
  }
  console.log(`✅ WATCH marcados y active_tickers = TRADE ∪ WATCH (${list.length} activos)`);
  console.log(`   ${list.join(', ')}`);
}
