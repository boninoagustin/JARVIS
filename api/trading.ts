import { db } from '../src/db/memory.js';
import { z } from 'zod';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const WebhookPayloadSchema = z.union([
    z.string(),
    z.object({
        text: z.string().optional(),
        content: z.string().optional(),
        message: z.string().optional()
    }).passthrough()
]);

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
        const parsed = WebhookPayloadSchema.safeParse(req.body);
        if (!parsed.success) {
            console.error('[WEBHOOK TW] Invalid payload structure:', parsed.error.message);
            return res.status(400).json({ error: 'Invalid payload structure' });
        }

        const validBody = parsed.data;
        const alertText = typeof validBody === 'string' ? validBody : 
                         validBody?.text || validBody?.content || validBody?.message || JSON.stringify(validBody);
        
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
