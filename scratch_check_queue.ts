import { db } from './src/db/memory.js';

async function listCollections() {
    try {
        await db.collection('radar_states').doc('NAS100').delete();
        console.log("✅ Eliminado de radar_states/NAS100");
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

listCollections();
