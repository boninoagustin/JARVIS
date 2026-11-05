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
 * Uso: npx tsx scripts/ops/mcl_sync.ts            # sólo muestra diferencias
 *      npx tsx scripts/ops/mcl_sync.ts --apply    # las aplica (merge por sesión)
 *      npx tsx scripts/ops/mcl_sync.ts --apply --only-enabled
 */
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

const REPO = '/opt/JARVIS';
const OPT_OUT = path.join(REPO, 'scripts/periodic_opt/opt_out');
const APPLY = process.argv.includes('--apply');
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

if (!APPLY) {
  console.log('\n[dry-run] agregá --apply para escribir');
  process.exit(0);
}

let n = 0;
for (const d of diffs) {
  const cfg = (await db.collection('asset_configs').doc(d.ticker).get()).data() || {};
  const sessions = JSON.parse(JSON.stringify(cfg.sessions || {}));
  sessions[d.session] = { ...(sessions[d.session] || {}), [d.field]: d.want };
  await db.collection('asset_configs').doc(d.ticker).update({ sessions });
  n++;
}
console.log(`\n✅ ${n} valores aplicados (merge por sesión, no clobberea otros campos)`);
