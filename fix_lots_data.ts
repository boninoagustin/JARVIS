// fix_lots_data.ts — corregir ctraderLots inflado 100x (solo forex) y recalcular rMultiple.
// El bug: lots = correctVolumeCents / 100000 (debería ser / lotSizeCents=10,000,000 para forex).
// Para forex (lotSize=10,000,000 centavos), el ctraderLots quedó 100x inflado.
// Metales (XAU lotSize=10,000) y crypto (BTC lotSize=100) tienen escala distinta; se corrigen por su factor real.
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
import { computeRMultipleFromPnlUsd } from './src/engine/FrictionModel.js';

const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// lotSize en centavos por lote, por clase de activo (igual que la API cTrader)
function lotSizeCentsFor(ticker: string): number {
  const t = (ticker || '').toUpperCase();
  if (t.includes('XAU') || t.includes('GOLD') || t.includes('XAG') || t.includes('SILVER')) return 10000; // 100 oz = 10,000 centavos
  if (t.includes('BTC') || t.includes('ETH')) return 100; // 1 coin = 100 centavos
  if (t.includes('US30') || t.includes('NAS') || t.includes('SPX') || t.includes('US100')) return 100;
  return 10000000; // forex: 100,000 unidades = 10,000,000 centavos
}

async function main() {
  const s = await db.collection('trade_journal').get();
  let fixed = 0, skipped = 0;
  for (const d of s.docs) {
    const x = d.data();
    const rawLots = x.ctraderLots;
    if (rawLots === undefined || rawLots === null) { skipped++; continue; }
    const ticker = (x.ticker || '').toUpperCase();
    const lotSizeCents = lotSizeCentsFor(ticker);
    // El valor guardado = correctVolumeCents / 100000. El correcto = correctVolumeCents / lotSizeCents.
    // => correctLots = savedLots * (100000 / lotSizeCents)
    const correctLots = rawLots * (100000 / lotSizeCents);
    const pnlUsd = x.ctrader_real_pnl ?? 0;
    const rMultiple = computeRMultipleFromPnlUsd(ticker, x.entryPrice, x.slPrice ?? x.originalSlPrice, correctLots, pnlUsd);
    await db.collection('trade_journal').doc(d.id).update({
      ctraderLots: Math.round(correctLots * 10000) / 10000,
      rMultiple,
    });
    console.log(`${d.id} ${ticker}: lots ${rawLots} → ${(Math.round(correctLots*10000)/10000)} | rMultiple=${rMultiple}`);
    fixed++;
  }
  console.log(`\nCorregidos: ${fixed}, saltados: ${skipped}`);
  process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
