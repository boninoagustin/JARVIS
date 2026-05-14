import { db } from '../src/db/memory.js';

export const maxDuration = 10;

export default async function handler(req: any, res: any) {
    // 🏥 Healthcheck GET (UptimeRobot / monitoreo)
    if (req.method === 'GET') {
        return res.status(200).json({
            online: true,
            firebase: !!db,
            timestamp: new Date().toISOString(),
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        let alertText = '';
        if (typeof req.body === 'string') {
            alertText = req.body;
        } else if (req.body && req.body.text) {
            alertText = req.body.text;
        } else {
            alertText = JSON.stringify(req.body);
        }

        console.log(`[WEBHOOK TRADINGVIEW] Alerta recibida:`, alertText.substring(0, 200));

        if (!db) {
            throw new Error('Firebase not initialized');
        }

        // Escribimos el update a Firebase sin procesarlo en Vercel
        await db.collection('trading_incoming').add({
            alertText,
            received_at: new Date().toISOString(),
            status: 'pending'
        });

        res.status(200).json({ ok: true, message: 'Alerta SMC encolada' });

    } catch (e: any) {
        console.error('[WEBHOOK TRADINGVIEW] Error inicial:', e.message);
        if (!res.headersSent) {
            return res.status(500).json({ error: 'Error procesando alerta' });
        }
    }
}
