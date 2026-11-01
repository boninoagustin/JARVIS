#!/usr/bin/env tsx
/**
 * Alinea el permiso ML (`asset_configs/{TICKER}.mlGateEnabled`) con la realidad:
 * el bot solo carga un modelo por activo si existe `scripts/hyperopt/models/ml_model_<TICKER>.json`.
 * Para los activos sin modelo propio, `predict()` cae al modelo DEFAULT (`ml_model.json`,
 * que es una copia del de US500) y el evaluador semanal corre SIEMPRE sin gate → el
 * reporte queda `BLOCKED: "permiso ML del asset difiere del replay"` (XPDUSD, 01-nov-2026).
 *
 * Este script apaga el permiso donde no hay modelo propio, que es la política documentada
 * en src/engine/MLFilter.ts ("Default en vivo = APAGADO"). No toca activos con modelo.
 *
 * Uso:  npx tsx scripts/ops/align_ml_gate_permissions.ts            # dry-run
 *       npx tsx scripts/ops/align_ml_gate_permissions.ts --apply    # escribe
 */
import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';

const REPO = '/opt/JARVIS';
const MODELS_DIR = path.join(REPO, 'scripts/hyperopt/models');
const APPLY = process.argv.includes('--apply');
// `--only-disabled`: toca solo activos ya deshabilitados (cambio sin efecto en vivo),
// útil cuando falta aprobación explícita para los activos que están operando.
const ONLY_DISABLED = process.argv.includes('--only-disabled');

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const models = new Set(
  fs.readdirSync(MODELS_DIR)
    .filter((f) => /^ml_model_[A-Z0-9]+\.json$/i.test(f))
    .map((f) => f.replace(/^ml_model_/i, '').replace(/\.json$/i, '').toUpperCase()),
);

const snap = await db.collection('asset_configs').get();
const targets: { ticker: string; enabled: boolean }[] = [];
for (const doc of snap.docs) {
  const x = doc.data() as any;
  if (x.mlGateEnabled === true && !models.has(doc.id.toUpperCase())) {
    targets.push({ ticker: doc.id, enabled: x.enabled === true });
  }
}

console.log(`modelos propios disponibles: ${[...models].sort().join(', ')}`);
console.log(`activos con mlGateEnabled=true y SIN modelo propio: ${targets.length}`);
const selected = ONLY_DISABLED ? targets.filter((t) => !t.enabled) : targets;
for (const t of targets) console.log(`  ${t.ticker.padEnd(12)} enabled=${t.enabled}${ONLY_DISABLED && t.enabled ? '  (omitido: --only-disabled)' : ''}`);
if (selected.length === 0) { console.log('nada que hacer'); process.exit(0); }
if (!APPLY) { console.log('\n[dry-run] agregá --apply para escribir'); process.exit(0); }

let changed = 0;
for (const { ticker } of selected) {
  const ref = db.collection('asset_configs').doc(ticker);
  const committed = await db.runTransaction(async (tx: any) => {
    const cur = await tx.get(ref);
    const data = cur.data() as any;
    if (!cur.exists || data?.mlGateEnabled !== true) return false; // idempotente
    tx.update(ref, { mlGateEnabled: false, mlGateUpdatedAt: new Date().toISOString(), mlGateUpdatedBy: 'ops:align_ml_gate_permissions' });
    return true;
  });
  if (!committed) { console.log(`  ${ticker}: sin cambios (ya estaba apagado)`); continue; }
  const after = (await ref.get()).data() as any;
  if (after?.mlGateEnabled !== false) throw new Error(`readback no confirma el cambio en ${ticker}`);
  changed++;
  console.log(`  ✅ ${ticker}: mlGateEnabled false (modelo propio inexistente)`);
}
console.log(`\nlisto: ${changed} activos actualizados`);
process.exit(0);
