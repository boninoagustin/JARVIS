import { db } from '../src/db/memory.js';

async function run() {
    if (db) {
        const snapshot = await db.collection('app_commands').get();
        console.log(`Found ${snapshot.size} total commands in db.`);
        snapshot.docs.forEach(d => console.log(d.id, d.data()));
    }
    process.exit(0);
}
run().catch(console.error);