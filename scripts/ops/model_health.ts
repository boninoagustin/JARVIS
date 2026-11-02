#!/usr/bin/env tsx
/**
 * Auditoría del registro de modelos ML — 02-nov-2026.
 *
 * Origen: `ml_model_GBPJPY.json` estaba cargado con accuracy 0.250 / f1 0.250
 * (train_samples=28, test_samples=8). Un modelo peor que una moneda al aire no
 * aporta nada y, si el activo tiene el gate ML prendido, filtra señales al azar.
 *
 * Regla de cuarentena (conservadora, no toca modelos con datos suficientes):
 *   - train_samples < 50            → no hay evidencia para confiar en el modelo
 *   - test_samples  < 20            → la métrica de accuracy no es medible
 *   - accuracy < 0.50               → sistemáticamente equivocado
 * Se marcan como "débil" (sin cuarentena) los de accuracy < 0.55.
 *
 * La cuarentena mueve el archivo a models/quarantine/ y deja un registro en
 * models/quarantine/quarantine.json. El bot deja de cargarlo en el próximo arranque
 * (MLFilterNode auto-descubre modelos por nombre de archivo).
 *
 * Uso:  npx tsx scripts/ops/model_health.ts            # dry-run
 *       npx tsx scripts/ops/model_health.ts --apply    # cuarentena
 */
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

const REPO = '/opt/JARVIS';
const MODELS_DIR = path.join(REPO, 'scripts/hyperopt/models');
const QUAR_DIR = path.join(MODELS_DIR, 'quarantine');
const APPLY = process.argv.includes('--apply');

const MIN_TRAIN_SAMPLES = 50;
const MIN_TEST_SAMPLES = 20;
const MIN_ACCURACY = 0.50;
const WEAK_ACCURACY = 0.55;

const files = fs.readdirSync(MODELS_DIR).filter((f) => /^ml_model_[A-Z0-9]+\.json$/i.test(f)).sort();
if (files.length === 0) { console.log('no hay modelos en el registro'); process.exit(0); }

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const assets = new Map<string, any>();
for (const d of (await db.collection('asset_configs').get()).docs) assets.set(d.id, d.data());

type Row = { file: string; ticker: string; acc: number | null; f1: number | null; train: number | null; test: number | null; gate: boolean; verdict: string; why: string };
const rows: Row[] = [];
for (const f of files) {
  const ticker = f.replace(/^ml_model_/i, '').replace(/\.json$/i, '').toUpperCase();
  let meta: any = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, f), 'utf8')).meta || {}; } catch { /* modelo ilegible */ }
  const acc = Number.isFinite(meta.accuracy) ? meta.accuracy : null;
  const f1 = Number.isFinite(meta.f1) ? meta.f1 : null;
  const train = Number.isInteger(meta.train_samples) ? meta.train_samples : null;
  const test = Number.isInteger(meta.test_samples) ? meta.test_samples : null;
  let verdict = 'OK'; let why = '';
  if (train === null || train < MIN_TRAIN_SAMPLES) { verdict = 'CUARENTENA'; why = `train_samples=${train ?? '?'} < ${MIN_TRAIN_SAMPLES}`; }
  else if (test === null || test < MIN_TEST_SAMPLES) { verdict = 'CUARENTENA'; why = `test_samples=${test ?? '?'} < ${MIN_TEST_SAMPLES}`; }
  else if (acc === null || acc < MIN_ACCURACY) { verdict = 'CUARENTENA'; why = `accuracy=${acc ?? '?'} < ${MIN_ACCURACY}`; }
  else if (acc < WEAK_ACCURACY) { verdict = 'DÉBIL'; why = `accuracy=${acc} < ${WEAK_ACCURACY} (se conserva) `; }
  rows.push({ file: f, ticker, acc, f1, train, test, gate: assets.get(ticker)?.mlGateEnabled === true, verdict, why });
}

const pad = (s: any, n: number) => String(s).padStart(n);
console.log(`${'modelo'.padEnd(22)} ${'acc'.padStart(6)} ${'f1'.padStart(6)} ${'train'.padStart(6)} ${'test'.padStart(5)}  gate  veredicto`);
for (const r of rows) {
  console.log(`${r.ticker.padEnd(22)} ${pad(r.acc?.toFixed(3) ?? '-', 6)} ${pad(r.f1?.toFixed(3) ?? '-', 6)} ${pad(r.train ?? '-', 6)} ${pad(r.test ?? '-', 5)}  ${r.gate ? ' ON ' : ' off'}  ${r.verdict}${r.why ? ' · ' + r.why : ''}`);
}

const toQuarantine = rows.filter((r) => r.verdict === 'CUARENTENA');
if (toQuarantine.length === 0) { console.log('\nnada para cuarentenar'); process.exit(0); }
if (!APPLY) { console.log(`\n[dry-run] se cuarentenarían ${toQuarantine.length}: ${toQuarantine.map((r) => r.ticker).join(', ')}`); process.exit(0); }

fs.mkdirSync(QUAR_DIR, { recursive: true });
const auditFile = path.join(QUAR_DIR, 'quarantine.json');
const audit: any[] = fs.existsSync(auditFile) ? JSON.parse(fs.readFileSync(auditFile, 'utf8')) : [];
for (const r of toQuarantine) {
  const day = new Date().toISOString().slice(0, 10);
  const dest = path.join(QUAR_DIR, `${r.file}.rejected-${day}`);
  fs.renameSync(path.join(MODELS_DIR, r.file), dest);
  audit.push({ ticker: r.ticker, file: r.file, moved_to: path.relative(REPO, dest), at: new Date().toISOString(), reason: r.why, accuracy: r.acc, train_samples: r.train });
  console.log(`  ✅ cuarentena: ${r.ticker} → ${path.basename(dest)} (${r.why})`);
}
fs.writeFileSync(auditFile, JSON.stringify(audit, null, 2));
console.log(`\nregistro de auditoría: ${path.relative(REPO, auditFile)} (${audit.length} entradas)`);
process.exit(0);
