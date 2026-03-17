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
            credential: admin.credential.cert(serviceAccount),
            storageBucket: 'jarvis-67f66.firebasestorage.app'
        });
        console.log('[DATABASE] Firebase Cloud Memory initialized.');
    } else {
        console.warn('[DATABASE] No valid Firebase credentials found via GOOGLE_APPLICATION_CREDENTIALS.');
    }
} catch (err: any) {
    console.error('[DATABASE] Error initializing Firebase:', err.message);
}

export const db = admin.apps.length > 0 ? admin.firestore() : null;
export const storageBucket = admin.apps.length > 0 ? admin.storage().bucket() : null;

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
        const batch = db.batch();
        const snapshot = await db.collection('conversations').doc(userId.toString()).collection('messages').get();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
    } catch (err: any) {
        console.error('[DATABASE] Error clearing history from Firebase:', err.message);
    }
  }
};
