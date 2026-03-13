import { db } from '../src/db/memory.js';

async function checkMarketStates() {
    if (!db) {
        console.error('Base de datos no inicializada.');
        process.exit(1);
    }

    try {
        const snapshot = await db.collection('market_states').get();
        if (snapshot.empty) {
            console.log('La colección "market_states" está vacía. No hay alertas guardadas.');
            return;
        }

        console.log('--- ESTADOS DE MERCADO (TRADING) EN FIREBASE ---');
        snapshot.forEach(doc => {
            console.log(`\nTICKER: ${doc.id}`);
            const data = doc.data();
            console.log(`Datos:`, JSON.stringify(data, null, 2));
            if (data.timestamp) {
                const date = new Date(data.timestamp);
                console.log(`Fecha guardada: ${date.toLocaleString()}`);
            }
        });
        console.log('\n-------------------------------------------------');
    } catch (err) {
        console.error('Error al consultar Firebase:', err);
    } finally {
        process.exit(0);
    }
}

checkMarketStates();
