import { db } from './src/db/memory.js';

async function run() {
  if (!db) return;
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const snap = await db.collection('raw_signals')
    .orderBy('timestamp', 'desc')
    .get();
    
  let count = 0;
  snap.forEach((doc: any) => {
    const text = doc.data().alertText;
    if (text.includes("EVENTO_CHOCH") || text.includes("BOS")) {
       if (count < 20) console.log(doc.data().createdAt, "=>", text.substring(0, 100));
       count++;
    }
  });
  
  setTimeout(() => process.exit(0), 1000);
}
run();
