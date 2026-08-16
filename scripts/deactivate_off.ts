import admin from 'firebase-admin';
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const OFF_TRIGGERS = ['choch5m', 'bos5m', 'oteChoch5m', 'oteBos5m', 'choch15m', 'bos15m', 'oteChoch15m', 'oteBos15m'];

const snap = await db.collection('asset_configs').get();
let done = 0;
for (const doc of snap.docs) {
  const d = doc.data() || {};
  const sessions = d.sessions ? JSON.parse(JSON.stringify(d.sessions)) : {};
  // OFF: todos los gatillos apagados explícitamente (pisa el fallback de 'ALL')
  const off: Record<string, any> = {};
  for (const t of OFF_TRIGGERS) off[t] = { enabled: false };
  sessions.OFF = off;
  await db.doc(`asset_configs/${doc.id}`).set(
    { sessions, updatedAt: new Date().toISOString(), source: 'deactivate_off' },
    { merge: true }
  );
  console.log(`✅ OFF desactivado en ${doc.id}`);
  done++;
}
console.log(`DONE: ${done} activos con OFF apagado`);
process.exit(0);
