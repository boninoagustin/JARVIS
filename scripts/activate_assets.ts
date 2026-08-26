// Activar los 3 nuevos activos (ago-2026). GER40 restringido a LONDON+NY (horario Eurex 08:00-22:00 Berlín).
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
  // 1) GBPJPY + AUDJPY: habilitar con todas las sesiones del clon USDJPY
  for (const tk of ['GBPJPY', 'AUDJPY']) {
    await db.collection('asset_configs').doc(tk).update({
      enabled: true,
      radarOnly: false,
      note: 'Activo habilitado ago-2026 (clon de USDJPY, pendiente de tuneo dominical)',
    });
    console.log(`🟢 ${tk} ACTIVADO (todas las sesiones del clon)`);
  }

  // 2) GER40: habilitar pero solo LONDON + NY (el DAX no cotiza en ASIA/OFF)
  const g = await db.collection('asset_configs').doc('GER40').get();
  const data = g.data()!;
  const sessions = { ...(data.sessions || {}) };
  for (const sess of ['ASIA', 'OFF']) {
    const s = { ...(sessions[sess] || {}) };
    for (const k of Object.keys(s)) {
      if (k === 'maxSellLosses' || k === 'maxBuyLosses') continue;
      s[k] = { ...s[k], enabled: false };
    }
    sessions[sess] = s;
  }
  await db.collection('asset_configs').doc('GER40').update({
    enabled: true,
    radarOnly: false,
    sessions,
    note: 'Activo habilitado ago-2026 SOLO en LONDON+NY (Eurex 08:00-22:00 Berlín). ASIA/OFF desactivados.',
  });
  console.log('🟢 GER40 ACTIVADO (solo LONDON + NY; ASIA/OFF deshabilitados)');

  // 3) Verificación
  console.log('\n=== estado final ===');
  for (const tk of ['GBPJPY', 'AUDJPY', 'GER40']) {
    const d = await db.collection('asset_configs').doc(tk).get();
    const x = d.data()!;
    const ses = x.sessions || {};
    const activas = Object.entries(ses).map(([s, v]: [string, any]) => {
      const trigs = Object.entries(v).filter(([a]) => a !== 'maxSellLosses' && a !== 'maxBuyLosses');
      const on = trigs.filter(([, b]) => (b as any).enabled === true).length;
      return `${s}:${on}`;
    }).join(' ');
    console.log(tk, '| enabled=', x.enabled, '|', activas);
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
