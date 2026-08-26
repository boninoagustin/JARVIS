// Activar filtro de correlación (bloqueo real) en todos los activos habilitados (ago-2026).
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
  const all = await db.collection('asset_configs').get();
  let n = 0;
  for (const d of all.docs) {
    const x = d.data();
    if (d.id === 'GLOBAL') continue;
    if (x.enabled !== true) continue;
    await db.collection('asset_configs').doc(d.id).update({
      correlationFilter: {
        shadow: false,          // bloqueo real (antes auditar sin bloquear)
        threshold: 0.70,        // acoplamiento para risk-parity
        doubleThreshold: 0.85,  // DOBLE EXPOSICIÓN: SAME_ON_POSITIVE ρ≥0.85 → bloqueo
        riskParity: true,
      },
    });
    n++;
    console.log(`🧲 ${d.id}: correlationFilter.shadow=false`);
  }
  console.log(`\n✅ ${n} activos con filtro de correlación ACTIVO (bloqueo real)`);
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
