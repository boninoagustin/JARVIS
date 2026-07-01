import { db } from './src/db/memory.js';

async function run() {
  if (!db) return;
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const snap = await db.collection('raw_signals').orderBy('timestamp', 'desc').limit(20).get();
  snap.forEach((doc: any) => {
    console.log(doc.data().createdAt, "=>", doc.data().alertText.substring(0, 100));
  });
  
  setTimeout(() => process.exit(0), 1000);
}
run();
