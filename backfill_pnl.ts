// backfill_pnl.ts — Fix D: re-procesar trades cerrados del journal con PnL REAL de cTrader.
// Corrige result / ctrader_real_pnl / rMultiple que quedaron en "BREAKEVEN conservador" ($0)
// por el bug del SDK (getDealsByPosition sin from/to).
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
import { computeRMultipleFromPnlUsd } from './src/engine/FrictionModel.js';

// Cargar .env (ctrader-ts lee process.env en el connect)
for (const line of fs.readFileSync('/opt/JARVIS/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
  // 1. Conectar a cTrader (para leer historial real)
  const { connect } = await import('ctrader-ts');
  const client = await connect({
    clientId: process.env.CTRADER_CLIENT_ID,
    clientSecret: process.env.CTRADER_CLIENT_SECRET,
    accessToken: process.env.CTRADER_ACCESS_TOKEN,
    accountId: parseInt(process.env.CTRADER_ACCOUNT_ID, 10) || 0,
    environment: process.env.CTRADER_DEMO === 'true' ? 'demo' : 'live',
  });
  console.log('✅ cTrader conectado.');

  // 2. Traer trades cerrados con ctraderPositionId
  const snap = await db.collection('trade_journal').get();
  const toFix: any[] = [];
  for (const d of snap.docs) {
    const x = d.data();
    if (!x.ctraderPositionId) continue;
    if (!x.result) continue; // solo cerrados
    toFix.push({ id: d.id, ...x });
  }
  console.log(`Trades cerrados con posID: ${toFix.length}`);

  const now = Date.now();
  const from = now - 30 * 24 * 60 * 60 * 1000;
  let fixed = 0, skipped = 0;

  for (const t of toFix) {
    const pid = String(t.ctraderPositionId);
    let deals: any[] = [];
    try {
      deals = await client.getDealsByPosition(Number(pid), from, now);
    } catch (e: any) {
      console.log(`  ⚠️ ${t.id} (${pid}): error deals — ${e.message}`);
      skipped++;
      continue;
    }
    const closeDeal = deals.find((d: any) => d?.closePositionDetail);
    if (!closeDeal) {
      console.log(`  ⚠️ ${t.id} (${pid}): sin deal de cierre — se mantiene ${t.result} actual.`);
      skipped++;
      continue;
    }
    const cp = closeDeal.closePositionDetail;
    const moneyDigits = Number(closeDeal.moneyDigits ?? cp.moneyDigits ?? 2);
    const pnlUsd = Number(cp.grossProfit || 0) / Math.pow(10, moneyDigits);
    const result = pnlUsd > 0.5 ? 'WIN' : pnlUsd < -0.5 ? 'LOSS' : 'BREAKEVEN';
    const slHit = closeDeal.stopTriggerBase === 'STOP_LOSS' || cp.closeTriggerBase === 'STOP_LOSS';
    const rMultiple = computeRMultipleFromPnlUsd(
      t.ticker || '', t.entryPrice, t.slPrice ?? t.originalSlPrice, t.ctraderLots ?? t.lots, pnlUsd
    );
    await db.collection('trade_journal').doc(t.id).update({
      result,
      ctrader_real_pnl: Math.round(pnlUsd * 100) / 100,
      rMultiple,
      slHit,
      reconciled: true,
    });
    console.log(`  ✅ ${t.id} (${pid}): ${t.result} → ${result} | $${pnlUsd.toFixed(2)} | ${rMultiple}R`);
    fixed++;
  }

  await client.disconnect();
  console.log(`\n📊 Backfill: ${fixed} corregidos, ${skipped} saltados.`);
  process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
