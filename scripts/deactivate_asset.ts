import admin from 'firebase-admin';
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const tk = process.argv[2]?.toUpperCase() || 'EURUSD';
await db.doc(`asset_configs/${tk}`).set(
  { enabled: false, updatedAt: new Date().toISOString(), source: 'deactivate_asset' },
  { merge: true }
);
const d = (await db.doc(`asset_configs/${tk}`).get()).data() || {};
console.log(`${tk}.enabled = ${d.enabled} ✓ desactivado`);
process.exit(0);
