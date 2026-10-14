// get_current_sessions.ts — vuelca las sesiones VIGENTES de Firestore a un JSON para
// que el hyperopt las use como overlay (paridad de umbrales per-gatillo, sep-2026).
// Uso: npx tsx scripts/get_current_sessions.ts <TICKER> --out /ruta/archivo.json
import fs from 'fs';
import path from 'path';
import admin from 'firebase-admin';

function parseArgs(argv: string[]) {
  const args: Record<string, any> = { ticker: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (!args.ticker) args.ticker = a.toUpperCase();
  }
  if (!args.ticker) { console.error('Uso: get_current_sessions.ts <TICKER> --out FILE'); process.exit(1); }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  const docSnap = await db.doc(`asset_configs/${args.ticker}`).get();
  const current = docSnap.exists ? (docSnap.data() as any) : {};
  const payload = { ticker: args.ticker, sessions: current.sessions || {} };
  const out = args.out || path.resolve(`/tmp/current_sessions_${args.ticker}.json`);
  fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  const nGatillos = Object.values(payload.sessions).reduce(
    (s: number, v: any) => s + Object.keys(v || {}).filter(k => (v[k] || {}).enabled === true).length, 0);
  console.error(`[sessions] ${args.ticker}: ${nGatillos} gatillos enabled → ${out}`);
  process.exit(0);
}
main().catch(e => { console.error('[sessions] ERROR:', e.message); process.exit(1); });
