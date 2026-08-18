import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
async function main() {
    const snap = await db.collection('trade_journal').orderBy('timestamp', 'desc').limit(15).get();
    console.log('total en esta página:', snap.size);
    const byStatus = {};
    for (const d of snap.docs) {
        const x = d.data();
        const s = x.ctraderStatus ?? '(sin ctraderStatus)';
        byStatus[s] = (byStatus[s] || 0) + 1;
        if (snap.size <= 6) console.log(' ', d.id, '|', s, '|', x.ticker, '|', x.result, '| ts:', x.timestamp);
    }
    console.log('status en últimas 15:', JSON.stringify(byStatus));
    process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
