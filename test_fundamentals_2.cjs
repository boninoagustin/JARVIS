const admin = require('firebase-admin');
const fs = require('fs');
const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
async function test() {
    const snap = await db.collection('app_settings').doc('fundamentals').get();
    if(snap.exists) {
        const data = snap.data();
        console.log("News count:", data.news ? data.news.length : 0);
        console.log("Sentiment keys:", data.sentiment ? Object.keys(data.sentiment).join(", ") : "none");
    }
    process.exit(0);
}
test();
