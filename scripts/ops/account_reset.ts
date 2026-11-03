#!/usr/bin/env tsx
/**
 * Reset de cuenta para empezar de cero con una cuenta demo nueva — 02-nov-2026.
 *
 * Firestore no tiene "rename": archivar = copiar a `<coleccion>_archive_<fecha>` y
 * recién después borrar la original, verificando conteos. Nunca borra sin copia.
 *
 * Uso:
 *   npx tsx scripts/ops/account_reset.ts --export                 # backup JSON (seguro)
 *   npx tsx scripts/ops/account_reset.ts --archive --date 20261103        # dry-run
 *   npx tsx scripts/ops/account_reset.ts --archive --date 20261103 --yes  # ejecuta
 *
 * Qué se archiva (historial de la cuenta vieja):
 *   trade_journal, execution_metrics, trigger_telemetry, opt_reports, detection_health,
 *   detection_diagnostics, ml_gate_evals, corr_gate_evals, exits_gate_evals,
 *   timesfm_gate_evals, rollover_evals, health_check, ghost_positions, active_trades,
 *   autotune_reports, optimization_rollouts, prospective_tests
 * Qué se conserva: asset_configs (estrategia), app_settings, firebase_config, system.
 * Qué se resetea sin archivar: optimization_config.auto_state (aplicaciones de la
 *   cuenta vieja: arrancan vacías para que el rollback no compare contra otra cuenta).
 */
import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';

const REPO = '/opt/JARVIS';
const EXPORT_DIR = path.join(REPO, 'backups');
const ARCHIVE = process.argv.includes('--archive');
const YES = process.argv.includes('--yes');
const argv = process.argv.slice(2);
const dateArg = (() => { const i = argv.indexOf('--date'); return i >= 0 ? argv[i + 1] : undefined; })();
const DATE = (dateArg || new Date().toISOString().slice(0, 10).replace(/-/g, '')).replace(/[^0-9]/g, '');

const HISTORY = [
  'trade_journal', 'execution_metrics', 'trigger_telemetry', 'opt_reports', 'detection_health',
  'detection_diagnostics', 'ml_gate_evals', 'corr_gate_evals', 'exits_gate_evals',
  'timesfm_gate_evals', 'rollover_evals', 'health_check', 'ghost_positions', 'active_trades',
  'autotune_reports', 'optimization_rollouts', 'prospective_tests',
];

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

async function exportAll() {
  const dir = path.join(EXPORT_DIR, `firestore_export_${DATE}`);
  fs.mkdirSync(dir, { recursive: true });
  const cols = await db.listCollections();
  let total = 0;
  for (const col of cols) {
    const snap = await col.get();
    const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    fs.writeFileSync(path.join(dir, `${col.id}.json`), JSON.stringify(docs, null, 2));
    total += docs.length;
    console.log(`  ${String(docs.length).padStart(5)}  ${col.id}`);
  }
  const meta = { exportedAt: new Date().toISOString(), collections: cols.length, documents: total };
  fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify(meta, null, 2));
  console.log(`\n✅ export: ${cols.length} colecciones, ${total} documentos → ${path.relative(REPO, dir)}`);
}

async function archiveCollections() {
  for (const col of HISTORY) {
    const src = db.collection(col);
    const snap = await src.get();
    if (snap.size === 0) { console.log(`  ${col}: vacía, se omite`); continue; }
    const dstName = `${col}_archive_${DATE}`;
    const dst = db.collection(dstName);
    const existing = await dst.count().get();
    if (existing.data().count > 0) { console.log(`  ${col}: ${dstName} ya existe con ${existing.data().count} docs → se omite`); continue; }
    console.log(`  ${col}: ${snap.size} docs → ${dstName}${YES ? '' : ' [dry-run]'}`);
    if (!YES) continue;
    let batch = db.batch(); let n = 0;
    for (const doc of snap.docs) {
      batch.set(dst.doc(doc.id), doc.data());
      if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
    }
    await batch.commit();
    const copied = (await dst.count().get()).data().count;
    if (copied !== snap.size) throw new Error(`${col}: copiados ${copied} != ${snap.size}, no se borra el original`);
    let del = db.batch(); let m = 0;
    for (const doc of snap.docs) {
      del.delete(doc.ref);
      if (++m % 400 === 0) { await del.commit(); del = db.batch(); }
    }
    await del.commit();
    const left = (await src.count().get()).data().count;
    if (left !== 0) throw new Error(`${col}: quedaron ${left} docs sin borrar`);
    console.log(`    ✅ ${col}: ${copied} archivados y original vacío`);
  }
}

async function resetAutoState() {
  const ref = db.collection('optimization_config').doc('auto_state');
  const snap = await ref.get();
  if (!snap.exists) { console.log('  auto_state: no existe'); return; }
  const st = snap.data() as any;
  console.log(`  auto_state: applied=${Object.keys(st.applied || {}).length}, failing=${Object.keys(st.failing || {}).length}${YES ? '' : ' [dry-run]'}`);
  if (!YES) return;
  await ref.set({ applied: {}, failing: {}, resetAt: new Date().toISOString(), resetReason: 'cuenta demo nueva' }, { merge: false });
  console.log('    ✅ auto_state reiniciado');
}

if (ARCHIVE) {
  console.log(`modo ${YES ? 'EJECUTAR' : 'dry-run'} · fecha de archivo ${DATE}`);
  await archiveCollections();
  await resetAutoState();
  console.log('\nlisto');
} else {
  console.log('modo export (backup)\n');
  await exportAll();
}
process.exit(0);
