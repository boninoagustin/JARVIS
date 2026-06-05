import admin from 'firebase-admin';
import { config } from '../config.js';
import fs from 'fs';

// Initialize Firebase Admin
try {
    let serviceAccount;
    const credPath = config.GOOGLE_APPLICATION_CREDENTIALS;

    if (credPath && credPath.startsWith('{')) {
        // Assume raw JSON string
        serviceAccount = JSON.parse(credPath);
    } else if (fs.existsSync(credPath)) {
        // Assume file path
        serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('[DATABASE] Firebase Cloud Memory initialized.');
    } else {
        console.warn('[DATABASE] No valid Firebase credentials found via GOOGLE_APPLICATION_CREDENTIALS.');
    }
} catch (err: any) {
    console.error('[DATABASE] Error initializing Firebase:', err.message);
}

let firestoreInstance: admin.firestore.Firestore | null = null;
if (admin.apps.length > 0) {
    firestoreInstance = admin.firestore();
    firestoreInstance.settings({ ignoreUndefinedProperties: true });
}
export const db = firestoreInstance;

export interface Message {
  role: 'user' | 'model' | 'system';
  content: string;
}

export const memory = {
  addMessage: async (userId: number, role: 'user' | 'model' | 'system', content: string) => {
    if (!db) {
        console.warn('[MEMORY] DB not initialized, skipping save.');
        return;
    }
    try {
        await db.collection('conversations').doc(userId.toString()).collection('messages').add({
            role,
            content,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (err: any) {
        console.error('[DATABASE] Error adding message to Firebase:', err.message);
    }
  },
  
  getHistory: async (userId: number, limitCount: number = 20): Promise<Message[]> => {
    if (!db) return [];
    try {
        const snapshot = await db.collection('conversations')
            .doc(userId.toString())
            .collection('messages')
            .orderBy('created_at', 'asc')
            .limitToLast(limitCount)
            .get();

        return snapshot.docs.map(doc => ({
            role: doc.data().role as 'user' | 'model' | 'system',
            content: doc.data().content
        }));
    } catch (err: any) {
        console.error('[DATABASE] Error fetching history from Firebase:', err.message);
        return [];
    }
  },

  clearHistory: async (userId: number) => {
    if (!db) return;
    try {
        const MAX_BATCH = 490;
        const collRef = db.collection('conversations').doc(userId.toString()).collection('messages');
        let snapshot = await collRef.limit(MAX_BATCH).get();
        while (!snapshot.empty) {
            const batch = db.batch();
            snapshot.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            if (snapshot.docs.length < MAX_BATCH) break;
            snapshot = await collRef.limit(MAX_BATCH).get();
        }
    } catch (err: any) {
        console.error('[DATABASE] Error clearing history from Firebase:', err.message);
    }
  },

  addFact: async (userId: number, fact: string) => {
    if (!db) return;
    try {
        await db.collection('conversations').doc(userId.toString()).collection('facts').add({
            fact,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (err: any) {
        console.error('[DATABASE] Error adding fact to Firebase:', err.message);
    }
  },
  
  getFacts: async (userId: number): Promise<string[]> => {
    if (!db) return [];
    try {
        const snapshot = await db.collection('conversations')
            .doc(userId.toString())
            .collection('facts')
            .orderBy('created_at', 'asc')
            .get();

        return snapshot.docs.map(doc => doc.data().fact);
    } catch (err: any) {
        console.error('[DATABASE] Error fetching facts from Firebase:', err.message);
        return [];
    }
  }
};
