// backup_firestore.js — snapshot de trade_journal + asset_configs + active_trades + app_settings
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const clean = (v) => JSON.parse(JSON.stringify(v, (_k, x) =>
    (x && typeof x === 'object' && typeof x.toMillis === 'function') ? x.toMillis() : x
));

async function dump(coll) {
    const snap = await db.collection(coll).get();
    const out = {};
    for (const d of snap.docs) out[d.id] = clean(d.data());
    return out;
}

async function main() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = '/opt/JARVIS/backups';
    const all = {};
    for (const coll of ['trade_journal', 'asset_configs', 'active_trades', 'app_settings']) {
        all[coll] = await dump(coll);
        console.log(`${coll}: ${Object.keys(all[coll]).length} docs`);
    }
    const file = `${dir}/firestore_snapshot_${ts}.json`;
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
    console.log(`✅ Backup completo en ${file}`);
    process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
