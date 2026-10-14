// ─── Auditoría T1 (08-oct-2026) — contención por datos, SIN reiniciar el bot ───
// 1. Backup de los docs afectados a /opt/JARVIS/backups/.
// 2. AUDJPY/USDJPY/GBPJPY: borrar sessions.ALL.maxSellLosses/maxBuyLosses cuando NO son número
//    (objeto mal escrito por un script de tuning) → el doc vuelve a pasar el schema Zod.
// 3. CADJPY/ITALY40/SPAIN35/XPTUSD: marcar enabled:false + disabledReason (eran "fantasma").
// 4. Borrar los docs de active_trades SIN ctraderPositionId (pre-trades fantasma de la
//    carrera set/delete; RAM y cTrader están en 0).
// One-shot. Correr: cd /opt/JARVIS && npx tsx scripts/audit_t1_data_fix.mts
const admin = (await import('firebase-admin')).default;
import fs from 'fs';
const key = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const JPY = ['AUDJPY', 'USDJPY', 'GBPJPY'];
const PHANTOM = ['CADJPY', 'ITALY40', 'SPAIN35', 'XPTUSD'];
const DISABLED_REASON = 'no habilitado explícitamente — auditoría T1 08-oct-2026';

// ── backup ──
const backup: Record<string, unknown> = {};
for (const t of [...JPY, ...PHANTOM]) {
  const s = await db.doc(`asset_configs/${t}`).get();
  if (s.exists) backup[`asset_configs/${t}`] = s.data();
}

// ── 1. JPY: borrar campos no numéricos en sessions.ALL ──
for (const t of JPY) {
  const s = await db.doc(`asset_configs/${t}`).get();
  if (!s.exists) { console.log(`[SKIP] asset_configs/${t} no existe`); continue; }
  const data = s.data() as any;
  const all = data?.sessions?.ALL ?? {};
  const upd: Record<string, any> = {};
  for (const f of ['maxSellLosses', 'maxBuyLosses']) {
    if (all[f] !== undefined && typeof all[f] !== 'number') upd[`sessions.ALL.${f}`] = FV.delete();
  }
  if (Object.keys(upd).length) {
    await db.doc(`asset_configs/${t}`).update(upd);
    console.log(`[FIX] ${t}: borrados ${Object.keys(upd).join(', ')} (eran objetos, no números)`);
  } else {
    console.log(`[OK] ${t}: sessions.ALL.max*Losses ya numéricos o ausentes`);
  }
}

// ── 2. Fantasmas: enabled:false + disabledReason ──
for (const t of PHANTOM) {
  const s = await db.doc(`asset_configs/${t}`).get();
  if (!s.exists) { console.log(`[SKIP] asset_configs/${t} no existe`); continue; }
  const data = s.data() as any;
  if (data?.enabled === true) {
    console.log(`[WARN] ${t} tiene enabled:true explícito — NO se toca (revisar a mano)`);
    continue;
  }
  await db.doc(`asset_configs/${t}`).update({ enabled: false, disabledReason: DISABLED_REASON });
  console.log(`[FIX] ${t}: enabled:false + disabledReason`);
}

// ── 3. active_trades fantasma: borrar SOLO los que no tienen posID ──
const at = await db.collection('active_trades').get();
let deleted = 0;
const kept: string[] = [];
for (const d of at.docs) {
  const x = d.data() as any;
  backup[`active_trades/${d.id}`] = x;
  if (!x.ctraderPositionId && !x.journalId) {
    await d.ref.delete();
    deleted++;
    console.log(`[FIX] active_trades/${d.id} (${x.ticker}, sin posID) borrado`);
  } else {
    kept.push(`${d.id}:${x.ticker}:${x.ctraderPositionId ?? '—'}`);
  }
}

// ── guardar backup ──
const bkPath = `/opt/JARVIS/backups/audit_t1_data_fix_${Date.now()}.json`;
fs.mkdirSync('/opt/JARVIS/backups', { recursive: true });
fs.writeFileSync(bkPath, JSON.stringify(backup, null, 1));

console.log(`\n=== RESUMEN ===`);
console.log(`backup → ${bkPath}`);
console.log(`active_trades borrados: ${deleted} | conservados (con posID/journal): ${kept.length}${kept.length ? ' → ' + kept.join(', ') : ''}`);
process.exit(0);
