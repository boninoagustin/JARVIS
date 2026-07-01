import admin from 'firebase-admin';
import { fileURLToPath } from 'url';
import fs from 'fs';

const serviceAccount = JSON.parse(fs.readFileSync(new URL('./service-account.json', import.meta.url), 'utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function checkTrade() {
    console.log("Consultando trade_journal de las últimas horas para GBPUSD...");
    const now = Date.now();
    const snap = await db.collection('trade_journal')
        .orderBy('timestamp', 'desc')
        .limit(200)
        .get();
        
    snap.forEach(doc => {
        const d = doc.data();
        if (d.ticker === 'GBPUSD') {
            console.log(`\n[${new Date(d.timestamp).toISOString()}] ID: ${doc.id}`);
            console.log(`Mode: ${d.mode}`);
            console.log(`Direction: ${d.direction}`);
            console.log(`Trigger: ${d.triggerType || d.dirText}`);
            console.log(`Pts: ${d.points}`);
            console.log(`Session: ${d.session}`);
        }
    });
    
    process.exit(0);
}

checkTrade();
