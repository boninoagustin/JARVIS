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
        
        // Ejecución no bloqueante para no penalizar a TradingView
        await processTradingAlert(alertText);

        return res.status(200).json({ ok: true, message: 'Alerta SMC encolada' });
    } catch (e: any) {
        console.error('[WEBHOOK TRADINGVIEW] Error interno:', e.message);
        return res.status(500).json({ error: 'Error procesando alerta' });
    }
}
