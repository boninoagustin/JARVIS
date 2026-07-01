import { db } from './src/db/memory.js';

async function run() {
  if (!db) {
    console.log("No db!");
    process.exit(1);
  }
  const eursud = await db.collection('asset_configs').doc('EURUSD').get();
  console.log("EURUSD:", JSON.stringify(eursud.data(), null, 2));

  const nas100 = await db.collection('asset_configs').doc('NAS100').get();
  console.log("NAS100:", JSON.stringify(nas100.data(), null, 2));
  
  process.exit(0);
}
run();
