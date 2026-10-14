import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const snap = await db.collection('trade_journal').get();
const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

// 1) Dump completo de los docs de las posiciones abiertas en cTrader
for (const posId of ['294201070', '294088058']) {
  const d = docs.find(x => String(x.ctraderPositionId) === posId);
  if (d) { console.log(`\n########## DOC posID=${posId} (id=${d.id}) ##########`); console.log(JSON.stringify(d, null, 1)); }
  else console.log(`\nNo se encontró doc con posID=${posId}`);
}

// 2) Listar TODOS los campos-llave presentes en los docs (para saber cómo ordenar por fecha)
const keys = new Set();
for (const d of docs) Object.keys(d).forEach(k => keys.add(k));
console.log('\nTodos los campos del journal:', [...keys].sort().join(', '));

process.exit(0);
