const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
db.collection('app_settings').doc('global').get().then(doc => {
  console.log(doc.data());
  process.exit(0);
});
