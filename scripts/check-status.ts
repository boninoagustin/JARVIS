import { db } from '../src/db/memory.js';
async function run() {
    if (db) {
        const doc = await db.collection('app_settings').doc('backtesting_status').get();
        console.log("Status:", doc.data());
    }
    process.exit(0);
}
run().catch(console.error);
