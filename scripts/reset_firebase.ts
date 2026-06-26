import { db } from '../src/db/memory.js';

async function clearCollection(collectionPath: string) {
    if (!db) return;
    const collRef = db.collection(collectionPath);
    const MAX_BATCH = 490;
    
    let snapshot = await collRef.limit(MAX_BATCH).get();
    let totalDeleted = 0;
    
    while (!snapshot.empty) {
        const batch = db.batch();
        snapshot.docs.forEach((doc: any) => {
            batch.delete(doc.ref);
            totalDeleted++;
        });
        await batch.commit();
        
        if (snapshot.docs.length < MAX_BATCH) break;
        snapshot = await collRef.limit(MAX_BATCH).get();
    }
    
    console.log(`[RESET] Colección '${collectionPath}' limpiada. Documentos borrados: ${totalDeleted}`);
}

async function run() {
    console.log("Iniciando limpieza de base de datos...");
    
    // Lista de colecciones a borrar.
    const collectionsToClear = [
        'active_trades',
        'trade_journal',
        'raw_signals',
        'market_states',
        'radar_states',
        'screenshot_requests',
        'asset_configs'
    ];

    for (const coll of collectionsToClear) {
        await clearCollection(coll);
    }
    
    console.log("Limpieza finalizada.");
    process.exit(0);
}

run().catch(err => {
    console.error("Error limpiando:", err);
    process.exit(1);
});
