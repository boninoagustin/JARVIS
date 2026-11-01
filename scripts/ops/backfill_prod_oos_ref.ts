#!/usr/bin/env tsx
/**
 * Backfill de `optimization_config/auto_state.applied[*].prodOosRef`.
 *
 * Para qué: el rollback automático (apply_weekly.ts) compara la expectativa OOS de
 * producción contra `prodOosRef` (valor de referencia al momento de aplicar). Si el
 * campo falta, `prodOos < undefined - 0.10` es NaN → el rollback NUNCA se dispara.
 * Las 3 aplicaciones del 26-oct (FRA40, NL25, USDJPY) quedaron sin ese valor.
 *
 * LIMITACIÓN HONESTA: el reporte de la semana del 26-oct fue sobrescrito por el del
 * 01-nov, así que no existe el valor pre-cambio. Se rebaselinea con la producción OOS
 * del reporte vigente y se marca `rebaselined_at_ms`, de modo que el rollback empieza a
 * medir degradación desde hoy (no puede reclamar lo que ya pasó).
 *
 * Uso:  npx tsx scripts/ops/backfill_prod_oos_ref.ts            # dry-run
 *       npx tsx scripts/ops/backfill_prod_oos_ref.ts --apply    # escribe
 */
import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';

const REPO = '/opt/JARVIS';
const REPORTS_DIR = path.join(REPO, 'scripts/periodic_opt/reports');
const APPLY = process.argv.includes('--apply');

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const ref = db.collection('optimization_config').doc('auto_state');

const snap = await ref.get();
if (!snap.exists) { console.error('auto_state no existe'); process.exit(1); }
const state = snap.data() as any;
const applied: Record<string, any> = state.applied || {};

const pending = Object.entries(applied).filter(([, v]) => !Number.isFinite(v?.prodOosRef));
console.log(`aplicaciones registradas: ${Object.keys(applied).length} | sin prodOosRef: ${pending.length}`);
if (pending.length === 0) { console.log('nada que hacer'); process.exit(0); }

const updates: Record<string, any> = {};
for (const [ticker] of pending) {
  const rf = path.join(REPORTS_DIR, `${ticker}.json`);
  if (!fs.existsSync(rf)) { console.log(`  ${ticker}: sin reporte, se omite`); continue; }
  const rep = JSON.parse(fs.readFileSync(rf, 'utf8'));
  const exp = rep?.production_oos?.expectancy;
  if (!Number.isFinite(exp)) { console.log(`  ${ticker}: production_oos.expectancy no numérico, se omite`); continue; }
  updates[ticker] = { prodOosRef: exp, rebaselined_at_ms: Date.now(), rebaseline_source: `reports/${ticker}.json#production_oos.expectancy` };
  console.log(`  ${ticker}: prodOosRef = ${exp} (${rep?.production_oos?.trade_count ?? '?'} trades OOS, reporte ${new Date(rep.timestamp).toISOString().slice(0, 10)})`);
}

if (Object.keys(updates).length === 0) { console.log('nada aplicable'); process.exit(0); }
if (!APPLY) { console.log('\n[dry-run] agregá --apply para escribir'); process.exit(0); }

await db.runTransaction(async (tx: any) => {
  const cur = await tx.get(ref);
  const data = cur.data() as any;
  const next = { ...(data.applied || {}) };
  for (const [ticker, patch] of Object.entries<any>(updates)) {
    if (!next[ticker]) continue;
    next[ticker] = { ...next[ticker], ...patch };
  }
  tx.set(ref, { ...data, applied: next }, { merge: true });
});

const after = (await ref.get()).data() as any;
for (const ticker of Object.keys(updates)) {
  const v = after?.applied?.[ticker];
  if (!Number.isFinite(v?.prodOosRef)) throw new Error(`readback no confirma prodOosRef en ${ticker}`);
  console.log(`  ✅ ${ticker}: prodOosRef=${v.prodOosRef} rebaselined=${v.rebaselined_at_ms ? 'sí' : 'no'}`);
}
console.log('\nlisto');
process.exit(0);
