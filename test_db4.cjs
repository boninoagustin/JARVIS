const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function test() {
    const tickers = ['BTCUSD', 'EURUSD'];
    for (const t of tickers) {
        const doc = await db.collection('asset_configs').doc(t).get();
        console.log(`--- ${t} ---`);
        console.log(JSON.stringify(doc.data(), null, 2));
    }
    process.exit(0);
}
test();
