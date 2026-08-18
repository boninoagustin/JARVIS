// read_ks.js — lee el estado de killswitches en asset_configs (solo lectura)
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';

const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
    const snap = await db.collection('asset_configs').get();
    for (const d of snap.docs) {
        const x = d.data() || {};
        const ks = {
            maxDailyLossR: x.maxDailyLossR ?? 0,
            maxConsecutiveLosses: x.maxConsecutiveLosses ?? 0,
            maxTradesPerDay: x.maxTradesPerDay ?? 0,
            trailingDrawdownR: x.trailingDrawdownR ?? 0,
            dailyProfitTargetR: x.dailyProfitTargetR ?? 0,
        };
        const on = Object.values(ks).some(v => v > 0);
        console.log(d.id.padEnd(9), 'ks:', JSON.stringify(ks), on ? '← ACTIVOS' : '(todo 0)');
    }
    const g = await db.doc('app_settings/global').get();
    console.log('app_settings/global:', JSON.stringify(g.data() ?? null));
    process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
