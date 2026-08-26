import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
async function main() {
  const d = await db.collection('trade_journal').doc('ALDQAU').get();
  console.log(JSON.stringify(d.data(), null, 2));
  process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
