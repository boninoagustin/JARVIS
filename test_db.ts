import { db } from './src/db/memory.js';

async function test() {
    const snap = await db.collection('app_settings').doc('bot_config').get();
    console.log(snap.data());
    process.exit(0);
}
test();
