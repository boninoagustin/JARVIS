import { db } from '../src/db/memory.js';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    // 🏥 Healthcheck GET se maneja en otro handler
    if (req.method === 'GET') {
        return new Response(JSON.stringify({
            online: true,
            firebase: !!db,
            timestamp: new Date().toISOString(),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (!db) {
        return new Response(JSON.stringify({ error: 'Firebase not initialized' }), { status: 500 });
    }

    try {
        const alertText = await req.text();
        console.log(`[WEBHOOK TW] ${alertText.substring(0, 150)}...`);

        // Escribir a Firebase SIN esperar confirmación
        db.collection('trading_incoming').add({
            alertText,
            received_at: new Date().toISOString(),
            status: 'pending'
        }).catch(e => console.error('[WEBHOOK TW] Firestore write error:', e.message));

        // Responder inmediatamente sin esperar a Firestore
        return new Response(JSON.stringify({ ok: true }), { 
            status: 200, 
            headers: { 'Content-Type': 'application/json' } 
        });

    } catch (e: any) {
        console.error('[WEBHOOK TW] Error:', e.message);
        return new Response(JSON.stringify({ error: 'Bad Request' }), { status: 400 });
    }
}

// GET healthcheck
export async function GET() {
    return new Response(JSON.stringify({
        online: true,
        firebase: !!db,
        timestamp: new Date().toISOString(),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
