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
        if (doc.data().status === 'pending' && doc.data().alertText && doc.data().alertText.includes('XAUUSD')) {
            docs.push({ id: doc.id, data: doc.data() });
        }
    });
    docs.sort((a, b) => new Date(a.data.received_at) - new Date(b.data.received_at));
    
    if(docs.length > 0) {
        console.log(`Oldest XAUUSD doc ID: ${docs[0].id}`);
        console.log(`Received at: ${docs[0].data.received_at}`);
        console.log(`Alert text: ${docs[0].data.alertText}`);
    } else {
        console.log("No XAUUSD in pending");
    }
    process.exit(0);
}
test();
