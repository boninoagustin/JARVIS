#!/usr/bin/env tsx
/**
 * Sincroniza los límites de pérdidas consecutivas por dirección/sesión
 * (sessions.<S>.maxBuyLosses / maxSellLosses) con el ÚLTIMO barrido backtesteado
 * (scripts/periodic_opt/opt_out/directional_mcl_<TICKER>.json) — 05-nov-2026.
 *
 * Motivo: el sweep semanal (directional_mcl_tune.ts) propone valores medidos con el motor
 * real, pero el pipeline sólo los aplica cuando el candidato COMPLETO del activo pasa el
 * gate. Si el activo queda en HOLD, el config vivo sigue con valores viejos (caso NL25/NY:
 * vivo 1 vs sweep 2, que bloqueó dos SELLs el 5-nov).
 *
 * H03 (auditoría 2026-11-05): el sweep es TRAIN-ONLY, así que esto ya NO se aplica solo en
 * el ciclo: publica PROPUESTAS (mcl_proposals/*) y el operador decide. --apply queda como
 * acción manual y usa transacción (antes get/update no transaccional podía dejar a medias).
 *
 * Uso: npx tsx scripts/ops/mcl_sync.ts            # sólo muestra diferencias
 *      npx tsx scripts/ops/mcl_sync.ts --write    # publica propuestas (ciclo semanal)
 *      npx tsx scripts/ops/mcl_sync.ts --apply    # las aplica (manual, transaccional)
 *      npx tsx scripts/ops/mcl_sync.ts --apply --only-enabled
 */
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

const REPO = '/opt/JARVIS';
const OPT_OUT = path.join(REPO, 'scripts/periodic_opt/opt_out');
const APPLY = process.argv.includes('--apply');
const WRITE = process.argv.includes('--write');
const ONLY_ENABLED = process.argv.includes('--only-enabled');

import { applyProposalToSessions } from './mcl_proposal_core.js';

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const DIRS = ['maxBuyLosses', 'maxSellLosses'] as const;

function sweepFiles(): Array<[string, any]> {
  return fs.readdirSync(OPT_OUT)
    .filter((f) => f.startsWith('directional_mcl_') && f.endsWith('.json'))
    .map((f) => [f.replace('directional_mcl_', '').replace('.json', ''), JSON.parse(fs.readFileSync(path.join(OPT_OUT, f), 'utf8'))] as [string, any]);
}

type Diff = { ticker: string; session: string; field: string; live: any; want: number };
const diffs: Diff[] = [];
const enabled = new Set<string>();

const cfgs = await db.collection('asset_configs').get();
const byTicker = new Map(cfgs.docs.map((d) => [d.id, d.data() as any]));
for (const [ticker, data] of byTicker) {
  if (data?.enabled === true && !String(data?.disabledReason || '').trim()) enabled.add(ticker);
}

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

// applyProposalToSessions vive en mcl_proposal_core.ts (puro y testeable).
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

// ── H03-b: aplicar PROPUESTAS PUBLICADAS (lo que vio el operador), nunca el sweep actual ──
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
        const p = doc.data() as any;
        if (ONLY_ENABLED && !enabled.has(doc.id)) continue;
        const atMs = Date.parse(String(p.generatedAt || ''));
        if (!Number.isFinite(atMs) || Date.now() - atMs > 8 * 864e5) {
            conflicts.push(`${doc.id}: propuesta vieja (${p.generatedAt}) — republicar con --write`);
            continue;
        }
        try {
            // Una transacción por PROPUESTA (todos sus diffs + la marca applied): nunca queda
            // parcial. Si el campo cambió desde la publicación → conflicto, no se pisa.
            await db.runTransaction(async (tx) => {
                const ref = db.collection('asset_configs').doc(doc.id);
                const snap = await tx.get(ref);
                if (!snap.exists) throw new Error('activo inexistente');
                const cfg = snap.data() || {};
                const res = applyProposalToSessions(cfg.sessions, p.diffs);
                if (!res.ok) throw new Error(res.conflict);
                tx.update(ref, { sessions: res.sessions });
                tx.update(doc.ref, { applied: true, appliedAt: new Date().toISOString() });
            });
            applied++;
            console.log(`  ✅ ${doc.id}: ${p.diffs.map((x: any) => `${x.session}.${x.field} ${x.current}→${x.proposed}`).join(', ')}`);
        } catch (e: any) {
            conflicts.push(`${doc.id}: ${e.message}`);
        }
    }
    const sum = await refreshSummary(new Date().toISOString());
    console.log(`\n${applied} propuesta(s) aplicadas · ${conflicts.length} conflicto(s) · pendientes: ${sum.count} valores en ${sum.tickers.length} activos`);
    for (const c of conflicts) console.log('  ⚠️ ', c);
    process.exit(conflicts.length ? 2 : 0);
}

if (diffs.length) {
    console.log(`diferencias vivo vs sweep: ${diffs.length}`);
    for (const d of diffs) console.log(`  ${d.ticker}/${d.session} ${d.field}: ${d.live} → ${d.want}${enabled.has(d.ticker) ? '' : ' (apagado)'}`);
} else {
    console.log('✅ maxBuyLosses/maxSellLosses alineados con el último sweep');
}

if (WRITE) {
    const at = new Date().toISOString();
    const byTicker = new Map<string, Diff[]>();
    for (const d of diffs) {
        const arr = byTicker.get(d.ticker) ?? [];
        arr.push(d);
        byTicker.set(d.ticker, arr);
    }
    for (const [ticker, arr] of byTicker) {
        await db.collection('mcl_proposals').doc(ticker).set({
            ticker,
            diffs: arr.map((x) => ({ session: x.session, field: x.field, current: x.live === undefined ? null : x.live, proposed: x.want })),
            generatedAt: at, applied: false, superseded: false, source: 'directional_mcl_tune (train)',
        }, { merge: true });
    }
    // H03-b: cerrar propuestas de activos que YA no tienen diferencias (antes quedaban vivas).
    const existing = await db.collection('mcl_proposals').get();
    for (const d of existing.docs) {
        if (d.id === '_SUMMARY') continue;
        if (!byTicker.has(d.id) && d.data().applied !== true) {
            await d.ref.set({ superseded: true, supersededAt: at }, { merge: true });
        }
    }
    const sum = await refreshSummary(at);
    console.log(`\n✅ ${diffs.length} valores publicados (${byTicker.size} activos) · pendientes totales: ${sum.count} en ${sum.tickers.length} activos`);
    console.log('   aplicar a mano: npx tsx scripts/ops/mcl_sync.ts --apply');
    process.exit(0);
}

console.log('\n[dry-run] agregá --write (propuestas) o --apply (aplicar)');
process.exit(0);
