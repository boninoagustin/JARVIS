import { db } from './src/db/memory.js';

async function run() {
  if (!db) return;
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const snap = await db.collection('active_trades').get();
  snap.forEach((doc: any) => {
    console.log(doc.id, "=>", doc.data());
  });
  
  setTimeout(() => process.exit(0), 1000);
}
run();
