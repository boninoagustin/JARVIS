const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function test() {
    const snap = await db.collection('app_settings').doc('fundamentals').get();
    if(snap.exists) {
        console.log(JSON.stringify(snap.data(), null, 2));
    } else {
        console.log("No fundamentals doc found.");
    }
    process.exit(0);
}
test();
