// probe_journal.ts — último trade del journal + trades activos (solo lectura)
import dotenv from 'dotenv';
dotenv.config({ path: '/opt/JARVIS/.env' });
import admin from 'firebase-admin';

const certPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/opt/JARVIS/service-account.json';
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(certPath) });
}
const db = admin.firestore();

const t0 = Date.now();
const all = await db.collection('trade_journal').get();
console.log('JOURNAL COMPLETO (todos los docs):');
for (const d of all.docs) {
  const t: any = d.data();
  const fechas: Record<string, any> = {};
  for (const k of Object.keys(t)) if (/time|date|created|open|close|at/i.test(k)) fechas[k] = t[k];
  console.log(`  ${d.id} | ${t.ticker || '?'} ${t.direction || ''} | status=${t.status} | pnl=${t.ctrader_real_pnl ?? 'n/d'} | fechas=${JSON.stringify(fechas)}`);
}
const active = await db.collection('active_trades').get();
console.log(`ACTIVE_TRADES: ${active.size}`);
console.log(`consulta en ${Date.now() - t0}ms`);
process.exit(0);
