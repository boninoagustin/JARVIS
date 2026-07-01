const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function test() {
    const snap = await db.collection('trading_incoming').get();
    console.log(`Total incoming messages: ${snap.size}`);
    let pending = 0;
    snap.forEach(doc => {
        if (doc.data().status === 'pending') pending++;
    });
    console.log(`Pending messages: ${pending}`);
    process.exit(0);
}
test();
