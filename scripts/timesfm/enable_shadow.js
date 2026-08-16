// enable_shadow.js — activa TimesFM F2 shadow (dryRun) en TODOS los docs de asset_configs
// para los 10 tickers trackeados por el bridge. SOLO audita: no cambia el trading.
// Uso: npx tsx scripts/timesfm/enable_shadow.js [--apply]
// Sin --apply: lista docs y muestra qué se escribiría (dry-run de la tool).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const TICKERS = ['audcad', 'btcusd', 'eurusd', 'gbpusd', 'nzdusd', 'us500', 'usdcad', 'usdjpy', 'usoil', 'xauusd'];
const APPLY = process.argv.includes('--apply');

const serviceAccount = JSON.parse(readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const main = async () => {
    const snap = await db.collection('asset_configs').get();
    console.log(`[SHADOW] asset_configs: ${snap.size} docs`);
    const ids = snap.docs.map(d => d.id).sort();
    console.log('[SHADOW] ids:', ids.join(', '));

    // Docs que matchean un ticker trackeado por id exacto o prefijo TICKER_*
    const targets = snap.docs.filter(d => {
        const id = d.id.toLowerCase();
        return TICKERS.some(t => id === t || id.startsWith(`${t}_`));
    });
    console.log(`[SHADOW] docs a actualizar: ${targets.map(d => d.id).join(', ')}`);

    if (!APPLY) {
        console.log('[SHADOW] modo verificación — pasá --apply para escribir');
        return;
    }

    // Backup primero
    const backup = {};
    for (const d of snap.docs) backup[d.id] = d.data();
    const bdir = '/opt/JARVIS/scripts/timesfm/ab_out';
    mkdirSync(bdir, { recursive: true });
    const bpath = `${bdir}/asset_configs_backup_${Date.now()}.json`;
    writeFileSync(bpath, JSON.stringify(backup, null, 2));
    console.log(`[SHADOW] backup → ${bpath}`);

    for (const d of targets) {
        await d.ref.set({
            timesfm: { enabled: true, dryRun: true, horizon: 12 },
        }, { merge: true });
        console.log(`[SHADOW] ✓ ${d.id} → timesfm shadow ON (dryRun)`);
    }

    // Verificación read-back
    const snap2 = await db.collection('asset_configs').get();
    for (const d of snap2.docs) {
        const id = d.id.toLowerCase();
        if (TICKERS.some(t => id === t || id.startsWith(`${t}_`))) {
            const tfm = d.data().timesfm;
            console.log(`[SHADOW] verify ${d.id}:`, JSON.stringify(tfm));
        }
    }
    await admin.app().delete();
};

main().then(() => process.exit(0)).catch(e => { console.error('[SHADOW] ERROR:', e.message); process.exit(1); });
