import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

const serviceAccount = JSON.parse(readFileSync('./service-account.json', 'utf8'));

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

async function run() {
  const snapshot = await db.collection('trade_journal')
    .where('ticker', '==', 'USDJPY')
    .get();

  let trades = [];
  snapshot.forEach(doc => {
    trades.push({ id: doc.id, ...doc.data() });
  });

  trades.sort((a, b) => b.timestamp - a.timestamp);
  trades = trades.slice(0, 50);

  for (const data of trades) {
    if (Math.abs(data.entryPrice - 162.550) < 0.05) {
      console.log(`Trade ID: ${data.id}`);
      console.log(JSON.stringify(data, null, 2));
      console.log('---');
    }
  }
}

run().catch(console.error);
