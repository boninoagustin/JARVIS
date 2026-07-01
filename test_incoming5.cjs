const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function test() {
    const snap = await db.collection('trading_incoming').get();
    let count = 0;
    snap.forEach(doc => {
        const text = doc.data().alertText || "";
        if (text.includes('BTCUSD') || text.includes('EURUSD') || text.includes('XAUUSD')) {
            count++;
        }
    });
    console.log(`Found ${count} alerts for those tickers in the pending queue.`);
    process.exit(0);
}
test();
