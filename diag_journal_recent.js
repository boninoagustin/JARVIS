import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const snap = await db.collection('trade_journal').get();
const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
docs.sort((a,b) => (b.ts ?? b.createdAt ?? 0) - (a.ts ?? a.createdAt ?? 0));
const fmt = (t) => t ? new Date(t).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—';
console.log('TOTAL:', docs.length, '| últimos 20:');
for (const x of docs.slice(0, 20)) {
  console.log(JSON.stringify({
    id: x.id, ts: fmt(x.ts ?? x.createdAt),
    ticker: x.ticker, dir: x.direction, side: x.side,
    entry: x.entryPrice, sl: x.stopLoss, tp1: x.takeProfit1, tp2: x.takeProfit2,
    result: x.result ?? 'OPEN', ctraderStatus: x.ctraderStatus,
    posID: x.ctraderPositionId, rMult: x.rMultiple, pnl: x.pnl,
    skipReason: x.skipReason, error: x.error,
  }));
}
process.exit(0);
