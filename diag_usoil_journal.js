import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const snap = await db.collection('trade_journal').get();
const fmt = (t) => t ? new Date(t).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—';
for (const d of snap.docs) {
  const x = d.data();
  if (x.ticker === 'USOIL') {
    console.log(JSON.stringify({
      id: d.id, ts: fmt(x.timestamp), result: x.result ?? 'OPEN',
      entry: x.entryPrice, sl: x.slPrice, tp2: x.tp2Price,
      rMult: x.rMultiple, pnl: x.ctrader_real_pnl ?? x.pnl,
      posID: x.ctraderPositionId, closedAt: fmt(x.closedAt),
      slHit: x.slHit, tp2Hit: x.tp2Hit, reconciled: x.reconciled ?? false,
    }));
  }
}
process.exit(0);
