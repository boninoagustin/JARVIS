import { db } from './src/db/memory.js';

async function run() {
  if (!db) return;
  const snap = await db.collection('trade_journal').where('ctraderPositionId', '==', '269981108').get();
  snap.forEach(doc => console.log(doc.data()));
  process.exit(0);
}
run();
