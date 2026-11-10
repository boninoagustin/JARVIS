/** ¿El replay sin ventana (cold start) subcuenta trades vs con ventana de warmup? */
import fs from 'node:fs';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine.js';
import { planReplayWindow } from '../jarvis-os/src/services/replayWindow.js';
import { mapAssetConfig, loadSelectionLogs } from './periodic_opt/selection_context.js';

const ticker = (process.argv[2] || 'JP225').toUpperCase();
const admin = (await import('firebase-admin')).default;
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'))) });
const db = admin.firestore();
const snap = await db.doc(`asset_configs/${ticker}`).get();
const raw = JSON.parse(JSON.stringify(snap.data()));
const dir = `/opt/JARVIS/logs/${ticker.toLowerCase()}/history_exported`;
const logs = loadSelectionLogs({ ticker, logsDir: dir });
const entries = await prepareEntries(logs);

const mapped = mapAssetConfig(ticker, raw);
mapped.timesfm = { enabled: false };
delete mapped.mlGate;

// sin ventana (cold start)
const cold = runBacktest(logs, mapped, undefined, entries);
console.log('sin ventana:', cold.trades?.length ?? 0, 'trades');


