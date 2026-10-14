/**
 * plan_paso1_roster.ts — Paso 1 contención (05-oct-2026, aprobado por Bon).
 *
 * Desactiva en vivo los 5 activos con muestra viva negativa (W39-W40), escribiendo
 * enabled=false + disabledReason en asset_configs/{ticker} (el escáner y el dominical
 * respetan disabledReason y no los reactivan). Con --revert los rehabilita.
 *
 * Uso:  npx tsx scripts/plan_paso1_roster.ts [--revert]
 * Nota: update() con merge → NO pisa el resto del doc (sessions, timesfm, etc.).
 */
import admin from 'firebase-admin';
import fs from 'fs';

const sa = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const REVERT = process.argv.includes('--revert');

const REASON =
  'Paso 1 contención (05-oct-2026): muestra viva negativa W39-W40 — re-evaluar en 2 semanas';
const TICKERS = ['GBPJPY', 'EURUSD', 'GBPUSD', 'NZDUSD', 'GBPAUD'];

async function main() {
  for (const t of TICKERS) {
    const ref = db.collection('asset_configs').doc(t);
    const prev = await ref.get();
    const before = prev.exists ? prev.data() : null;
    if (!before) {
      console.log(`${t.padEnd(10)} ⚠️ sin doc previo — no toco`);
      continue;
    }
    if (REVERT) {
      await ref.update({ enabled: true, disabledReason: admin.firestore.FieldValue.delete() });
      console.log(`${t.padEnd(10)} ✅ REVERTIDO → enabled=true (era ${before.enabled}, "${before.disabledReason ?? ''}")`);
    } else {
      await ref.update({ enabled: false, disabledReason: REASON });
      console.log(`${t.padEnd(10)} ✅ DESACTIVADO → enabled=false, reason="${REASON.slice(0, 40)}…" (antes enabled=${before.enabled})`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
