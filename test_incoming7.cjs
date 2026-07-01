const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function test() {
    const snap = await db.collection('trading_incoming').get();
    let docs = [];
    snap.forEach(doc => {
        if (doc.data().alertText && doc.data().alertText.includes('HEARTBEAT')) {
            docs.push({ id: doc.id, data: doc.data() });
        }
    });
    if(docs.length > 0) {
        console.log(`Alert text: ${docs[0].data.alertText}`);
    } else {
        console.log("No HEARTBEAT in pending");
    }
    process.exit(0);
}
test();
