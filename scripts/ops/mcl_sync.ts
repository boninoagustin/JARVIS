#!/usr/bin/env tsx
/**
 * Sincroniza los límites de pérdidas consecutivas por dirección/sesión
 * (sessions.<S>.maxBuyLosses / maxSellLosses) con el ÚLTIMO barrido backtesteado
 * (scripts/periodic_opt/opt_out/directional_mcl_<TICKER>.json).
 *
 * H03 (auditoría 2026-11-05): el sweep es TRAIN-ONLY, así que esto ya NO se aplica solo en
 * el ciclo: publica PROPUESTAS (mcl_proposals/*) y el operador decide.
 *
 * Revisión 4 (06-nov-2026):
 *  - `--apply` consume las PROPUESTAS PUBLICADAS (versión que vio el operador), no el sweep.
 *  - Cada propuesta lleva `proposalId` inmutable; la transacción relee la propuesta y aborta
 *    si cambió la versión, si ya fue aplicada o si quedó `superseded`.
 *  - Todos los diffs de un activo + `applied:true` van en la MISMA transacción (sin parciales).
 *  - La rama APPLY no toca los archivos del sweep (no depende de que existan/parseen).
 *
 * Uso:
 *   npx tsx scripts/ops/mcl_sync.ts            # sólo muestra diferencias
 *   npx tsx scripts/ops/mcl_sync.ts --write    # publica propuestas (ciclo semanal)
 *   npx tsx scripts/ops/mcl_sync.ts --apply    # aplica propuestas pendientes (manual)
 *   npx tsx scripts/ops/mcl_sync.ts --apply --only-enabled
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import admin from 'firebase-admin';
import { applyProposalToSessions } from './mcl_proposal_core.js';

const REPO = '/opt/JARVIS';
const OPT_OUT = path.join(REPO, 'scripts/periodic_opt/opt_out');
const APPLY = process.argv.includes('--apply');
const WRITE = process.argv.includes('--write');
const ONLY_ENABLED = process.argv.includes('--only-enabled');
const MAX_AGE_MS = 8 * 864e5;

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const DIRS = ['maxBuyLosses', 'maxSellLosses'] as const;
type Diff = { ticker: string; session: string; field: string; live: any; want: number };

// Activos habilitados (para --only-enabled; no depende del sweep)
const enabled = new Set<string>();
const cfgs = await db.collection('asset_configs').get();
const byTicker = new Map(cfgs.docs.map((d) => [d.id, d.data() as any]));
for (const [ticker, data] of byTicker) {
  if (data?.enabled === true && !String(data?.disabledReason || '').trim()) enabled.add(ticker);
}

/** Recalcula el resumen con las propuestas realmente pendientes (no aplicadas ni obsoletas). */
async function refreshSummary(at: string): Promise<{ count: number; tickers: string[] }> {
  const snap = await db.collection('mcl_proposals').get();
  let count = 0;
  const tickers: string[] = [];
  for (const d of snap.docs) {
    if (d.id === '_SUMMARY') continue;
    const x = d.data() as any;
    if (x.applied === true || x.superseded === true) continue;
    const n = Array.isArray(x.diffs) ? x.diffs.length : 0;
    if (n) { count += n; tickers.push(d.id); }
  }
  await db.collection('mcl_proposals').doc('_SUMMARY').set({
    generatedAt: at, count, tickers, pendingValues: count, pendingTickers: tickers.length,
  }, { merge: true });
  return { count, tickers };
}

// ── Rama APPLY: sólo Firestore (propuestas publicadas + asset_configs). No lee el sweep. ──
if (APPLY) {
  const props = await db.collection('mcl_proposals').get();
  const pend = props.docs.filter((d) => d.id !== '_SUMMARY' && d.data().applied !== true
    && d.data().superseded !== true && Array.isArray(d.data().diffs) && d.data().diffs.length > 0);
  if (!pend.length) {
    await refreshSummary(new Date().toISOString());
    console.log('✅ no hay propuestas pendientes que aplicar');
    process.exit(0);
  }
  let applied = 0;
  const conflicts: string[] = [];
  for (const doc of pend) {
    if (ONLY_ENABLED && !enabled.has(doc.id)) continue;
    const expectedId = String((doc.data() as any).proposalId || '');
    if (!expectedId) {
      conflicts.push(`${doc.id}: propuesta sin proposalId — republicar con --write`);
      continue;
    }
    try {
      await db.runTransaction(async (tx) => {
        // La propuesta se relee DENTRO de la transacción: si se republicó (otro proposalId),
        // se aplicó o quedó obsoleta, abortamos en vez de aplicar una versión distinta.
        const propSnap = await tx.get(doc.ref);
        const prop = propSnap.data() as any;
        if (!prop) throw new Error('la propuesta ya no existe');
        if (String(prop.proposalId || '') !== expectedId) throw new Error('versión cambiada (se republicó mientras aplicabas)');
        if (prop.applied === true) throw new Error('ya aplicada');
        if (prop.superseded === true) throw new Error('marcada obsoleta (superseded)');
        const atMs = Date.parse(String(prop.generatedAt || ''));
        if (!Number.isFinite(atMs) || Date.now() - atMs > MAX_AGE_MS) throw new Error(`propuesta vieja (${prop.generatedAt})`);
        const ref = db.collection('asset_configs').doc(doc.id);
        const cfgSnap = await tx.get(ref);
        if (!cfgSnap.exists) throw new Error('activo inexistente');
        const cfg = cfgSnap.data() || {};
        const res = applyProposalToSessions(cfg.sessions, prop.diffs);
        if (!res.ok) throw new Error(res.conflict);
        tx.update(ref, { sessions: res.sessions });
        tx.update(doc.ref, { applied: true, appliedAt: new Date().toISOString(), appliedProposalId: expectedId });
      });
      applied++;
      console.log(`  ✅ ${doc.id}: ${(doc.data() as any).diffs.map((x: any) => `${x.session}.${x.field} ${x.current}→${x.proposed}`).join(', ')}`);
    } catch (e: any) {
      conflicts.push(`${doc.id}: ${e.message}`);
    }
  }
  const sum = await refreshSummary(new Date().toISOString());
  console.log(`\n${applied} propuesta(s) aplicadas · ${conflicts.length} conflicto(s) · pendientes: ${sum.count} valores en ${sum.tickers.length} activos`);
  for (const c of conflicts) console.log('  ⚠️ ', c);
  process.exit(conflicts.length ? 2 : 0);
}

// ── Rama dry-run / --write: compara vivo vs sweep ──
function verifiedCycleFilter(): { startedAt: number; evaluated: Set<string>; cycleWeek: string; cycleRunId: string } | null {
  if (!WRITE) return null;
  const stateDir = process.env.MARK_DIR || '/var/lib/jarvis';
  const summaryPath = process.env.WEEKLY_SUMMARY || path.join(OPT_OUT, 'weekly_selection_summary.json');
  const vr = spawnSync('python3', [path.join(REPO, 'scripts/periodic_opt/weekly_cycle_state.py'), 'verify', '--state-dir', stateDir, '--summary', summaryPath], { encoding: 'utf8', timeout: 15_000 });
  if (vr.status !== 0) {
    throw new Error(`mcl_sync --write exige ciclo semanal verificado: ${(vr.stderr || vr.stdout || '').trim()}`);
  }
  const ctx = JSON.parse(vr.stdout);
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const evaluated = new Set<string>(
    (summary.outcomes || [])
      .filter((o: any) => o.outcome === 'evaluated' && !o.deployment_error)
      .map((o: any) => String(o.ticker).toUpperCase()),
  );
  return { startedAt: Number(ctx.started_at), evaluated, cycleWeek: ctx.week, cycleRunId: ctx.run_id };
}

const cycleFilter = verifiedCycleFilter();
const activeSnap = await db.collection('optimization_config').doc('active_tickers').get();
const activeSet = new Set<string>(((activeSnap.data()?.tickers as string[]) || []).map((t) => t.toUpperCase()));

function sweepFiles(): Array<[string, any]> {
  if (!fs.existsSync(OPT_OUT)) return [];
  const out: Array<[string, any]> = [];
  for (const f of fs.readdirSync(OPT_OUT)) {
    if (!f.startsWith('directional_mcl_') || !f.endsWith('.json')) continue;
    const ticker = f.replace('directional_mcl_', '').replace('.json', '').toUpperCase();
    if (activeSet.size > 0 && !activeSet.has(ticker)) continue;
    const full = path.join(OPT_OUT, f);
    const st = fs.statSync(full);
    if (cycleFilter) {
      if (!cycleFilter.evaluated.has(ticker)) continue;
      if (Math.floor(st.mtimeMs) < cycleFilter.startedAt - 1000) continue;
    } else if (Date.now() - st.mtimeMs > MAX_AGE_MS) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.evaluation_manifest) continue;
      out.push([ticker, parsed]);
    } catch {
      continue;
    }
  }
  return out;
}

const diffs: Diff[] = [];
for (const [ticker, report] of sweepFiles()) {
  const cfg = byTicker.get(ticker);
  if (!cfg) continue;
  if (ONLY_ENABLED && !enabled.has(ticker)) continue;
  for (const [dot, want] of Object.entries<any>(report.updates || {})) {
    const parts = dot.split('.');
    if (parts.length !== 3 || parts[0] !== 'sessions' || !DIRS.includes(parts[2] as any)) continue;
    const [, session, field] = parts;
    const live = cfg.sessions?.[session]?.[field];
    if (Number(live) !== Number(want)) diffs.push({ ticker, session, field, live, want: Number(want) });
  }
}

if (diffs.length) {
  console.log(`diferencias vivo vs sweep: ${diffs.length}`);
  for (const d of diffs) console.log(`  ${d.ticker}/${d.session} ${d.field}: ${d.live} → ${d.want}${enabled.has(d.ticker) ? '' : ' (apagado)'}`);
} else {
  console.log('✅ maxBuyLosses/maxSellLosses alineados con el último sweep');
}

if (WRITE) {
  const at = new Date().toISOString();
  const byTickerDiffs = new Map<string, Diff[]>();
  for (const d of diffs) {
    const arr = byTickerDiffs.get(d.ticker) ?? [];
    arr.push(d);
    byTickerDiffs.set(d.ticker, arr);
  }
  for (const [ticker, arr] of byTickerDiffs) {
    await db.collection('mcl_proposals').doc(ticker).set({
      ticker,
      // proposalId inmutable: --apply verifica que la versión aplicada sea la publicada.
      proposalId: crypto.randomUUID(),
      diffs: arr.map((x) => ({ session: x.session, field: x.field, current: x.live === undefined ? null : x.live, proposed: x.want })),
      generatedAt: at, applied: false, superseded: false, source: 'directional_mcl_tune (train)',
    }, { merge: true });
  }
  // Cerrar propuestas de activos que YA no tienen diferencias (antes quedaban vivas).
  const existing = await db.collection('mcl_proposals').get();
  for (const d of existing.docs) {
    if (d.id === '_SUMMARY') continue;
    if (!byTickerDiffs.has(d.id) && d.data().applied !== true) {
      await d.ref.set({ superseded: true, supersededAt: at }, { merge: true });
    }
  }
  const sum = await refreshSummary(at);
  console.log(`\n✅ ${diffs.length} valores publicados (${byTickerDiffs.size} activos) · pendientes totales: ${sum.count} en ${sum.tickers.length} activos`);
  console.log('   aplicar a mano: npx tsx scripts/ops/mcl_sync.ts --apply');
  process.exit(0);
}

console.log('\n[dry-run] agregá --write (propuestas) o --apply (aplicar)');
process.exit(0);
