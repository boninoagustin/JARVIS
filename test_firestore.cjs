const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
async function run() {
  const doc = await db.collection('asset_configs').doc('EURUSD').get();
  console.log("EURUSD:", JSON.stringify(doc.data(), null, 2));
  
  const doc2 = await db.collection('asset_configs').doc('NAS100').get();
  console.log("NAS100:", JSON.stringify(doc2.data(), null, 2));
  
  process.exit(0);
}
run();
