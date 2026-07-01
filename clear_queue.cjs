const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function main() {
    console.log("Fetching pending messages...");
    const snap = await db.collection('trading_incoming').where('status', '==', 'pending').get();
    console.log(`Found ${snap.size} pending messages.`);
    
    if (snap.size === 0) {
        console.log("Nothing to clear.");
        process.exit(0);
    }

    const batch = db.batch();
    let count = 0;
    snap.forEach(doc => {
        batch.update(doc.ref, { status: 'skipped_stuck' });
        count++;
    });

    console.log(`Committing batch update for ${count} messages...`);
    await batch.commit();
    console.log("Done.");
    process.exit(0);
}

main().catch(console.error);
