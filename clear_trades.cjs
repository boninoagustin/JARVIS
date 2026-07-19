const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');

if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

async function clearTrades() {
  try {
      const snapshot = await db.collection('trades').get();
      console.log(`Encontrados ${snapshot.size} trades para borrar.`);
      
      let batches = [];
      let currentBatch = db.batch();
      let count = 0;
      
      snapshot.docs.forEach((doc) => {
          currentBatch.delete(doc.ref);
          count++;
          if (count === 500) {
              batches.push(currentBatch.commit());
              currentBatch = db.batch();
              count = 0;
          }
      });
      
      if (count > 0) {
          batches.push(currentBatch.commit());
      }
      
      await Promise.all(batches);
      console.log('¡Base de datos limpia de operaciones corruptas!');
      process.exit(0);
  } catch (error) {
      console.error('Error al limpiar la bd:', error);
      process.exit(1);
  }
}

clearTrades();
