import admin from 'firebase-admin';
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
await db.doc('asset_configs/US500').set(
  { enabled: false, updatedAt: new Date().toISOString(), source: 'deactivate_us500' },
  { merge: true }
);
const d = (await db.doc('asset_configs/US500').get()).data() || {};
console.log('US500.enabled =', d.enabled, '✓ desactivado');
process.exit(0);
