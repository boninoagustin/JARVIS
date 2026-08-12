import admin from 'firebase-admin';
import fs from 'node:fs';

try {
    let serviceAccount;
    const credPath = '/opt/JARVIS/service-account.json';

    if (fs.existsSync(credPath)) {
        serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    }

    if (serviceAccount) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log('[DATABASE] Firebase Cloud Memory initialized.');
    } else {
        console.warn('[DATABASE] No valid Firebase credentials found.');
    }
} catch (err: any) {
    console.error('[DATABASE] Error:', err.message);
}

let firestoreInstance: any = null;
if (admin.apps.length > 0 && process.env.NO_DB !== 'true') {
    firestoreInstance = admin.firestore();
    firestoreInstance.settings({ ignoreUndefinedProperties: true });
} else if (process.env.NO_DB === 'true') {
    // Mock db to bypass if (!db) checks
    firestoreInstance = {
        collection: () => ({
            doc: () => ({
                set: async () => {},
                get: async () => ({ exists: false, data: () => ({}) }),
                update: async () => {},
                delete: async () => {},
                onSnapshot: () => () => {}
            }),
            add: async () => ({ id: 'mock' }),
            where: () => ({
                get: async () => ({ empty: true, docs: [] }),
                orderBy: () => ({
                    get: async () => ({ empty: true, docs: [] })
                })
            }),
            get: async () => ({ empty: true, docs: [], forEach: (_cb:any) => {} }),
            onSnapshot: () => () => {}
        }),
        batch: () => ({
            delete: () => {},
            commit: async () => {}
        })
    };
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

        return snapshot.docs.map((doc: any) => ({
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
            snapshot.docs.forEach((doc: any) => batch.delete(doc.ref));
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

        return snapshot.docs.map((doc: any) => doc.data().fact);
    } catch (err: any) {
        console.error('[DATABASE] Error fetching facts from Firebase:', err.message);
        return [];
    }
  }
};
