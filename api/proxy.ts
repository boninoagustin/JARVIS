import { config } from '../src/config.js';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    try {
        const url = new URL(req.url);
        const method = url.searchParams.get('method');
        
        if (!method) {
            return new Response('Missing method', { status: 400 });
        }

        const tgUrl = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`;

        // Construir Request Init conservando headers (salvo Host) y reenviando body.
        // req.body es de tipo ReadableStream, lo cual funciona perfectamente en Next.js App Router (edge o node)
        // usando el flag duplex: 'half'.
        const newHeaders = new Headers(req.headers);
        newHeaders.delete('host');
        newHeaders.delete('connection');

        const fetchOptions: any = {
            method: req.method,
            headers: newHeaders,
            body: req.body,
        };

        // duplex: 'half' es requerido por NodeJS 18+ cuando el body es un stream.
        fetchOptions.duplex = 'half';

        const tgResponse = await fetch(tgUrl, fetchOptions);

        return new Response(tgResponse.body, {
            status: tgResponse.status,
            headers: tgResponse.headers
        });
    } catch (e: any) {
        console.error('[PROXY ERROR]', e.message);
        return new Response('Proxy Error', { status: 500 });
    }
}
