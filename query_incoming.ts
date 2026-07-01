import { db } from './src/db/memory.js';

async function run() {
  if (!db) return;
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const snap = await db.collection('trading_incoming').get();
  snap.forEach((doc: any) => {
    console.log(doc.data().received_at, "=>", doc.data().alertText);
  });
  console.log(`Total in trading_incoming: ${snap.size}`);
  
  setTimeout(() => process.exit(0), 1000);
}
run();
