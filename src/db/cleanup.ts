import { db } from './memory.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

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
        for (const doc of requestsSnap.docs) {
            const data = doc.data();
            if (data.status === 'sent' || data.status === 'failed' || data.status === 'telegram_error' || data.status === 'vercel_error') {
                batch.delete(doc.ref);
                deletedRequests++;
            }
        }
        if (deletedRequests > 0) {
            await batch.commit();
        }

        // 2. Limpiar market_states antiguos
        const statesSnap = await db.collection('market_states').get();
        const stateBatch = db.batch();
        for (const doc of statesSnap.docs) {
            const data = doc.data();
            if (data.timestamp && data.timestamp < cutoff) {
                stateBatch.delete(doc.ref);
                deletedStates++;
            }
        }
        if (deletedStates > 0) {
            await stateBatch.commit();
        }

        if (deletedRequests > 0 || deletedStates > 0) {
            console.log(`[CLEANUP] Limpieza completada: ${deletedRequests} requests, ${deletedStates} market states borrados.`);
        }
    } catch (err: any) {
        console.error('[CLEANUP] Error en limpieza:', err.message);
    }
}

/**
 * Inicia el timer de limpieza automática (cada 1 hora)
 */
export function startCleanupTimer() {
    console.log('[CLEANUP] Timer de limpieza iniciado (cada 1 hora).');
    cleanupOldData().catch(err => console.error('[CLEANUP] Error en limpieza inicial:', err.message));
    setInterval(() => {
        cleanupOldData().catch(err => console.error('[CLEANUP] Error:', err.message));
    }, ONE_HOUR_MS);
}
