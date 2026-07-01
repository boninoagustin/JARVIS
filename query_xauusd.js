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
    .where('ticker', '==', 'XAUUSD')
    .orderBy('timestamp', 'desc')
    .limit(5)
    .get();

  snapshot.forEach(doc => {
    const data = doc.data();
    console.log(`Trade ID: ${doc.id}`);
    console.log(`Entry Time: ${new Date(data.timestamp).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
    if (data.tp1Timestamp) console.log(`TP1 Time: ${new Date(data.tp1Timestamp).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
    if (data.slTimestamp) console.log(`SL/BE Time: ${new Date(data.slTimestamp).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
    console.log(`Result: ${data.result}`);
    console.log(`Entry: ${data.entryPrice}, SL: ${data.slPrice}, Original SL: ${data.originalSlPrice}`);
    console.log('---');
  });
}

run().catch(console.error);
