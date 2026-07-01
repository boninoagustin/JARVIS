import { db } from './src/db/memory.js';

async function run() {
  if (!db) return;
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const snap = await db.collection('app_settings').doc('global').get();
  console.log("global =>", snap.data());
  
  setTimeout(() => process.exit(0), 1000);
}
run();
