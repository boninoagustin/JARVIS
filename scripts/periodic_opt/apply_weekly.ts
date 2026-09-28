// apply_weekly.ts — AUTO-APLICADOR del dominical (sep-2026, decisión de Bon).
// Convierte el pipeline de "propone al panel" en "aplica automático CONDICIONADO":
//   ✅ aplica solo status==RECOMMEND Y montecarlo.survival >= 0.80
//   ✅ solo reports frescos (< 48h)
//   ✅ nunca toca activos disabled (enabled===false)
//   ✅ snapshot de la config previa en reports/prev_{ticker}_{YYYY-MM-DD}.json (rollback)
//   ✅ dirección conservadora: disables auto, enables NO
//   ❌ preset del motor (bruteforcer) NO se auto-aplica — migración manual, 1 ciclo de demora
// Uso: npx tsx scripts/periodic_opt/apply_weekly.ts [--dry-run] [--reports-dir DIR]
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import admin from 'firebase-admin';

const REPO = '/opt/JARVIS';
const REPORTS_DIR = process.argv.includes('--reports-dir')
  ? path.resolve(process.argv[process.argv.indexOf('--reports-dir') + 1])
  : path.join(REPO, 'scripts/periodic_opt/reports');
const DRY_RUN = process.argv.includes('--dry-run');
const MC_MIN_SURVIVAL = 0.80;
const FRESH_MS = 48 * 3600e3;

// Mismo mapeo que el panel (APPLY_FIELDS) — best_config → asset_configs
const APPLY_FIELDS: { src: string; dst: string }[] = [
  { src: 'minBuyPoints', dst: 'minPointsForBuy' },
  { src: 'minSellPoints', dst: 'minPointsForSell' },
  { src: 'fixedRR', dst: 'fixedRR' },
  { src: 'slBufferPercent', dst: 'slBufferPercent' },
  { src: 'oteEntryPercent', dst: 'oteEntryPercent' },
  { src: 'minimal_roi', dst: 'minimal_roi' },
  { src: 'tp1StructuralMinRR', dst: 'tp1StructuralMinRR' },
  { src: 'vwapPts', dst: 'vwapPts' },
  { src: 'zoneWeights', dst: 'zoneWeights' },
];

function fresh(report: any): boolean {
  const ts = report?.timestamp || 0;
  return Date.now() - Number(ts) < FRESH_MS;
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

// 🆕 21-sep-2026 (decisión de Bon): al aplicar un ticker, sincronizar también el preset raíz
// optimized_preset_<T>.json con el mejor del hyperopt (Risk/Scoring/Meta). Los bloques TF
// (M15/H1/H4/D1, dueño: bruteforcer) se preservan — load_best_params.py no los pisa.
// El motor vivo lee este archivo una sola vez por ticker×periodo (SMCManager cachea engines),
// así que el efecto en vivo llega con el próximo reinicio del bot; los backtests lo toman ya.
function syncEnginePreset(ticker: string): string {
  // El hyperopt del ciclo semanal escribe a scripts/periodic_opt/opt_out/{T}.json
  // (OPT_OUT_DIR de run_weekly.py), no a la raíz.
  const hypOut = path.join(REPO, 'scripts/periodic_opt/opt_out', `${ticker}.json`);
  if (!fs.existsSync(hypOut)) return 'preset: sin salida hyperopt (no se sincroniza)';
  const livePreset = path.join(REPO, `optimized_preset_${ticker}.json`);
  const prevPreset = path.join(REPO, 'backups', `preset_prev_${ticker}_${new Date().toISOString().split('T')[0]}.json`);
  try {
    if (fs.existsSync(livePreset)) fs.copyFileSync(livePreset, prevPreset);
    execFileSync('python3', [path.join(REPO, 'scripts/hyperopt/load_best_params.py'), hypOut, '--ticker', ticker], { stdio: 'pipe', timeout: 120000 });
    return 'preset: sync OK (efecto vivo al reiniciar bot)';
  } catch (e: any) {
    return `preset: sync FALLÓ (${String(e?.message || e).slice(0, 90)})`;
  }
}

async function main() {
  const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'service-account.json'), 'utf8'));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  // 🛡️ Rollback: npx tsx apply_weekly.ts --rollback EURUSD 2026-09-15
  const rbIdx = process.argv.indexOf('--rollback');
  if (rbIdx !== -1) {
    const ticker = (process.argv[rbIdx + 1] || '').toUpperCase();
    const dateStr = process.argv[rbIdx + 2];
    const cand = fs.readdirSync(REPORTS_DIR).filter(x => x === `prev_${ticker}_${dateStr}.json` || x.startsWith(`prev_${ticker}_`));
    if (cand.length === 0) { console.error(`No hay snapshot prev_${ticker}_* en ${REPORTS_DIR}`); process.exit(1); }
    const prev = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, cand[cand.length - 1]), 'utf8'));
    await db.doc(`asset_configs/${ticker}`).set({ ...prev, rolledBackAt: new Date().toISOString(), source: 'rollback' });
    console.log(`✅ Rollback de ${ticker} aplicado desde ${cand[cand.length - 1]}`);
    process.exit(0);
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  // 🆕 27-sep-2026: estado de auto-gestión (optimization_config/auto_state) —
  // { applied: {T: {at, prodOosRef}}, failing: {T: {weeks, lastTs}} }
  const AUTO_STATE_REF = db.collection('optimization_config').doc('auto_state');
  const autoSnap = await AUTO_STATE_REF.get();
  const autoState: any = autoSnap.exists ? (autoSnap.data() || {}) : {};
  const stApplied: Record<string, { at: number; prodOosRef: number }> = autoState.applied || {};
  const stFailing: Record<string, { weeks: number; lastTs: number }> = autoState.failing || {};

  // 🛡️ Rollback AUTOMÁTICO (decisión de Bon 27-sep): si un cambio auto-aplicado la semana
  // anterior cae >0.10R/t de producción OOS esta semana (y no sale RECOMMEND), revertir
  // al snapshot prev_* más reciente.
  for (const [t, st] of Object.entries<any>(stApplied)) {
    const rf = path.join(REPORTS_DIR, `${t}.json`);
    if (!fs.existsSync(rf)) continue; // sin reporte → no evaluar
    const rep = JSON.parse(fs.readFileSync(rf, 'utf8'));
    if (!fresh(rep)) continue;
    const prodOos = Number(rep.production_oos?.net_pnl_r);
    if (Number.isFinite(prodOos) && prodOos < st.prodOosRef - 0.10 && rep.status !== 'RECOMMEND') {
      const cand = fs.readdirSync(REPORTS_DIR).filter(x => x.startsWith(`prev_${t}_`)).sort();
      if (cand.length > 0) {
        const prev = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, cand[cand.length - 1]), 'utf8'));
        await db.doc(`asset_configs/${t}`).set({
          ...prev,
          rolledBackAt: new Date().toISOString(),
          rollbackReason: `auto: prod OOS ${prodOos.toFixed(2)}R/t < ref ${(st.prodOosRef - 0.10).toFixed(2)}R/t`,
          source: 'rollback_auto',
        });
        applied.push(`rollback-auto: ${t} (prod OOS ${prodOos.toFixed(2)} vs ref ${st.prodOosRef.toFixed(2)}R/t) → ${cand[cand.length - 1]}`);
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
    // 🆕 27-sep-2026 (pedido de Bon): auto-activación de activos propuestos por el optimizador.
    // Gate ya pasado (RECOMMEND + MC survival≥0.80 + reporte fresco). Acá: si el activo está
    // apagado, se activa SOLO si no hay retiro explícito (disabledReason — lo escribe el panel
    // al desactivar a mano, y marca retiros como USOIL) y la producción OOS es ≥ 0.
    const retired = typeof current.disabledReason === 'string' && current.disabledReason.trim().length > 0;
    if (current.enabled === false) {
        if (retired) { skipped.push(`${ticker}: retirado por decisión previa (disabledReason) — activación manual`); continue; }
        const prodOos = Number(report.production_oos?.net_pnl_r);
        if (!Number.isFinite(prodOos) || prodOos < 0) { skipped.push(`${ticker}: deshabilitado y producción OOS <0 — no se auto-activa`); continue; }
    }

    const payload: any = {};
    if (current.enabled !== true) {
        // deja enabled explícito en el doc (∅ → true también, evita ambigüedad)
        payload.enabled = true;
        if (current.enabled === false) {
            const prodOos = Number(report.production_oos?.net_pnl_r);
            console.log(`  🔓 ${ticker}: ACTIVADO automáticamente (RECOMMEND + MC ok + prod OOS ${Number.isFinite(prodOos) ? prodOos.toFixed(1) : 'n/a'}R)`);
        }
    }
    const appliedFields: string[] = [];
    const bc = report.best_config || {};
    for (const { src, dst } of APPLY_FIELDS) {
      if (bc[src] !== undefined) { payload[dst] = bc[src]; appliedFields.push(dst); }
    }
    // sessions: merge por sesión×gatillo desde session_apply (incluye per_trigger_tune)
    const sa = report.session_apply || {};
    if (Object.keys(sa).length > 0) {
      const merged: any = JSON.parse(JSON.stringify(current.sessions || {}));
      for (const [sess, trigs] of Object.entries<any>(sa)) {
        merged[sess] = merged[sess] || {};
        for (const [trig, cfg] of Object.entries<any>(trigs)) {
          merged[sess][trig] = { ...(merged[sess][trig] || {}), ...cfg };
        }
      }
      payload.sessions = merged;
      appliedFields.push('sessions');
    }
    // TimesFM umbral
    if (report.timesfm_apply && typeof report.timesfm_apply === 'object') {
      payload.timesfm = { ...(current.timesfm || {}), minScoreToOverrideReject: report.timesfm_apply.minScoreToOverrideReject };
      appliedFields.push('timesfm.minScoreToOverrideReject');
    }
    // biasConfluence (solo RECOMMEND del propio barrido)
    if (report.bias_confluence?.status === 'RECOMMEND' && report.bias_confluence?.recommended?.bc) {
      payload.biasConfluence = report.bias_confluence.recommended.bc;
      appliedFields.push('biasConfluence');
    }

    // 🛡️ Snapshot previo (rollback) — SOLO en modo real: un --dry-run lo pisaría
    // con el estado POST-aplicado y destruiría la red de rollback.
    // (pitfall real: 21-sep-2026 dry-run clobberó prev_NL25/GBPAUD/FRA40)
    const prevPath = path.join(REPORTS_DIR, `prev_${ticker}_${new Date().toISOString().split('T')[0]}.json`);

    if (appliedFields.length === 0) { skipped.push(`${ticker}: RECOMMEND sin campos nuevos`); continue; }

    if (DRY_RUN) {
      const hasHyp = fs.existsSync(path.join(REPO, 'scripts/periodic_opt/opt_out', `${ticker}.json`));
      applied.push(`[DRY] ${ticker}: ${appliedFields.join(', ')} [preset: ${hasHyp ? 'se sincronizaría' : 'sin salida hyperopt'}]`);
      continue;
    }

    fs.writeFileSync(prevPath, JSON.stringify(current, null, 2));

    await docRef.set({ ...payload, appliedAt: new Date().toISOString(), source: 'apply_weekly' }, { merge: true });
    // 🆕 27-sep-2026: registrar aplicación para el rollback automático de la semana siguiente
    stApplied[ticker] = { at: Date.now(), prodOosRef: Number(report.production_oos?.net_pnl_r) };
    const presetSync = syncEnginePreset(ticker);
    applied.push(`${ticker}: ${appliedFields.join(', ')} (prev → ${path.basename(prevPath)}) [${presetSync}]`);
  }

  // Gatillos perdedores: SOLO disables (minScore=99), enables quedan manuales
  const ltPath = path.join(REPORTS_DIR, 'loser_triggers_proposal.json');
  if (fs.existsSync(ltPath)) {
    const lt = JSON.parse(fs.readFileSync(ltPath, 'utf8'));
    for (const d of lt.disables || []) {
      const { ticker, session, trigger } = d;
      const docRef = db.doc(`asset_configs/${ticker}`);
      const docSnap = await docRef.get();
      if (!docSnap.exists) continue;
      const current = docSnap.data() as any;
      if (current.enabled === false) continue;
      const tgt = current.sessions?.[session]?.[trigger];
      if (tgt?.enabled === false || tgt?.minScore >= 99) continue; // ya estaba apagado
      if (DRY_RUN) {
        applied.push(`[DRY] loser: ${ticker} ${session}/${trigger} → minScore=99`);
        continue;
      }
      const merged = JSON.parse(JSON.stringify(current.sessions || {}));
      merged[session] = merged[session] || {};
      merged[session][trigger] = { ...(merged[session][trigger] || {}), enabled: true, minScore: 99 };
      await db.doc(`asset_configs/${ticker}`).update({ sessions: merged, source: 'apply_weekly_losers' });
      applied.push(`loser-disable: ${ticker} ${session}/${trigger} → minScore=99 (n=${d.n}, exp=${d.exp})`);
    }
    if (lt.enables?.length) {
      // 🆕 27-sep-2026 (decisión de Bon): enables AUTO con los mismos gates del proposal
      // (n≥8, exp≥+0.15R/t, ya filtrados en loser_triggers_proposal.ts). Espejo de los disables:
      // activar gatillo en ESA sesión con minScore=4.
      for (const e of lt.enables) {
        const { ticker, session, trigger } = e;
        const docRef = db.doc(`asset_configs/${ticker}`);
        const docSnap = await docRef.get();
        if (!docSnap.exists) continue;
        const current = docSnap.data() as any;
        if (current.enabled === false) continue;
        const tgt = current.sessions?.[session]?.[trigger];
        if (tgt?.enabled === true && (tgt.minScore ?? 99) < 99) continue; // ya activo
        if (DRY_RUN) {
          applied.push(`[DRY] loser-enable: ${ticker} ${session}/${trigger} → minScore=4 (n=${e.n}, exp=${e.exp})`);
          continue;
        }
        const merged = JSON.parse(JSON.stringify(current.sessions || {}));
        merged[session] = merged[session] || {};
        merged[session][trigger] = { ...(merged[session][trigger] || {}), enabled: true, minScore: 4 };
        await db.doc(`asset_configs/${ticker}`).update({ sessions: merged, source: 'apply_weekly_losers' });
        applied.push(`loser-enable: ${ticker} ${session}/${trigger} → minScore=4 (n=${e.n}, exp=${e.exp})`);
      }
    }
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
    const prodOos = Number(rep.production_oos?.net_pnl_r);
    const failing = rep.status === 'HOLD_MC' && Number.isFinite(prodOos) && prodOos < 0;
    if (!failing) { delete stFailing[t]; continue; }
    const weeks = (stFailing[t]?.weeks ?? 0) + 1;
    if (weeks >= 2) {
      if (!DRY_RUN) {
        await db.doc(`asset_configs/${t}`).update({
          enabled: false,
          disabledReason: `auto-disable: HOLD_MC ${weeks} semanas seguidas con producción OOS negativa`,
          updatedAt: new Date().toISOString(),
          updatedBy: 'apply_weekly_auto',
        });
      }
      applied.push(`auto-disable: ${t} (HOLD_MC ×${weeks}, prod OOS ${prodOos.toFixed(1)}R)`);
      delete stFailing[t];
    } else {
      stFailing[t] = { weeks, lastTs: Date.now() };
      skipped.push(`${t}: HOLD_MC con OOS<0 (semana ${weeks}/2 hacia auto-disable)`);
    }
  }

  // 🆕 27-sep-2026 (decisión de Bon): sizing fraccional por sesión — auto-aplicar a bot_config
  // solo si RECOMMEND (el MC no degrada survival >2pp) Y survival ponderado ≥ 0.85.
  // El bot vivo lo consume vía getSessionSizingFactor() (trading.ts, listener bot_config).
  const spPath = path.join(REPORTS_DIR, 'sizing_proposal.json');
  if (fs.existsSync(spPath)) {
    const sp = JSON.parse(fs.readFileSync(spPath, 'utf8'));
    const survW = Number(sp.mc?.survival_weighted);
    const factors = sp.factors && typeof sp.factors === 'object' ? sp.factors : {};
    if (sp.status === 'RECOMMEND' && Number.isFinite(survW) && survW >= 0.85 && Object.keys(factors).length > 0) {
      const fullFactors: Record<string, number> = { ASIA: 1, LONDON: 1, NY: 1, OFF: 1, ...factors };
      if (!DRY_RUN) {
        await db.collection('app_settings').doc('bot_config').set({
          sizingFactors: fullFactors,
          sizingUpdatedAt: new Date().toISOString(),
        }, { merge: true });
      }
      applied.push(`sizing: ${Object.entries(factors).map(([s, v]) => `${s}=×${Number(v).toFixed(2)}`).join(' ')} [MC survW=${(survW * 100).toFixed(0)}%]`);
    } else {
      skipped.push(`sizing: ${sp.status ?? 'n/a'} (survW=${Number.isFinite(survW) ? (survW * 100).toFixed(0) + '%' : 'n/a'}) — no se aplica`);
    }
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
