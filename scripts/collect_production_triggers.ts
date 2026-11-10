/** Colecta los orígenes (candle-ts + TF) de los gatillos que la CONFIG DE PRODUCCIÓN
 * realmente dispara, para precomputar forecasts TimesFM as-of sobre esos gatillos exactos.
 *
 * A diferencia de collect_triggers.ts (que usa una config laxa 5m como superset para el
 * hyperopt), este script usa la config viva de asset_configs (M5 + M15) para que el A/B
 * de TimesFM mida el efecto sobre los mismos gatillos que el bot ejecuta.
 *
 * Sin escrituras a Firestore ni a asset_configs. Solo lee config + escribe triggers JSONL.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine.js';
import { mapAssetConfig, loadSelectionLogs } from './periodic_opt/selection_context.js';

export async function main(args = process.argv.slice(2)) {
  const ticker = (args[0] || 'GER40').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(ticker)) throw new Error('ticker inválido');
  const outPath = `/opt/JARVIS/logs/${ticker.toLowerCase()}/forecasts/triggers_production.jsonl`;
  const admin = (await import('firebase-admin')).default;
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'))) });
  const db = admin.firestore();
  const snapshot = await db.doc(`asset_configs/${ticker}`).get();
  if (!snapshot.exists) throw new Error(`sin config de asset: ${ticker}`);
  const raw = JSON.parse(JSON.stringify(snapshot.data()));
  const mapped = mapAssetConfig(ticker, raw);
  // Colecta: TimesFM off + collectOnly. El motor registra {ts, ticker, tf} por gatillo.
  // (No usar readOnlyReplayConfig: borra collectOnly/collectPath.)
  mapped.timesfm = { enabled: false, collectOnly: true, collectPath: outPath };
  const dir = `/opt/JARVIS/logs/${ticker.toLowerCase()}/history_exported`;
  const logs = loadSelectionLogs({ ticker, logsDir: dir });
  if (logs.size !== 5) throw new Error('se requieren los cinco datasets TF de producción');
  const entries = await prepareEntries(logs);
  fs.mkdirSync(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  if (fs.existsSync(outPath)) fs.writeFileSync(outPath, '');
  const result = runBacktest(logs, mapped, undefined, entries);
  const lines = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  const byTf: Record<string, number> = {};
  for (const l of lines) { try { const o = JSON.parse(l); byTf[o.tf ?? '?'] = (byTf[o.tf ?? '?'] ?? 0) + 1; } catch {} }
  console.log(JSON.stringify({ ticker, trades: result.trades?.length ?? 0, origins: lines.length, byTf, outPath }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('[collect-production-triggers] ERROR:', e?.message ?? e); process.exitCode = 1; });
}
