// Revert solo-5M para BTCUSD, USOIL, USDCAD (contaminación 15m del 23-ago)
// Deshabilita choch15m/bos15m/oteChoch15m/oteBos15m en TODAS las sesiones.
import admin from 'firebase-admin';
import fs from 'fs';

const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const TICKERS = ['BTCUSD', 'USOIL', 'USDCAD'];
const TRIG15 = ['choch15m', 'bos15m', 'oteChoch15m', 'oteBos15m'];

(async () => {
    const backupDir = `/opt/JARVIS/backups/revert_15m_${Date.now()}`;
    fs.mkdirSync(backupDir, { recursive: true });
    for (const ticker of TICKERS) {
        const ref = db.collection('asset_configs').doc(ticker);
        const snap = await ref.get();
        if (!snap.exists) { console.log(ticker, ': no existe, skip'); continue; }
        const data = snap.data() || {};
        fs.writeFileSync(`${backupDir}/${ticker}.json`, JSON.stringify(data, null, 2));
        const sessions = data.sessions || {};
        let disabled = 0;
        for (const [sess, sc0] of Object.entries(sessions)) {
            const sc: any = sc0 || {};
            for (const trig of TRIG15) {
                if (sc[trig] && sc[trig].enabled === true) {
                    sc[trig] = { ...sc[trig], enabled: false };
                    disabled++;
                }
            }
        }
        await ref.update({ sessions, updatedAt: Date.now(), updatedBy: 'hermes_solo5m_revert' });
        console.log(`${ticker}: ${disabled} gatillos 15m deshabilitados | backup: ${backupDir}/${ticker}.json`);
    }
    console.log('revert completo');
    process.exit(0);
})();
