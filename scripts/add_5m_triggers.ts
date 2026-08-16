import admin from 'firebase-admin';
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const T5 = ['choch5m', 'bos5m', 'oteChoch5m', 'oteBos5m'];
const MISSING = ['AUDCAD', 'BTCUSD', 'GBPUSD', 'NZDUSD', 'US500', 'USDCAD', 'USDJPY'];
const SESSIONS = ['ALL', 'ASIA', 'LONDON', 'NY'];

// Fuente: XAUUSD (que ya tiene los 5m, optimizados)
const xau = (await db.doc('asset_configs/XAUUSD').get()).data() || {};
const xauSessions = xau.sessions || {};

for (const tk of MISSING) {
  const d = (await db.doc(`asset_configs/${tk}`).get()).data() || {};
  const sessions = d.sessions ? JSON.parse(JSON.stringify(d.sessions)) : {};
  for (const sk of SESSIONS) {
    const src = xauSessions[sk] || {};
    if (!sessions[sk]) sessions[sk] = {};
    for (const t of T5) {
      if (src[t] && typeof src[t] === 'object') {
        sessions[sk][t] = JSON.parse(JSON.stringify(src[t]));
      }
    }
  }
  await db.doc(`asset_configs/${tk}`).set(
    { sessions, updatedAt: new Date().toISOString(), source: 'add_5m_triggers' },
    { merge: true }
  );
  console.log(`✅ 5m agregados a ${tk} (copiados de XAUUSD)`);
}
console.log('DONE');
process.exit(0);
