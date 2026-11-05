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

if (!diffs.length) {
  console.log('✅ maxBuyLosses/maxSellLosses alineados con el último sweep');
  process.exit(0);
}

console.log(`diferencias vivo vs sweep: ${diffs.length}`);
for (const d of diffs) console.log(`  ${d.ticker}/${d.session} ${d.field}: ${d.live} → ${d.want}${enabled.has(d.ticker) ? '' : ' (apagado)'}`);

if (WRITE && !APPLY) {
  const at = new Date().toISOString();
  const byTicker = new Map<string, Diff[]>();
  for (const d of diffs) {
    const arr = byTicker.get(d.ticker) ?? [];
    arr.push(d);
    byTicker.set(d.ticker, arr);
  }
  for (const [ticker, arr] of byTicker) {
    await db.collection('mcl_proposals').doc(ticker).set({
      ticker, diffs: arr.map((x) => ({ session: x.session, field: x.field, current: x.live === undefined ? null : x.live, proposed: x.want })),
      generatedAt: at, applied: false, source: 'directional_mcl_tune (train)',
    }, { merge: true });
  }
  await db.collection('mcl_proposals').doc('_SUMMARY').set({
    generatedAt: at, count: diffs.length, tickers: [...byTicker.keys()],
  }, { merge: true });
  console.log(`\n✅ ${diffs.length} propuestas publicadas en mcl_proposals/ (${byTicker.size} activos) — se aplican a mano con --apply`);
  process.exit(0);
}

if (!APPLY) {
  console.log('\n[dry-run] agregá --write (propuestas) o --apply (aplicar)');
  process.exit(0);
}

let n = 0;
for (const d of diffs) {
  // Transaccional: relee y escribe atómico; si alguien cambió la config, Firestore reintenta.
  await db.runTransaction(async (tx) => {
    const ref = db.collection('asset_configs').doc(d.ticker);
    const snap = await tx.get(ref);
    const cfg = snap.data() || {};
    const sessions = JSON.parse(JSON.stringify(cfg.sessions || {}));
    sessions[d.session] = { ...(sessions[d.session] || {}), [d.field]: d.want };
    tx.update(ref, { sessions });
  });
  await db.collection('mcl_proposals').doc(d.ticker).set({ applied: true, appliedAt: new Date().toISOString() }, { merge: true }).catch(() => { });
  n++;
}
console.log(`\n✅ ${n} valores aplicados (transaccional, merge por sesión)`);
