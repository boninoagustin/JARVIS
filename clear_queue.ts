import { db } from './src/db/memory.js';

async function run() {
  if (!db) return;
  console.log('Fetching trading_incoming...');
  const snap = await db.collection('trading_incoming').get();
  console.log(`Found ${snap.size} documents.`);
  
  const batch = db.batch();
  let count = 0;
  snap.forEach((doc: any) => {
    batch.delete(doc.ref);
    count++;
  });
  
  if (count > 0) {
    await batch.commit();
    console.log(`Successfully deleted ${count} stuck webhooks.`);
  } else {
    console.log('Queue is already empty.');
  }
  
  setTimeout(() => process.exit(0), 1000);
}
run();
