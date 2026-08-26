import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
async function main() {
  const snap = await db.collection('trade_journal').get();
  console.log('total docs:', snap.size);
  for (const d of snap.docs) {
    const x = d.data();
    const closedAt = x.closedAt ? new Date(x.closedAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—';
    console.log(`${d.id.padEnd(8)} | ${(x.ticker||'?').padEnd(7)} | ${(x.direction||'?').padEnd(5)} | result=${(x.result??'OPEN').padEnd(10)} | r=${String(x.rMultiple??'n/a').padEnd(9)} | pnl=${x.pnl??'n/a'} | posID=${x.ctraderPositionId??'—'} | adopted=${x.adopted??false} | closedAt=${closedAt}`);
  }
  process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
