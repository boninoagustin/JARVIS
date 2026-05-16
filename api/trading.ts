import { db } from '../src/db/memory.js';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export default async function handler(req: any, res: any) {
    // 🏥 Healthcheck GET
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

    if (!db) {
        return res.status(500).json({ error: 'Firebase not initialized' });
    }

    try {
        // 📥 Leer el raw body como texto y guardarlo a Firebase
        const alertText = typeof req.body === 'string' ? req.body : 
                         req.body?.text || JSON.stringify(req.body);
        
        console.log(`[WEBHOOK TW] ${alertText.substring(0, 120)}...`);

        // 🔥 FIRE & FORGET: escribir sin await para responder rápido a TradingView
        db.collection('trading_incoming').add({
            alertText,
            received_at: new Date().toISOString(),
            status: 'pending'
        }).catch((e: any) => console.error('[WEBHOOK TW] Firestore write error:', e.message));

        // ⚡ Responder inmediatamente
        return res.status(200).json({ ok: true });

    } catch (e: any) {
        console.error('[WEBHOOK TW] Error:', e.message);
        return res.status(500).json({ error: 'Internal Error' });
    }
}
