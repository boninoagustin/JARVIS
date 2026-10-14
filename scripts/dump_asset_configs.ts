// dump_asset_configs.ts — vuelca asset_configs de Firestore (estado actual) a JSON legible
import admin from 'firebase-admin';
import fs from 'fs';

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
    const snap = await db.collection('asset_configs').get();
    const out: Record<string, unknown> = {};
    for (const doc of snap.docs) {
        const d = doc.data();
        const clean = JSON.parse(JSON.stringify(d, (_k: string, v: unknown) =>
            (v && typeof v === 'object' && typeof (v as any).toMillis === 'function') ? (v as any).toMillis() : v
        ));
        out[doc.id] = clean;
    }
    fs.writeFileSync('logs/asset_configs_dump.json', JSON.stringify(out, null, 2));
    console.log(`OK ${Object.keys(out).length} docs → logs/asset_configs_dump.json`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
