import { db } from './src/db/memory.js';
async function run() {
    await db.collection('app_settings').doc('backtesting_status').set({
        active: false,
        lastUpdate: Date.now()
    }, { merge: true });
    console.log("Done");
    process.exit(0);
}
run();
