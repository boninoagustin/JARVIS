import { db } from './src/db/memory.js';

async function run() {
  if (!db) {
    console.log("No db!");
    process.exit(1);
  }
  const off = await db.collection('asset_configs').doc('NAS100_OFF').get();
  console.log("NAS100_OFF exists:", off.exists);
  
  process.exit(0);
}
run();
