import { processTradingAlert } from '../src/db/trading.js';

export const maxDuration = 10; 

export default async function handler(req: any, res: any) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        let alertText = '';
        if (typeof req.body === 'string') {
            alertText = req.body;
        } else if (req.body && req.body.text) {
            alertText = req.body.text; // En caso de enviar JSON { "text": "..." }
        } else {
            alertText = JSON.stringify(req.body);
        }

        console.log(`[WEBHOOK TRADINGVIEW] Alerta recibida:`, alertText);
        
        // Devolver un código HTTP 200 OK de forma inmediata (antes de procesar nada).
        res.status(200).json({ ok: true, message: 'Alerta SMC encolada' });

        // Ejecución no bloqueante (fire-and-forget)
        processTradingAlert(alertText).catch((err: any) => {
            console.error('[WEBHOOK BACKGROUND ERROR]', err);
        });

    } catch (e: any) {
        console.error('[WEBHOOK TRADINGVIEW] Error inicial:', e.message);
        if (!res.headersSent) {
            return res.status(500).json({ error: 'Error procesando alerta' });
        }
    }
}
