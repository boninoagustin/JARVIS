import { db, storageBucket } from '../db/memory.js';
import { takeTradingViewScreenshot } from './screenshot.js';

const POLL_INTERVAL_MS = 5000; // Poll cada 5 segundos
const VERCEL_SEND_URL = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/send-screenshot`
    : null;

/**
 * Worker que corre en la PC local.
 * Poll Firestore → toma screenshot con Puppeteer → sube a Firebase Storage → llama endpoint Vercel.
 */
export function startScreenshotWorker() {
    if (!db || !storageBucket) {
        console.warn('[SCREENSHOT WORKER] Firebase no inicializado, worker desactivado.');
        return;
    }

    console.log('[SCREENSHOT WORKER] Iniciado. Polling cada 5s...');

    setInterval(async () => {
        try {
            if (!db || !storageBucket) return;
            const snapshot = await db.collection('screenshot_requests')
                .where('status', '==', 'pending')
                .orderBy('timestamp', 'asc')
                .limit(1)
                .get();

            if (snapshot.empty) return;

            const doc = snapshot.docs[0];
            const data = doc.data();
            const requestId = doc.id;

            console.log(`[SCREENSHOT WORKER] Procesando pedido ${requestId} para ${data.ticker}...`);

            // Marcar como 'processing' para evitar que otro poll lo agarre
            await doc.ref.update({ status: 'processing' });

            // Tomar screenshot con Puppeteer (PC local tiene TradingView logueado)
            const screenshotBuffer = await takeTradingViewScreenshot(data.ticker);

            if (!screenshotBuffer) {
                console.error(`[SCREENSHOT WORKER] No se pudo tomar captura de ${data.ticker}`);
                await doc.ref.update({ status: 'failed', error: 'Screenshot failed' });
                return;
            }

            // Subir a Firebase Storage
            const storagePath = `screenshots/${requestId}.jpg`;
            const file = storageBucket!.file(storagePath);
            await file.save(screenshotBuffer, {
                metadata: { contentType: 'image/jpeg' }
            });

            console.log(`[SCREENSHOT WORKER] Imagen subida a Storage: ${storagePath}`);

            // Actualizar Firestore con la ruta de la imagen
            await doc.ref.update({
                status: 'uploaded',
                storage_path: storagePath
            });

            // Llamar al endpoint de Vercel para que envíe a Telegram
            if (VERCEL_SEND_URL) {
                try {
                    const response = await fetch(VERCEL_SEND_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ requestId })
                    });
                    if (response.ok) {
                        console.log(`[SCREENSHOT WORKER] Vercel notificado OK para ${requestId}`);
                    } else {
                        console.error(`[SCREENSHOT WORKER] Vercel respondió ${response.status}`);
                    }
                } catch (err: any) {
                    console.error(`[SCREENSHOT WORKER] Error llamando a Vercel:`, err.message);
                }
            } else {
                console.warn('[SCREENSHOT WORKER] VERCEL_URL no configurada. No se puede notificar a Vercel.');
            }
        } catch (err: any) {
            // Silenciar errores de polling para no saturar logs
            if (!err.message?.includes('requires an index')) {
                console.error('[SCREENSHOT WORKER] Error en polling:', err.message);
            }
        }
    }, POLL_INTERVAL_MS);
}
