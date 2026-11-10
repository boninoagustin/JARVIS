/** Diagnóstico: ¿cuántos trades dispara la config de producción vs minPoints relajado?
 * Aísla el efecto de minBuyPoints/minSellPoints manteniendo el resto igual. */
import fs from 'node:fs';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine.js';
import { mapAssetConfig, loadSelectionLogs } from './periodic_opt/selection_context.js';

const ticker = (process.argv[2] || 'GER40').toUpperCase();
const admin = (await import('firebase-admin')).default;
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'))) });
const db = admin.firestore();
const snap = await db.doc(`asset_configs/${ticker}`).get();
const raw = JSON.parse(JSON.stringify(snap.data()));
const dir = `/opt/JARVIS/logs/${ticker.toLowerCase()}/history_exported`;
const logs = loadSelectionLogs({ ticker, logsDir: dir });
const entries = await prepareEntries(logs);

async function count(minBuy: number, minSell: number, label: string, relaxMinScore = false) {
  const r = JSON.parse(JSON.stringify(raw));
  r.minPointsForBuy = minBuy; r.minPointsForSell = minSell;
  if (relaxMinScore && r.sessions) {
    for (const sn of Object.values(r.sessions) as any[]) {
      for (const tr of Object.values(sn as any) as any[]) {
        if (tr && typeof tr === 'object' && tr.enabled && (tr.minScore ?? 99) > 1) tr.minScore = 1;
      }
    }
  }
  const mapped = mapAssetConfig(ticker, r);
  mapped.timesfm = { enabled: false };
  delete mapped.mlGate;
  const result = runBacktest(logs, mapped, undefined, entries);
  const t = result.trades ?? [];
  const closed = t.filter(x => x.rMultiple !== null && x.rMultiple !== undefined && Number.isFinite(x.rMultiple));
  console.log(`${label}: minBuy=${minBuy} minSell=${minSell} relaxMinScore=${relaxMinScore} → total=${t.length} cerrados=${closed.length}`);
}

await count(6, 4, 'producción');
await count(6, 4, 'producción + minScore relajado', true);
await count(3, 3, 'relajado 3/3');
process.exit(0);
