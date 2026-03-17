import admin from 'firebase-admin';
import fs from 'fs';
import nodeFetch from 'node-fetch';

// Inicializar Firebase Admin para el contexto de Vercel
// (en Vercel, las credenciales se pasan como variable de entorno JSON)
if (admin.apps.length === 0) {
    const credEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
    let serviceAccount;
    if (credEnv.startsWith('{')) {
        serviceAccount = JSON.parse(credEnv);
    } else if (fs.existsSync(credEnv)) {
        serviceAccount = JSON.parse(fs.readFileSync(credEnv, 'utf8'));
    }
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            storageBucket: 'jarvis-67f66.firebasestorage.app'
        });
    }
}

const db = admin.apps.length > 0 ? admin.firestore() : null;
const bucket = admin.apps.length > 0 ? admin.storage().bucket() : null;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',')[0]?.trim();

export const maxDuration = 10;

export default async function handler(req: any, res: any) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { requestId } = req.body;

        if (!requestId || !db || !bucket) {
            return res.status(400).json({ error: 'requestId requerido y Firebase debe estar configurado' });
        }

        console.log(`[SEND-SCREENSHOT] Procesando pedido ${requestId}...`);

        // Obtener datos del pedido de Firestore
        const docRef = db.collection('screenshot_requests').doc(requestId);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        const data = docSnap.data()!;

        if (data.status !== 'uploaded') {
            return res.status(400).json({ error: `Estado inválido: ${data.status}. Se esperaba 'uploaded'.` });
        }

        // Descargar imagen de Firebase Storage
        const storagePath = data.storage_path;
        const file = bucket.file(storagePath);
        const [imageBuffer] = await file.download();

        console.log(`[SEND-SCREENSHOT] Imagen descargada de Storage (${imageBuffer.length} bytes)`);

        // Enviar foto a Telegram usando la API HTTP directa
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('chat_id', TELEGRAM_CHAT_ID);
        form.append('photo', imageBuffer, {
            filename: `${data.ticker}_screenshot.jpg`,
            contentType: 'image/jpeg'
        });
        if (data.message) {
            form.append('caption', data.message);
            form.append('parse_mode', 'Markdown');
        }

        const tgResponse = await nodeFetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
            method: 'POST',
            body: form,
            headers: form.getHeaders()
        });

        const tgResult = await tgResponse.json() as any;

        if (tgResult.ok) {
            console.log(`[SEND-SCREENSHOT] Foto enviada a Telegram OK`);

            // Marcar como enviado y borrar imagen de Storage
            await docRef.update({ status: 'sent', sent_at: Date.now() });
            await file.delete().catch(() => {});

            return res.status(200).json({ ok: true, message: 'Screenshot enviado a Telegram' });
        } else {
            console.error(`[SEND-SCREENSHOT] Error de Telegram:`, tgResult);
            await docRef.update({ status: 'telegram_error', error: JSON.stringify(tgResult) });
            return res.status(500).json({ error: 'Error enviando a Telegram', details: tgResult });
        }
    } catch (e: any) {
        console.error('[SEND-SCREENSHOT] Error crítico:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
