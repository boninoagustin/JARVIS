const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function test() {
    const snap = await db.collection('trading_incoming').where('status', '==', 'pending').orderBy('received_at', 'asc').limit(1).get();
    snap.forEach(doc => {
        console.log(`Doc ID: ${doc.id}`);
        console.log(`Data: ${JSON.stringify(doc.data())}`);
    });
    process.exit(0);
}
test();
