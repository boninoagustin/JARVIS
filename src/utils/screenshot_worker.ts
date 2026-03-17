import { db } from '../db/memory.js';
import { takeTradingViewScreenshot } from './screenshot.js';

const POLL_INTERVAL_MS = 5000;
const VERCEL_SEND_URL = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/send-screenshot`
    : null;

/**
 * Worker que corre en la PC local.
 * Poll Firestore → toma screenshot con Puppeteer → envía directo a Vercel como base64.
 */
export function startScreenshotWorker() {
    if (!db) {
        console.warn('[SCREENSHOT WORKER] Firebase no inicializado, worker desactivado.');
        return;
    }
    if (!VERCEL_SEND_URL) {
        console.warn('[SCREENSHOT WORKER] VERCEL_URL no configurada, worker desactivado.');
        return;
    }

    console.log('[SCREENSHOT WORKER] Iniciado. Polling cada 5s...');

    setInterval(async () => {
        try {
            if (!db) return;
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
            await doc.ref.update({ status: 'processing' });

            // Tomar screenshot con Puppeteer
            const screenshotBuffer = await takeTradingViewScreenshot(data.ticker);

            if (!screenshotBuffer) {
                console.error(`[SCREENSHOT WORKER] No se pudo tomar captura de ${data.ticker}`);
                await doc.ref.update({ status: 'failed', error: 'Screenshot failed' });
                return;
            }

            // Enviar directo a Vercel como base64 (sin pasar por Firebase Storage)
            const imageBase64 = screenshotBuffer.toString('base64');
            console.log(`[SCREENSHOT WORKER] Imagen capturada (${screenshotBuffer.length} bytes). Enviando a Vercel...`);

            const response = await fetch(VERCEL_SEND_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requestId,
                    imageBase64,
                    ticker: data.ticker,
                    message: data.message
                })
            });

            if (response.ok) {
                console.log(`[SCREENSHOT WORKER] Vercel procesó OK para ${requestId}`);
                await doc.ref.update({ status: 'sent', sent_at: Date.now() });
            } else {
                const errText = await response.text();
                console.error(`[SCREENSHOT WORKER] Vercel respondió ${response.status}: ${errText}`);
                await doc.ref.update({ status: 'vercel_error', error: errText });
            }
        } catch (err: any) {
            if (!err.message?.includes('requires an index')) {
                console.error('[SCREENSHOT WORKER] Error en polling:', err.message);
            }
        }
    }, POLL_INTERVAL_MS);
}
