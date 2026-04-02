import { db } from '../src/db/memory.js';

export const maxDuration = 60; // máximo tiempo de respuesta
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    if (!db) {
        console.error('[WEBHOOK] Failed to receive update: Firebase not initialized.');
        return new Response('Internal Server Error', { status: 500 });
    }

    try {
        const update = await req.json();
        
        // Escribimos el update a Firebase sin procesarlo.
        await db.collection('telegram_incoming').add({
            update,
            received_at: new Date().toISOString(),
            status: 'pending' // PC local lo procesará
        });

        // Retornar 200 inmediatamente a Telegram
        return new Response('OK', { status: 200 });
    } catch (e: any) {
        console.error('[WEBHOOK ERROR]', e.message);
        return new Response('Bad Request', { status: 400 });
    }
}
