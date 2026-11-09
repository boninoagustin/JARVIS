#!/usr/bin/env tsx
/**
 * Puente CERTIFIED → aplicación — 02-nov-2026 (opción conservadora).
 *
 * Cierra el eslabón que faltaba: el test prospectivo certifica un candidato con datos
 * forward, pero nada lo aplicaba. Este módulo lo aplica por la vía guardada, sin tocar
 * el ciclo semanal ni duplicar su lógica:
 *
 *   1. Sólo si el test está CERTIFIED y su evaluación es fresca (≤ 28 días).
 *   2. Sólo si la producción NO cambió desde el registro (huella idéntica). Si cambió,
 *      la comparación forward ya no es válida → se aborta.
 *   3. Nunca toca controles del operador (enabled, disabledReason, autoTrading, riesgo,
 *      executionPolicy, rolloverPolicy, mlGateEnabled, correlationFilter…): si difieren,
 *      se aborta (se respeta la decisión humana).
 *   4. Escribe con transacción + verificación de huella antes del commit y readback
 *      después; guarda backup en reports/prev_<T>_<fecha>_<ts>.json (mismo formato que
 *      espera el rollback automático).
 *   5. Registra la aplicación en optimization_config/auto_state con la forma exacta que
 *      consume apply_weekly.ts → el rollback automático (>0.10 R/t de caída) la vigila
 *      la semana siguiente.
 *
 * Uso:  npx tsx scripts/ops/prospective_promote.ts            # dry-run
 *       npx tsx scripts/ops/prospective_promote.ts --apply    # aplica
 */
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import { configFingerprint } from '../hyperopt/evaluation_protocol.js';
import { AssetSessionConfigSchema } from '../../src/engine/Types.js';

const REPO = '/opt/JARVIS';
const REPORTS_DIR = path.join(REPO, 'scripts/periodic_opt/reports');
const COLL = 'prospective_tests';
const APPLY = process.argv.includes('--apply');
const MAX_CERT_AGE_DAYS = 28;

// Controles que jamás se pisan desde acá (misma lista que el gate del rollout).
const OPERATOR_CONTROLS = ['enabled', 'disabledReason', 'entryTrigger', 'autoTrading',
  'maxSmartRiskPercent', 'riskPercent', 'executionPolicy', 'executionInstrument',
  'rolloverPolicy', 'mlGateEnabled', 'correlationFilter'];

const DAY = 864e5;
const fp = (v: unknown) => configFingerprint(JSON.parse(JSON.stringify(v ?? null)));

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const tests = await db.collection(COLL).get();
if (tests.size === 0) { console.log('sin tests prospectivos'); process.exit(0); }

let appliedCount = 0;
let wouldApply = 0;
const notes: string[] = [];
for (const doc of tests.docs) {
  const t = doc.data() as any;
  const ticker = doc.id;
  if (t.status !== 'CERTIFIED') { console.log(`  ${ticker}: ${t.status} (nada que promocionar)`); continue; }
  if (t.promoted_at_ms) { console.log(`  ${ticker}: ya promocionado el ${new Date(t.promoted_at_ms).toISOString().slice(0, 10)}`); continue; }

  const ev = t.latest || {};
  const age = (Date.now() - (ev.evaluated_at_ms || 0)) / DAY;
  if (!(age <= MAX_CERT_AGE_DAYS)) { console.log(`  ${ticker}: certificación vieja (${age.toFixed(0)}d > ${MAX_CERT_AGE_DAYS}d), se omite`); continue; }

  const assetRef = db.collection('asset_configs').doc(ticker);
  const current = (await assetRef.get()).data() as any;
  if (!current) { console.log(`  ${ticker}: asset_configs no existe, se omite`); continue; }
  if (current.enabled !== true || (typeof current.disabledReason === 'string' && current.disabledReason.trim())) {
    // Capa 1 (09-nov-2026): el config CERTIFIED se aplica igual aunque el activo esté
    // apagado (queda listo para cuando el roster lo active). Los controles del operador
    // (enabled/disabledReason) NO se tocan: el activo sigue apagado hasta el roster.
    console.log(`  ${ticker}: activo apagado (roster) — se aplica el config certificado, el activo sigue apagado hasta activación por roster`);
  }
  if (typeof ev.production?.expectancy !== 'number' || !Number.isFinite(ev.production.expectancy)) {
    console.log(`  ${ticker}: evidencia sin expectancy de producción, se omite`); continue;
  }

  const candidate = t.candidate_asset_snapshot;
  if (!candidate || typeof candidate !== 'object') { console.log(`  ${ticker}: sin snapshot de candidato, se omite`); continue; }
  if (t.candidate_fingerprint && fp(candidate) !== t.candidate_fingerprint) {
    console.log(`  ${ticker}: el snapshot del candidato no coincide con su huella registrada, se omite`); continue;
  }

  // La comparación forward sólo vale si producción no se movió desde el registro.
  const registeredProd = t.production_asset_snapshot || {};
  if (fp(current) !== fp(registeredProd)) {
    console.log(`  ${ticker}: producción cambió desde el registro — la evidencia forward ya no aplica, se omite`);
    continue;
  }
  if (fp(candidate) === fp(current)) { console.log(`  ${ticker}: el candidato ya está vigente, se omite`); continue; }

  const controlDiff = OPERATOR_CONTROLS.filter((k) => fp(current[k] ?? null) !== fp(candidate[k] ?? null));
  if (controlDiff.length > 0) {
    console.log(`  ${ticker}: el candidato difiere en controles del operador (${controlDiff.join(', ')}), se omite`);
    continue;
  }

  // 🛡️ El bot BLOQUEA el activo si asset_configs no pasa el schema (trading.ts:1252).
  // Nunca escribir un candidato inválido.
  const parsed = AssetSessionConfigSchema.safeParse({ ...candidate, ticker });
  if (!parsed.success) {
    console.log(`  ${ticker}: el candidato no pasa AssetSessionConfigSchema, se omite (evita bloquear el activo)`);
    continue;
  }

  const at = Date.now();
  const prevPath = path.join(REPORTS_DIR, `prev_${ticker}_${new Date(at).toISOString().slice(0, 10)}_${at}.json`);
  const exactWrite = { ...candidate, appliedAt: new Date().toISOString(), source: 'prospective_promote' };
  const delta = (ev.candidate?.expectancy ?? 0) - (ev.production?.expectancy ?? 0);
  console.log(`  ${ticker}: CERTIFIED (n=${ev.candidate?.n}/${ev.production?.n}, Δ ${delta.toFixed(3)} R/t) → ${APPLY ? 'aplicando' : 'se aplicaría (dry-run)'}`);

  if (!APPLY) { wouldApply++; continue; }

  if (!fs.existsSync(prevPath)) fs.writeFileSync(prevPath, JSON.stringify(current, null, 2));
  const beforeFp = fp(current);
  await db.runTransaction(async (tx: any) => {
    const latest = await tx.get(assetRef);
    const latestData = latest.exists ? latest.data() : {};
    if (fp(latestData) !== beforeFp) throw new Error(`${ticker}: producción cambió antes del commit`);
    tx.set(assetRef, exactWrite);
  });
  const readback = (await assetRef.get()).data();
  if (fp(readback) !== fp(exactWrite)) throw new Error(`${ticker}: readback difiere del asset escrito`);

  const autoRef = db.collection('optimization_config').doc('auto_state');
  await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(autoRef);
    const state = snap.exists ? (snap.data() as any) : {};
    const applied = { ...(state.applied || {}) };
    applied[ticker] = {
      at, prodOosRef: ev.production.expectancy, metric: 'expectancy_r_per_trade',
      applied_asset_fingerprint: fp(exactWrite), prev_path: prevPath,
      source: 'prospective_promote',
    };
    tx.set(autoRef, { ...state, applied }, { merge: true });
  });

  await doc.ref.set({
    ...t, status: 'PROMOTED', promoted_at_ms: at,
    promotion: { applied_at: at, previous_fingerprint: beforeFp, applied_fingerprint: fp(exactWrite), prev_path: prevPath, prodOosRef: ev.production.expectancy },
  }, { merge: true });
  appliedCount++;
  notes.push(`• ${ticker}: Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} R/t forward (n cand ${ev.candidate?.n}/prod ${ev.production?.n})`);
  console.log(`  ✅ ${ticker}: aplicado (backup ${path.basename(prevPath)}) y registrado para rollback automático`);
}

// Un cambio aplicado sin aviso sería una sorpresa: se notifica por Telegram, corto y legible.
if (appliedCount > 0) {
  try {
    const env = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    const token = /TELEGRAM_BOT_TOKEN="([^"]+)"/.exec(env)?.[1];
    const chat = /TELEGRAM_ALLOWED_USER_IDS="([^"]+)"/.exec(env)?.[1] || '1348898450';
    if (token) {
      const text = `✅ JARVIS — cambio aplicado por test prospectivo\n${notes.join('\n')}\n🛡 Backup guardado; el rollback automático lo vigila la próxima semana.`;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ chat_id: chat, text }).toString(),
      }).catch(() => undefined);
    }
  } catch { /* la notificación nunca debe impedir la aplicación */ }
}

console.log(`\n${APPLY ? 'aplicados' : '[dry-run] aplicables'}: ${APPLY ? appliedCount : wouldApply}`);
process.exit(0);
