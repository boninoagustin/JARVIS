import { db } from './src/db/memory.js';
async function test() {
  const snap = await db.collection('trade_journal').orderBy('timestamp', 'desc').limit(20).get();
  snap.docs.forEach(d => {
    console.log(d.id, d.data().timestamp, d.data().ticker, d.data().direction, d.data().events);
  });
  process.exit(0);
}
test();
