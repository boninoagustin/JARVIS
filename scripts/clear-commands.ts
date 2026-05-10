import { db } from '../src/db/memory.js';

async function run() {
    console.log("Clearing stuck commands and backtesting status...");
    
    if (db) {
        const snapshot = await db.collection('app_commands').where('status', '==', 'pending').get();
        for (const doc of snapshot.docs) {
            await doc.ref.delete();
            console.log(`Deleted pending command: ${doc.id}`);
        }

        await db.collection('app_settings').doc('backtesting_status').set({
            active: false,
            lastUpdate: Date.now()
        }, { merge: true });
        
        console.log("Status reset to inactive.");
    }
    process.exit(0);
}

run().catch(console.error);