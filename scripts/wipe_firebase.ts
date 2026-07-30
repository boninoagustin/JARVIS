import { db } from '../src/db/memory.js';

async function deleteCollection(collectionPath: string, batchSize: number) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    return new Promise<void>((resolve, reject) => {
        deleteQueryBatch(query, resolve).catch(reject);
    });
}

async function deleteQueryBatch(query: any, resolve: any) {
    const snapshot = await query.get();

    const batchSize = snapshot.size;
    if (batchSize === 0) {
        resolve();
        return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc: any) => {
        batch.delete(doc.ref);
    });

    await batch.commit();

    process.nextTick(() => {
        deleteQueryBatch(query, resolve);
    });
}

async function wipeFirebase() {
    console.log('Wiping all data from Firebase...');
    const collections = await db.listCollections();
    for (const collection of collections) {
        console.log(`Deleting collection: ${collection.id}`);
        await deleteCollection(collection.id, 500);
        console.log(`Deleted collection: ${collection.id}`);
    }
    console.log('All collections wiped successfully!');
    process.exit(0);
}

wipeFirebase().catch(console.error);
