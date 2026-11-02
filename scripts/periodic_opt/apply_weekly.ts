// Authorized lifecycle: exact evaluated asset → backup/transaction/readback → paired followup.
// Usage: npx tsx scripts/periodic_opt/apply_weekly.ts --weekly-rollout [--dry-run] [--reports-dir DIR] [--tickers EURUSD,...]
// Entry without --weekly-rollout is retired; it may not overwrite v2 tracking state.
import fs from 'fs';
import path from 'path';
import admin from 'firebase-admin';
import { assetFingerprint, checkCertifiedCandidate } from './weekly_candidate_safety.js';

const REPO = '/opt/JARVIS';
const REPORTS_DIR = process.argv.includes('--reports-dir')
  ? path.resolve(process.argv[process.argv.indexOf('--reports-dir') + 1])
  : path.join(REPO, 'scripts/periodic_opt/reports');
const DRY_RUN = process.argv.includes('--dry-run');
const MC_MIN_SURVIVAL = 0.80;
const FRESH_MS = 48 * 3600e3;

function fresh(report: any): boolean {
  const ts = report?.timestamp;
  const age = Date.now() - ts;
  return Number.isSafeInteger(ts) && ts >= 0 && age >= 0 && age < FRESH_MS;
}

async function guardedAssetWrite(db: any, ref: any, beforeFingerprint: string, next: any): Promise<boolean> {
  const committed = await db.runTransaction(async (transaction: any) => {
    const latest = await transaction.get(ref);
    const current = latest.exists ? latest.data() : {};
    if (assetFingerprint(current) !== beforeFingerprint) return false;
    transaction.set(ref, next);
    return true;
  });
  if (!committed) return false;
  if (assetFingerprint((await ref.get()).data()) !== assetFingerprint(next)) throw new Error('asset readback differs after guarded write');
  return true;
}

function manuallyRetired(config: any): boolean {
  const reason = typeof config?.disabledReason === 'string' ? config.disabledReason.trim() : '';
  return reason.length > 0 && !reason.startsWith('auto-disable:');
}

function gatePass(report: any): { ok: boolean; reason: string } {
  if (!fresh(report)) return { ok: false, reason: 'reporte viejo (>48h)' };
  if (report.status !== 'RECOMMEND') return { ok: false, reason: `status=${report.status ?? 'n/a'}` };
  const surv = report.montecarlo?.survival;
  // 🆕 21-sep-2026 (fail-closed, decisión de Bon): si el MC no pudo evaluarse
  // (pocos trades OOS → skip), NO auto-aplicar. Antes un RECOMMEND sin MC pasaba
  // el gate (USOIL 20-sep: RECOMMEND +0.797R/t sin MC — solo lo salvó estar disabled).
  if (typeof surv !== 'number') return { ok: false, reason: 'MC no evaluado (pocos trades OOS) — fail-closed' };
  if (surv < MC_MIN_SURVIVAL) {
    return { ok: false, reason: `MC survival ${(surv * 100).toFixed(0)}% < ${MC_MIN_SURVIVAL * 100}%` };
  }
  return { ok: true, reason: 'RECOMMEND + MC ok' };
}

async function main() {
  // Only the reviewed lifecycle may mutate configuration. The former entrypoint
  // could overwrite v2 state or restore a position's config without readback.
  if (!process.argv.includes('--weekly-rollout')) {
    throw new Error('Ruta legacy deshabilitada: usar --weekly-rollout con respaldo, seguimiento y control de posiciones');
  }
  const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'service-account.json'), 'utf8'));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  // Explicit operator-authorized lifecycle; never use the legacy fragment path.
  if (process.argv.includes('--weekly-rollout')) {
    const { applyWeeklyRollout } = await import('./weekly_rollout.js');
    const idx = process.argv.indexOf('--tickers');
    if (idx >= 0 && (!process.argv[idx + 1] || process.argv[idx + 1].startsWith('--'))) throw new Error('--tickers requiere una lista explícita');
    const result = await applyWeeklyRollout({db, reportsDir: REPORTS_DIR, dryRun: DRY_RUN,
      tickers: idx >= 0 ? process.argv[idx + 1].split(',') : undefined,
      followupOnly: process.argv.includes('--followup-only'), skipFollowup: process.argv.includes('--skip-followup')});
    console.log(JSON.stringify(result));
    if (result.outcomes.some((entry: any) => entry.error)) process.exitCode = 1;
    return;
  }

  // 🛡️ Rollback: npx tsx apply_weekly.ts --rollback EURUSD 2026-09-15
  const rbIdx = process.argv.indexOf('--rollback');
  if (rbIdx !== -1) {
    const ticker = (process.argv[rbIdx + 1] || '').toUpperCase();
    const dateStr = process.argv[rbIdx + 2];
    if (!/^[A-Z][A-Z0-9]{0,20}$/.test(ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? '')) throw new Error('rollback requiere ticker válido y fecha YYYY-MM-DD exacta');
    const cand = fs.readdirSync(REPORTS_DIR).filter(x => x === `prev_${ticker}_${dateStr}.json` || (x.startsWith(`prev_${ticker}_${dateStr}_`) && x.endsWith('.json'))).sort();
    if (cand.length === 0) { console.error(`No hay snapshot prev_${ticker}_* en ${REPORTS_DIR}`); process.exit(1); }
    const prev = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, cand[cand.length - 1]), 'utf8'));
    if (!DRY_RUN) {
      await db.doc(`asset_configs/${ticker}`).set({ ...prev, rolledBackAt: new Date().toISOString(), source: 'rollback' });
    }
    console.log(`${DRY_RUN ? '[DRY] Se restauraría' : '✅ Rollback aplicado de'} ${ticker} desde ${cand[cand.length - 1]}`);
    process.exit(0);
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  // 🆕 27-sep-2026: estado de auto-gestión (optimization_config/auto_state) —
  // { applied: {T: {at, prodOosRef}}, failing: {T: {weeks, lastTs}} }
  const AUTO_STATE_REF = db.collection('optimization_config').doc('auto_state');
  const autoSnap = await AUTO_STATE_REF.get();
  const autoState: any = autoSnap.exists ? (autoSnap.data() || {}) : {};
  const stApplied: Record<string, { at: number; prodOosRef: number; metric?: string; applied_asset_fingerprint?: string; prev_path?: string }> = autoState.applied || {};
  const stFailing: Record<string, { weeks: number; lastTs: number; period?: number; validation_end_ms?: number }> = autoState.failing || {};

  // 🛡️ Rollback AUTOMÁTICO (decisión de Bon 27-sep): si un cambio auto-aplicado la semana
  // anterior cae >0.10R/t de producción OOS esta semana (y no sale RECOMMEND), revertir
  // al snapshot prev_* más reciente.
  for (const [t, st] of Object.entries<any>(stApplied)) {
    const rf = path.join(REPORTS_DIR, `${t}.json`);
    if (!fs.existsSync(rf)) continue; // sin reporte → no evaluar
    const rep = JSON.parse(fs.readFileSync(rf, 'utf8'));
    if (!fresh(rep)) continue;
    const currentRef = db.doc(`asset_configs/${t}`);
    const current = (await currentRef.get()).data() ?? {};
    if (manuallyRetired(current)) { skipped.push(`${t}: retiro manual — rollback automático retenido`); continue; }
    if (st.metric !== 'expectancy_r_per_trade' || st.applied_asset_fingerprint !== assetFingerprint(current) || rep.production_asset_fingerprint !== assetFingerprint(current)) {
      skipped.push(`${t}: rollback retenido — referencia legacy sin unidad o producción modificada`); continue;
    }
    const prodOos = Number(rep.production_oos?.expectancy);
    if (Number.isFinite(prodOos) && prodOos < st.prodOosRef - 0.10 && rep.status !== 'RECOMMEND') {
      const previous = typeof st.prev_path === 'string' ? path.resolve(st.prev_path) : '';
      const cand = previous && path.dirname(previous) === path.resolve(REPORTS_DIR) && path.basename(previous).startsWith(`prev_${t}_`) && fs.existsSync(previous) ? [path.basename(previous)] : [];
      if (cand.length > 0) {
        const prev = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, cand[cand.length - 1]), 'utf8'));
        if (!DRY_RUN) {
          const committed = await guardedAssetWrite(db, currentRef, assetFingerprint(current), {
            ...prev,
            rolledBackAt: new Date().toISOString(),
            rollbackReason: `auto: prod OOS ${prodOos.toFixed(2)}R/t < ref ${(st.prodOosRef - 0.10).toFixed(2)}R/t`,
            source: 'rollback_auto',
          });
          if (!committed) { skipped.push(`${t}: rollback cancelado por cambio concurrente`); continue; }
        }
        applied.push(`${DRY_RUN ? '[DRY] ' : ''}rollback-auto: ${t} (prod OOS ${prodOos.toFixed(2)} vs ref ${st.prodOosRef.toFixed(2)}R/t) → ${cand[cand.length - 1]}`);
        delete stApplied[t];
        continue;
      }
    }
    delete stApplied[t]; // no cayó → aplicación consolidada
  }

  for (const f of fs.readdirSync(REPORTS_DIR).filter(x => /^[A-Z][A-Z0-9]*\.json$/.test(x))) {
    const report = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
    const ticker = report.ticker;
    if (!ticker) continue;
    const gate = gatePass(report);
    if (!gate.ok) { skipped.push(`${ticker}: ${gate.reason}`); continue; }

    const docRef = db.doc(`asset_configs/${ticker}`);
    const docSnap = await docRef.get();
    const current = docSnap.exists ? (docSnap.data() as any) : {};
    const certification = checkCertifiedCandidate(report, current);
    if (!certification.ok) { skipped.push(`${ticker}: ${certification.reason}`); continue; }
    // Apply only the complete asset that was evaluated, never reassemble fragments here.
    if (manuallyRetired(current)) {
      skipped.push(`${ticker}: retirado por decisión previa — activación manual`); continue;
    }

    const payload: any = JSON.parse(JSON.stringify(report.final_asset_config));
    const appliedFields = [...new Set([...Object.keys(current), ...Object.keys(payload)])]
      .filter(key => JSON.stringify(current[key]) !== JSON.stringify(payload[key]));

    // 🛡️ Snapshot previo (rollback) — SOLO en modo real: un --dry-run lo pisaría
    // con el estado POST-aplicado y destruiría la red de rollback.
    // (pitfall real: 21-sep-2026 dry-run clobberó prev_NL25/GBPAUD/FRA40)
    const prevPath = path.join(REPORTS_DIR, `prev_${ticker}_${new Date().toISOString().split('T')[0]}_${report.timestamp}.json`);

    if (appliedFields.length === 0) { skipped.push(`${ticker}: RECOMMEND sin campos nuevos`); continue; }

    if (DRY_RUN) {
      applied.push(`[DRY] ${ticker}: ${appliedFields.join(', ')} [asset final certificado; sin sincronización de preset no evaluado]`);
      continue;
    }

    if (!fs.existsSync(prevPath)) fs.writeFileSync(prevPath, JSON.stringify(current, null, 2));

    const exactWrite = { ...payload, appliedAt: new Date().toISOString(), source: 'apply_weekly' };
    await db.runTransaction(async transaction => {
      const latest = await transaction.get(docRef);
      const latestConfig = latest.exists ? latest.data() : {};
      if (assetFingerprint(latestConfig) !== report.production_asset_fingerprint) throw new Error(`${ticker}: producción cambió antes del commit`);
      transaction.set(docRef, exactWrite);
    });
    const readback = (await docRef.get()).data();
    if (assetFingerprint(readback) !== assetFingerprint(exactWrite)) throw new Error(`${ticker}: readback difiere del asset escrito`);
    // 🆕 27-sep-2026: registrar aplicación para el rollback automático de la semana siguiente
    stApplied[ticker] = { at: Date.now(), prodOosRef: Number(report.production_oos?.expectancy), metric: 'expectancy_r_per_trade', applied_asset_fingerprint: assetFingerprint(exactWrite), prev_path: prevPath };
    applied.push(`${ticker}: ${appliedFields.join(', ')} (prev → ${path.basename(prevPath)}) [asset certificado verificado; preset preservado]`);
  }

  // Loser changes must already be included in final_asset_config before its gates.
  if (fs.existsSync(path.join(REPORTS_DIR, 'loser_triggers_proposal.json'))) {
    skipped.push('loser-triggers: archivo auxiliar no aplicado después del gate; usar candidato final certificado');
  }

  // 🆕 27-sep-2026 (decisión de Bon): auto-DESACTIVACIÓN — HOLD_MC + producción OOS<0 dos
  // semanas seguidas → enabled=false con disabledReason (reversible desde el panel).
  for (const f of fs.readdirSync(REPORTS_DIR).filter(x => /^[A-Z][A-Z0-9]*\.json$/.test(x))) {
    const rep = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
    const t = rep.ticker;
    if (!t || !fresh(rep)) continue;
    const docRef = db.doc(`asset_configs/${t}`);
    const docSnap = await docRef.get();
    const current = docSnap.exists ? (docSnap.data() as any) : {};
    if (current.enabled === false) { delete stFailing[t]; continue; } // ya apagado (manual o auto)
    if (manuallyRetired(current)) { skipped.push(`${t}: retiro manual — auto-disable retenido`); continue; }
    const prodOos = Number(rep.production_oos?.expectancy);
    const productionMc = rep.production_montecarlo?.survival;
    // A failed proposal does not prove that the production strategy failed.
    const paired = rep.production_asset_fingerprint === assetFingerprint(current);
    const failing = paired && Number.isFinite(productionMc) && productionMc >= 0 && productionMc < MC_MIN_SURVIVAL && Number.isFinite(prodOos) && prodOos < 0;
    if (!failing) { delete stFailing[t]; continue; }
    const period = Math.floor((rep.timestamp - Date.UTC(1970, 0, 5)) / 604800000);
    const validationEnd = rep.evaluation_manifest?.validation_end_ms;
    const previous = stFailing[t];
    if (!Number.isSafeInteger(validationEnd) || validationEnd > rep.timestamp) { skipped.push(`${t}: período de datos no verificable`); continue; }
    if (previous && (previous.period === period || (previous.validation_end_ms !== undefined && validationEnd <= previous.validation_end_ms))) {
      skipped.push(`${t}: reporte/período ya contado o datos no avanzaron`); continue;
    }
    const weeks = previous?.period === period - 1 ? previous.weeks + 1 : 1;
    if (weeks >= 2) {
      if (!DRY_RUN) {
        const committed = await guardedAssetWrite(db, docRef, assetFingerprint(current), {
          ...current,
          enabled: false,
          disabledReason: `auto-disable: HOLD_MC ${weeks} semanas seguidas con producción OOS negativa`,
          updatedAt: new Date().toISOString(),
          updatedBy: 'apply_weekly_auto',
        });
        if (!committed) { skipped.push(`${t}: auto-disable cancelado por cambio concurrente`); continue; }
      }
      applied.push(`auto-disable: ${t} (HOLD_MC ×${weeks}, prod OOS ${prodOos.toFixed(1)}R)`);
      delete stFailing[t];
    } else {
      stFailing[t] = { weeks, lastTs: rep.timestamp, period, validation_end_ms: validationEnd };
      skipped.push(`${t}: HOLD_MC con OOS<0 (semana ${weeks}/2 hacia auto-disable)`);
    }
  }

  // Sizing remains a proposal until account-level prospective certification exists.
  if (fs.existsSync(path.join(REPORTS_DIR, 'sizing_proposal.json'))) {
    skipped.push('sizing: propuesta auxiliar sin certificado de cuenta; no se modifica bot_config');
  }

  // 🆕 27-sep-2026: persistir estado de auto-gestión (rollback + failing) — solo en modo real
  if (!DRY_RUN) {
    await AUTO_STATE_REF.set({ applied: stApplied, failing: stFailing, updatedAt: new Date().toISOString() });
  }

  console.log(DRY_RUN ? '=== APPLY WEEKLY (DRY-RUN) ===' : '=== APPLY WEEKLY (AUTO) ===');
  for (const a of applied) console.log(`  ✅ ${a}`);
  for (const s of skipped) console.log(`  ⏭️  ${s}`);
  console.log(`Resumen: ${applied.length} aplicados | ${skipped.length} saltados`);
  process.exit(0);
}
main().catch(e => { console.error('[apply_weekly] ERROR:', e); process.exit(1); });
