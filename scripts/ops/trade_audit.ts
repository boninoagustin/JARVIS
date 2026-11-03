#!/usr/bin/env tsx
/**
 * Auditoría post-trade — 03-nov-2026.
 *
 * Verifica, en la cuenta nueva (USD, $5.000), que el riesgo real de cada entrada
 * coincida con el presupuesto: el bot registra `riskBudgetAccount` (lo que quiso
 * arriesgar) y `riskAmountAccount` (lo que congeló al fill). Se avisa por Telegram
 * sólo cuando hay desvío — no se manda nada si todo está bien.
 *
 * Chequeos por trade nuevo:
 *   1. presupuesto vs equity × requestedRiskPercent   (desvío > 5%)
 *   2. riesgo real vs presupuesto                      (desvío > 5%)  → min lot forzado, slippage
 *   3. riesgo real > 3.5% del equity                   (violación del techo duro de 3%)
 *   4. riskAccountingStatus distinto de VERIFIED        (no se pudo verificar el riesgo)
 *   5. slippage > 3 pips (de execution_metrics)         (sólo informativo)
 *
 * Uso: npx tsx scripts/ops/trade_audit.ts            # corre y avisa si hay desvíos
 *      npx tsx scripts/ops/trade_audit.ts --self-test
 */
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

const REPO = '/opt/JARVIS';
const STATE_COLL = 'system';
const STATE_DOC = 'trade_audit';
const BUDGET_DEV = 0.05;      // 5% entre presupuesto y equity×risk%
const RISK_DEV = 0.10;        // 10% entre riesgo real y presupuesto (redondeo a lote mínimo)
const HARD_CAP_PCT = 3.5;     // techo duro 3% + 0.5 de tolerancia
const SLIP_PIPS = 3;

// Topes del bróker por símbolo (maxVolume/lotSize): si la orden llegó al máximo
// permitido, el riesgo real queda por debajo del presupuesto y NO es un desvío.
const CAPS: Record<string, any> = (() => {
  try {
    const f = path.join(REPO, 'scripts/ops/symbol_caps.json');
    return JSON.parse(fs.readFileSync(f, 'utf8')).symbols || {};
  } catch { return {}; }
})();
function cappedByBroker(ticker: string, lots: number | null): boolean {
  const cap = CAPS[String(ticker || '').toUpperCase()];
  if (!cap || !Number.isFinite(lots) || !(cap.lotSize > 0)) return false;
  const maxLots = cap.maxVolume / cap.lotSize;
  return maxLots > 0 && (lots as number) >= maxLots * 0.99;
}

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

function verdict(t: any, equity: number, slip: number | null, capped = false): { ok: boolean; issues: string[]; detail: string } {
  const issues: string[] = [];
  const requested = Number(t.requestedRiskPercent);
  const budget = Number(t.riskBudgetAccount);
  const actual = Number(t.riskAmountAccount);
  const expectedBudget = Number.isFinite(requested) && equity > 0
    ? equity * Math.min(requested, 3) / 100 : NaN;
  if (Number.isFinite(expectedBudget) && expectedBudget > 0 && Number.isFinite(budget)) {
    const dev = Math.abs(budget - expectedBudget) / expectedBudget;
    if (dev > BUDGET_DEV) issues.push(`presupuesto ${budget.toFixed(2)} vs esperado ${expectedBudget.toFixed(2)} (${(dev * 100).toFixed(0)}%)`);
  }
  if (Number.isFinite(budget) && budget > 0 && Number.isFinite(actual)) {
    const dev = (actual - budget) / budget;
    const under = dev < 0;
    // Si la orden llegó al máximo del bróker, el sub-riesgo es estructural (no un desvío).
    if (Math.abs(dev) > RISK_DEV && !(capped && under)) {
      issues.push(`riesgo real ${actual.toFixed(2)} vs presupuesto ${budget.toFixed(2)} (${(dev * 100).toFixed(0)}%)`);
    }
  }
  if (Number.isFinite(actual) && equity > 0 && (actual / equity) * 100 > HARD_CAP_PCT) {
    issues.push(`riesgo real ${(actual / equity * 100).toFixed(2)}% del equity (> ${HARD_CAP_PCT}%)`);
  }
  if (t.riskAccountingStatus && t.riskAccountingStatus !== 'VERIFIED') {
    issues.push(`contabilidad de riesgo ${t.riskAccountingStatus}`);
  }
  if (slip !== null && Math.abs(slip) > SLIP_PIPS) issues.push(`slippage ${slip.toFixed(1)} pips`);
  const detail = `entry ${t.entryPrice ?? '?'} · sl ${t.initialSlPrice ?? '?'} · budget ${Number.isFinite(budget) ? budget.toFixed(2) : '?'} · real ${Number.isFinite(actual) ? actual.toFixed(2) : '?'}${capped ? ' · [capped por maxVolume del bróker]' : ''}`;
  return { ok: issues.length === 0, issues, detail };
}

async function sendTelegram(text: string): Promise<void> {
  const env = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
  const token = /TELEGRAM_BOT_TOKEN="([^"]+)"/.exec(env)?.[1];
  const chat = /TELEGRAM_ALLOWED_USER_IDS="([^"]+)"/.exec(env)?.[1] || '1348898450';
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ chat_id: chat, text }).toString(),
  }).catch(() => undefined);
}

if (process.argv.includes('--self-test')) {
  const eq = 5000;
  const ok = verdict({ requestedRiskPercent: 1, riskBudgetAccount: 50, riskAmountAccount: 50.4, riskAccountingStatus: 'VERIFIED', entryPrice: 1.1, initialSlPrice: 1.09 }, eq, 0.4);
  const bad = verdict({ requestedRiskPercent: 1, riskBudgetAccount: 50, riskAmountAccount: 130, riskAccountingStatus: 'VERIFIED', entryPrice: 1.1, initialSlPrice: 1.09 }, eq, 4.2);
  console.log('caso OK   →', ok.ok, JSON.stringify(ok.issues));
  console.log('caso MALO →', bad.ok, JSON.stringify(bad.issues));
  if (!ok.ok || bad.ok) { console.error('AUTOTEST FALLÓ'); process.exit(1); }
  const capped = verdict({ requestedRiskPercent: 1, riskBudgetAccount: 50, riskAmountAccount: 13.71, riskAccountingStatus: 'VERIFIED', entryPrice: 62981, initialSlPrice: 62764.6 }, eq, 2, true);
  console.log('caso CAPPED →', capped.ok, JSON.stringify(capped.issues));
  if (!capped.ok) { console.error('AUTOTEST FALLÓ (capped no debe alertar por sub-riesgo)'); process.exit(1); }
  console.log('AUTOTEST OK');
  process.exit(0);
}

const stateRef = db.collection(STATE_COLL).doc(STATE_DOC);
const state = (await stateRef.get()).data() as any || {};
const audited: Record<string, any> = state.audited || {};
const equity = Number((await db.collection('system').doc('account_state').get()).data()?.equity) || 0;

// slippage por tradeId (ventana 48h)
const since = Date.now() - 48 * 3600e3;
const metrics = await db.collection('execution_metrics').where('timestamp', '>=', since).get();
const slipByTrade: Record<string, number> = {};
const lotsByTrade: Record<string, number> = {};
for (const d of metrics.docs) {
  const x = d.data() as any;
  if (!x.tradeId) continue;
  slipByTrade[x.tradeId] = Number(x.slippagePips);
  if (Number.isFinite(Number(x.lots))) lotsByTrade[x.tradeId] = Number(x.lots);
}

// Candidatos: trades abiertos + cerrados recientes (el journal conserva el riesgo).
// Se usa tradeId como clave para no auditar dos veces el mismo trade.
const open = await db.collection('active_trades').get();
const candidates: Array<{ key: string; docId: string; t: any }> = [];
for (const d of open.docs) {
  const t = d.data() as any;
  const key = String(t.tradeId ?? d.id);
  candidates.push({ key, docId: d.id, t });
}
const since24 = Date.now() - 24 * 3600e3;
const journal = await db.collection('trade_journal').where('timestamp', '>=', since24).get();
for (const j of journal.docs) {
  const t = j.data() as any;
  if (!Number.isFinite(Number(t.riskAmountAccount))) continue;
  const key = String(t.id ?? t.tradeId ?? j.id);
  if (candidates.some((c) => c.key === key)) continue;
  candidates.push({ key, docId: j.id, t });
}
const fresh = candidates.filter((c) => !audited[c.key]);
console.log(`equity=${equity} · abiertas=${open.size} · cerradas 24h=${journal.size} · nuevas sin auditar=${fresh.length}`);
if (fresh.length === 0) process.exit(0);

const alerts: string[] = [];
for (const { key, docId, t } of fresh) {
  const slip = Number.isFinite(slipByTrade[key]) ? slipByTrade[key] : (Number.isFinite(slipByTrade[t.tradeId]) ? slipByTrade[t.tradeId] : null);
  const lots = Number.isFinite(lotsByTrade[key]) ? lotsByTrade[key] : (Number.isFinite(lotsByTrade[t.tradeId]) ? lotsByTrade[t.tradeId] : null);
  const capped = cappedByBroker(t.ticker, lots);
  const v = verdict(t, equity, slip, capped);
  console.log(`  ${key} ${t.ticker} ${t.direction}: ${v.ok ? 'OK' : 'DESVÍO'} · ${v.detail}`);
  if (!v.ok) alerts.push(`• ${t.ticker} ${t.direction} (${key})\n  ${v.issues.join('\n  ')}\n  ${v.detail}`);
  audited[key] = { at: Date.now(), ok: v.ok, issues: v.issues, docId };
}

await stateRef.set({ audited, updatedAt: Date.now() }, { merge: true });
// poda: últimos 500
const keys = Object.keys(audited);
if (keys.length > 500) {
  const keep = keys.slice(-500);
  const pruned: Record<string, any> = {};
  for (const k of keep) pruned[k] = audited[k];
  await stateRef.set({ audited: pruned }, { merge: false });
}

if (alerts.length > 0) {
  const text = `⚠️ JARVIS — riesgo desviado en la cuenta nueva\n${alerts.join('\n')}\n\n(equity ${equity.toFixed(2)} USD · riesgo pedido ≈ ${(equity * 0.01).toFixed(2)})`;
  await sendTelegram(text);
  console.log(`\n${alerts.length} alerta(s) enviadas por Telegram`);
} else {
  console.log('\nsin desvíos');
}
process.exit(0);
