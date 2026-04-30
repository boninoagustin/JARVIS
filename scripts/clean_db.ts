import { db } from '../src/db/memory.ts';

async function cleanCollection(name: string) {
    if (!db) {
        console.error(`[CLEANUP] Error: Base de datos no inicializada para ${name}`);
        return;
    }
    console.log(`[CLEANUP] Consultando colección: ${name}...`);
    const snap = await db.collection(name).get();
    
    if (snap.empty) {
        console.log(`[CLEANUP] La colección ${name} ya está vacía.`);
        return;
    }

    console.log(`[CLEANUP] Borrando ${snap.size} documentos de ${name}...`);
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    console.log(`[CLEANUP] ✅ Limpieza de ${name} completada.`);
}

async function run() {
    const target = process.argv[2];
    if (!target) {
        console.log('Uso: npx tsx scripts/clean_db.ts <radar|journal|conversations|all_ephemeral>');
        process.exit(1);
    }

    try {
        if (target === 'radar' || target === 'all_ephemeral') {
            await cleanCollection('radar_states');
        }
        if (target === 'journal' || target === 'all_ephemeral') {
            await cleanCollection('trade_journal');
        }
        if (target === 'conversations' || target === 'all_ephemeral') {
            await cleanCollection('conversations');
        }
        
        if (!['radar', 'journal', 'conversations', 'all_ephemeral'].includes(target)) {
            console.error(`[CLEANUP] Objetivo desconocido: ${target}`);
        }
    } catch (err: any) {
        console.error(`[CLEANUP] ❌ Error crítico:`, err.message);
    }
    
    process.exit(0);
}

run();
