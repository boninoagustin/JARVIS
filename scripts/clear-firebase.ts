import { db } from '../src/db/memory.js';

async function deleteCollection(collectionPath: string) {
    if (!db) return;
    
    console.log(`[CLEANUP] Borrando colección: ${collectionPath}...`);
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(500);

    return new Promise<void>((resolve, reject) => {
        deleteQueryBatch(db, query, resolve).catch(reject);
    });
}

async function deleteQueryBatch(db: any, query: any, resolve: any) {
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
        deleteQueryBatch(db, query, resolve);
    });
}

async function clearAll() {
    if (!db) {
        console.error('Base de datos no inicializada.');
        process.exit(1);
    }

    try {
        const collections = ['trade_journal', 'radar_states', 'market_states', 'screenshot_requests', 'trading_incoming'];
        for (const col of collections) {
            await deleteCollection(col);
        }
        console.log('✅ Base de datos limpiada por completo. JARVIS empieza de 0.');
    } catch (err) {
        console.error('❌ Error al borrar Firebase:', err);
    } finally {
        process.exit(0);
    }
}

clearAll();
