import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const snap = await db.collection('trade_journal').get();
const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
const ids = ['DF3WS7','QINM9V','6KZGLD','LL0HQX','QMR23R','0MA3ZK','RQ1Q2X','L0M8RY','0LF07I','3IVM3R','HQ97B3','VHX7N7'];
const fmt = (t) => t ? new Date(t).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—';
for (const id of ids) {
  const x = docs.find(d => d.id === id);
  if (!x) { console.log(id, 'NO ENCONTRADO'); continue; }
  console.log(JSON.stringify({
    id, ts: fmt(x.timestamp), ticker: x.ticker, dir: x.direction,
    entry: x.entryPrice, sl: x.slPrice, tp1: x.tp1Price, tp2: x.tp2Price,
    result: x.result ?? 'OPEN', status: x.ctraderStatus, skip: (x.skipReason||'').slice(0,80),
  }));
}
process.exit(0);
