#!/usr/bin/env tsx
/**
 * Asignador de riesgo por activo (propuesta semanal) — 03-nov-2026.
 *
 * El optimizador semanal NO puede hacer esto: evalúa en R, y el % de riesgo no cambia
 * ninguna métrica en R (sólo escala el dinero). Cuánto arriesgar es asignación de capital.
 *
 * Regla: Kelly fraccional conservador.
 *   f = μ / σ²         (μ = R/trade, σ = desvío típico en R ≈ 1.2)
 *   propuesta = f/4    (un cuarto de Kelly), acotada a [0.5%, 3%] (techo duro del bot)
 *   sólo propone SUBIR si n ≥ 30 y μ > 0.05 R/tr (evita subir por ruido)
 *   si el lote mínimo exige más riesgo que lo que justifica el edge → NO_OPERAR
 *   (forzar el riesgo para que entre la orden no crea edge).
 *
 * Uso: npx tsx scripts/ops/risk_allocator.ts            # tabla (dry-run)
 *      npx tsx scripts/ops/risk_allocator.ts --write    # escribe risk_proposals/*
 */
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import { isHealthFresh } from './health_freshness_core.js';
import { decideRiskProposal } from './risk_allocator_core.js';
import { getAdrPrice } from '../../src/engine/tp2Cap.js';

const REPO = '/opt/JARVIS';
const WRITE = process.argv.includes('--write');
const SIGMA_R = 1.2;
const KELLY_FRACTION = 0.25;
const MIN_PCT = 0.5;
const MAX_PCT = 3.0;
const MIN_TRADES = 30;
const MU_FOR_INCREASE = 0.05;

const FX: Record<string, number> = { USD: 1, EUR: 1.08, JPY: 0.0063, GBP: 1.33, AUD: 0.66, NZD: 0.60, CAD: 0.72, CHF: 1.12 };

/** Moneda de cotización por activo (se usa para el riesgo mínimo viable). */
function quoteCurrency(t: string): string | undefined {
  const u = t.toUpperCase();
  if (/^[A-Z]{6}$/.test(u)) return u.slice(3);            // FX: EURUSD → USD
  if (/^(XAU|XAG|XPT|XPD)/.test(u)) return 'USD';         // metales
  if (/^(XTI|XBR|BTC|NATGAS|NGAS)/.test(u)) return 'USD'; // energía / crypto
  if (/^(US500|US30|USTECH100|US100|NAS100)$/.test(u)) return 'USD';
  if (/^(JP225|JAPAN225)$/.test(u)) return 'JPY';
  if (/^(GER40|FRA40|NL25|EUROPE50|UK100|ITALY40|SPAIN35|AUSTRALIA200)$/.test(u)) return 'EUR';
  return undefined;
}

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const caps: Record<string, any> = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/ops/symbol_caps.json'), 'utf8')).symbols || {}; }
  catch { return {}; }
})();

const accountState = (await db.collection('system').doc('account_state').get()).data() || {};
const equity = Number(accountState.equity) || 5000;
const acCurrency = String(accountState.currency || 'USD');

const health = await db.collection('detection_health').get();
const cfgs = await db.collection('asset_configs').get();
const activeSnap = await db.collection('optimization_config').doc('active_tickers').get();
const activeTickers: string[] = Array.isArray(activeSnap.data()?.tickers)
  ? (activeSnap.data()!.tickers as string[]).map((t) => String(t).trim().toUpperCase()).filter(Boolean)
  : [];
const healthMap = new Map(health.docs.filter((d) => d.id !== '_GLOBAL').map((d) => [d.id.toUpperCase(), d.data() as any]));
const missingActiveHealth = activeTickers.filter((t) => !healthMap.has(t) || !isHealthFresh(healthMap.get(t)));
const cfgMap = new Map(cfgs.docs.map((d) => [d.id, d.data()]));

type Row = {
  ticker: string; mu: number; n: number; kelly: number; minFeasible: number | null;
  current: number; proposal: number; verdict: string; note: string;
};
const rows: Row[] = [];

const staleHealth: string[] = [];
for (const doc of health.docs) {
  if (doc.id === '_GLOBAL') continue;
  const h = doc.data() as any;
    // H07: health viejo/sin fecha → SIN_DATOS explícito (no se omite en silencio).
    if (!isHealthFresh(h)) { staleHealth.push(doc.id); continue; }
  const cfg = cfgMap.get(doc.id) || {};
  const mu = Number(h.avgR ?? (h.trades > 0 ? h.baselineR / h.trades : 0));
  const n = Number(h.trades ?? 0);
  const current = Number.isFinite(Number(cfg.riskPercent)) && Number(cfg.riskPercent) > 0 ? Number(cfg.riskPercent) : 1;

  const kelly = Number.isFinite(mu) ? Math.max(0, (mu / (SIGMA_R ** 2)) * KELLY_FRACTION) : 0;

  // Riesgo mínimo viable: lote mínimo × SL típico (ADR/4) en moneda de cuenta.
  const cap = caps[doc.id];
  const adr = Number(getAdrPrice(doc.id));
  const quote = quoteCurrency(doc.id);
  const rate = quote && FX[quote] && FX[acCurrency] ? FX[quote] / FX[acCurrency] : undefined;
  let minFeasible: number | null = null;
  if (cap && Number.isFinite(adr) && adr > 0 && Number.isFinite(rate) && (rate as number) > 0) {
    const slTypical = adr / 4;
    minFeasible = ((cap.minVolume * (slTypical / 100) * (rate as number)) / equity) * 100;
  }

  // H12: decisión pura (el mínimo viable se compara contra la propuesta final capada).
  const decision = decideRiskProposal({
    mu, n, kellyPct: kelly * 100, current, minFeasible,
    maxPct: MAX_PCT, minPct: MIN_PCT, minTrades: MIN_TRADES, muForIncrease: MU_FOR_INCREASE,
  });
  const { proposal, verdict, note } = decision;
  rows.push({ ticker: doc.id, mu, n, kelly, minFeasible, current, proposal, verdict, note });
}

if (staleHealth.length) console.log(`⚫ SIN_DATOS por health stale (>8 días): ${staleHealth.length} activo(s) · ${staleHealth.join(', ')}`);

rows.sort((a, b) => b.mu - a.mu);
console.log(`equity ${equity.toFixed(0)} ${acCurrency} · σ=${SIGMA_R}R · ¼ Kelly · rango [${MIN_PCT}%, ${MAX_PCT}%]\n`);
console.log('activo        R/tr    n     Kelly/4   minViable  actual → propuesto  veredicto');
for (const r of rows) {
  const prop = `${r.current.toFixed(2)}% → ${r.proposal.toFixed(2)}%`;
  const mf = r.minFeasible === null ? '   —   ' : `${r.minFeasible.toFixed(2)}%`;
  console.log(`${r.ticker.padEnd(13)} ${r.mu.toFixed(3).padStart(6)} ${String(r.n).padStart(4)} ${(r.kelly * 100).toFixed(2).padStart(8)}% ${mf.padStart(9)}  ${prop.padEnd(17)} ${r.verdict}${r.note ? ' · ' + r.note : ''}`);
}

if (WRITE) {
  if (missingActiveHealth.length > 0 && !process.argv.includes('--allow-incomplete')) {
    console.error(`❌ Cobertura de detection_health incompleta para active_tickers (${missingActiveHealth.length}): ${missingActiveHealth.join(', ')} — no se publica risk_proposals incompleto`);
    process.exit(1);
  }
  const at = new Date().toISOString();
  for (const r of rows) {
    await db.collection('risk_proposals').doc(r.ticker).set({
      ticker: r.ticker, proposalPct: Number(r.proposal.toFixed(2)), currentPct: r.current,
      kellyPct: Number((r.kelly * 100).toFixed(2)), minFeasiblePct: r.minFeasible === null ? null : Number(r.minFeasible.toFixed(2)),
      verdict: r.verdict, mu: Number(r.mu.toFixed(4)), trades: r.n, note: r.note,
      method: 'kelly/4 · σ=1.2R · cap 3%', generatedAt: at, applied: false,
    }, { merge: true });
  }
  await db.collection('risk_proposals').doc('_SUMMARY').set({
    generatedAt: at, equity, accountCurrency: acCurrency, sigmaR: SIGMA_R,
    increases: rows.filter((r) => r.verdict === 'SUBIR').length,
    decreases: rows.filter((r) => r.verdict === 'BAJAR').length,
    noOperate: rows.filter((r) => r.verdict === 'NO_OPERAR').length,
  }, { merge: true });
  console.log(`\n✅ ${rows.length} propuestas escritas en risk_proposals/`);
} else {
  console.log('\n[dry-run] agregá --write para publicar las propuestas');
}
process.exit(0);
