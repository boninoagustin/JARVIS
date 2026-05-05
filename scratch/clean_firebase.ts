import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

// Manual initialization to avoid relative import issues in scratch script
const credPath = './service-account.json';
const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function deleteCollection(collectionPath: string) {
    const collectionRef = db.collection(collectionPath);
    const snapshot = await collectionRef.get();
    
    console.log(`[CLEANUP] Deleting ${snapshot.size} docs from ${collectionPath}...`);
    
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
    });
    
    await batch.commit();
    console.log(`[CLEANUP] Finished ${collectionPath}.`);
}

async function deleteConversations() {
    const collectionRef = db.collection('conversations');
    const snapshot = await collectionRef.get();
    
    console.log(`[CLEANUP] Deleting conversations and subcollections for ${snapshot.size} users...`);
    
    for (const userDoc of snapshot.docs) {
        // Delete messages
        const messages = await userDoc.ref.collection('messages').get();
        const msgBatch = db.batch();
        messages.docs.forEach(d => msgBatch.delete(d.ref));
        await msgBatch.commit();
        
        // Delete facts
        const facts = await userDoc.ref.collection('facts').get();
        const factBatch = db.batch();
        facts.docs.forEach(d => factBatch.delete(d.ref));
        await factBatch.commit();
        
        // Delete user doc
        await userDoc.ref.delete();
    }
    console.log('[CLEANUP] Finished conversations.');
}

async function run() {
    try {
        await deleteConversations();
        await deleteCollection('radar_states');
        await deleteCollection('trade_journal');
        // Reset app_settings but keep the docs structure if needed?
        // Let's just delete them, the app will recreate with defaults.
        await deleteCollection('app_settings');
        
        console.log('[CLEANUP] ✅ Firebase is clean and ready for a fresh start.');
        process.exit(0);
    } catch (err: any) {
        console.error('[CLEANUP] ❌ Error:', err.message);
        process.exit(1);
    }
}

run();
