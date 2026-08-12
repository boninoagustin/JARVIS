import { db } from './memory.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Limpia datos antiguos de Firebase:
 * - screenshot_requests con status 'sent' o 'failed' de más de 24h
 * - market_states con timestamp de más de 24h
 */
async function cleanupOldData() {
    if (!db) return;

    const now = Date.now();
    const cutoff = now - TWENTY_FOUR_HOURS_MS;
    let deletedRequests = 0;
    let deletedStates = 0;

    try {
        // 1. Limpiar screenshot_requests antiguos (sent/failed)
        const requestsSnap = await db.collection('screenshot_requests')
            .where('timestamp', '<', cutoff)
            .get();

        const batch = db.batch();
        let batchCount = 0;
        const MAX_BATCH_SIZE = 490; // Firestore limit is 500, leave margin
        for (const doc of requestsSnap.docs) {
            if (batchCount >= MAX_BATCH_SIZE) break;
            const data = doc.data();
            if (data.status === 'sent' || data.status === 'failed' || data.status === 'telegram_error') {
                batch.delete(doc.ref);
                deletedRequests++;
                batchCount++;
            }
        }
        if (deletedRequests > 0) {
            await batch.commit();
        }

        // 2. Limpiar market_states antiguos (query filtrada en vez de full-table-scan)
        const statesSnap = await db.collection('market_states')
            .where('timestamp', '<', cutoff)
            .limit(490)
            .get();
        const stateBatch = db.batch();
        for (const doc of statesSnap.docs) {
            stateBatch.delete(doc.ref);
            deletedStates++;
        }
        if (deletedStates > 0) {
            await stateBatch.commit();
        }

        // 3. Limpiar raw_signals antiguos (señales de más de 45 días)
        const FORTY_FIVE_DAYS_MS = 45 * 24 * 60 * 60 * 1000;
        const cutoff45 = now - FORTY_FIVE_DAYS_MS;
        let deletedSignals = 0;
        const signalsSnap = await db.collection('raw_signals')
            .where('timestamp', '<', cutoff45)
            .limit(490)
            .get();
        if (!signalsSnap.empty) {
            const signalBatch = db.batch();
            for (const doc of signalsSnap.docs) {
                signalBatch.delete(doc.ref);
                deletedSignals++;
            }
            await signalBatch.commit();
        }

        if (deletedRequests > 0 || deletedStates > 0 || deletedSignals > 0) {
            console.log(`[CLEANUP] Limpieza completada: ${deletedRequests} requests, ${deletedStates} market states, ${deletedSignals} raw signals borrados.`);
        }
    } catch (err: any) {
        console.error('[CLEANUP] Error en limpieza:', err.message);
    }
}

/**
 * Inicia el timer de limpieza automática (cada 1 hora)
 */
export function startCleanupTimer() {
    if (cleanupInterval) {
        console.log('[CLEANUP] Timer ya está corriendo.');
        return;
    }
    console.log('[CLEANUP] Timer de limpieza iniciado (cada 1 hora).');
    cleanupOldData().catch(err => console.error('[CLEANUP] Error en limpieza inicial:', err.message));
    cleanupInterval = setInterval(() => {
        cleanupOldData().catch(err => console.error('[CLEANUP] Error:', err.message));
    }, ONE_HOUR_MS);
}

/**
 * Detiene el timer de limpieza automática
 */
export function stopCleanupTimer() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
        console.log('[CLEANUP] Timer de limpieza detenido.');
    }
}
