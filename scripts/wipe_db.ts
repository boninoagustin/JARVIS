import { db } from '../src/db/memory.js';

async function clearCollection(collectionPath: string) {
    if (!db) {
        console.error('Database not initialized.');
        return;
    }
    const collectionRef = db.collection(collectionPath);
    const snapshot = await collectionRef.get();
    
    if (snapshot.empty) {
        console.log(`Colección ${collectionPath} ya está vacía.`);
        return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc: any) => {
        batch.delete(doc.ref);
    });

    await batch.commit();
    console.log(`✅ Eliminados ${snapshot.size} documentos de ${collectionPath}.`);
}

async function run() {
    console.log('Iniciando limpieza de Firestore...');
    await clearCollection('trade_journal');
    await clearCollection('active_trades');
    console.log('¡Limpieza completada! Base de datos en 0.');
    process.exit(0);
}

run().catch(console.error);
