// push_reports.js — sube reports/*.json a Firestore (opt_reports/{ticker}).
// Uso: npx tsx scripts/periodic_opt/push_reports.js
import { readFileSync, readdirSync } from 'node:fs';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const sa = JSON.parse(readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
    const dir = '/opt/JARVIS/scripts/periodic_opt/reports';
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    if (files.length === 0) { console.log('sin reportes para subir'); process.exit(0); }
    for (const f of files) {
        const ticker = f.replace('.json', '').toUpperCase();
        const report = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
        await db.collection('opt_reports').doc(ticker).set(report);
        console.log(`✓ opt_reports/${ticker} → status ${report.status}`);
    }
    process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
