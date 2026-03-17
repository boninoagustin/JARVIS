import nodeFetch from 'node-fetch';
import FormData from 'form-data';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',')[0]?.trim();

export const maxDuration = 10;

export default async function handler(req: any, res: any) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { imageBase64, ticker, message } = req.body;

        if (!imageBase64 || !ticker) {
            return res.status(400).json({ error: 'imageBase64 y ticker son requeridos' });
        }

        console.log(`[SEND-SCREENSHOT] Recibida imagen para ${ticker} (${imageBase64.length} chars base64)`);

        // Convertir base64 a Buffer
        const imageBuffer = Buffer.from(imageBase64, 'base64');

        // Enviar foto a Telegram usando la API HTTP directa
        const form = new FormData();
        form.append('chat_id', TELEGRAM_CHAT_ID);
        form.append('photo', imageBuffer, {
            filename: `${ticker}_screenshot.jpg`,
            contentType: 'image/jpeg'
        });
        if (message) {
            form.append('caption', message);
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
            return res.status(200).json({ ok: true });
        } else {
            console.error(`[SEND-SCREENSHOT] Error de Telegram:`, tgResult);
            return res.status(500).json({ error: 'Error enviando a Telegram', details: tgResult });
        }
    } catch (e: any) {
        console.error('[SEND-SCREENSHOT] Error crítico:', e.message);
        return res.status(500).json({ error: e.message });
    }
}
