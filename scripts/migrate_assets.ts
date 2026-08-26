// Migración de activos (ago-2026): deshabilitar USOIL/USDCAD, crear GBPJPY/AUDJPY/GER40 en modo radar.
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
  // 1) Deshabilitar
  for (const tk of ['USOIL', 'USDCAD']) {
    const d = await db.collection('asset_configs').doc(tk).get();
    if (!d.exists) { console.log(`${tk}: doc no existe, skip`); continue; }
    await db.collection('asset_configs').doc(tk).update({ enabled: false, disabledReason: 'retirado ago-2026 (decisión Bon: SMC no compatible / rendimiento)', disabledAt: Date.now() });
    console.log(`🔴 ${tk} deshabilitado`);
  }

  // 2) Crear clones en modo radar (enabled=false)
  const clones: Array<[string, string]> = [
    ['USDJPY', 'GBPJPY'],
    ['USDJPY', 'AUDJPY'],
    ['US500', 'GER40'],
  ];
  for (const [src, dst] of clones) {
    const s = await db.collection('asset_configs').doc(src).get();
    if (!s.exists) { console.log(`fuente ${src} no existe, skip ${dst}`); continue; }
    const data = { ...s.data() };
    delete data.ticker;
    data.enabled = false;
    data.addedAt = Date.now();
    data.radarOnly = true;
    data.clonedFrom = src;
    data.note = 'Nuevo activo en modo radar (observación). Habilitar tras tuneo del optimizador dominical.';
    await db.collection('asset_configs').doc(dst).set(data);
    console.log(`🟢 ${dst} creado (clon de ${src}, enabled=false, sesiones=${Object.keys(data.sessions || {}).join(',')})`);
  }

  // 3) Verificación final
  const all = await db.collection('asset_configs').get();
  console.log('\n=== asset_configs final ===');
  for (const d of all.docs) {
    const x = d.data();
    if (d.id === 'GLOBAL') continue;
    console.log(d.id, '| enabled=', x.enabled, '| radarOnly=', x.radarOnly ?? false);
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
