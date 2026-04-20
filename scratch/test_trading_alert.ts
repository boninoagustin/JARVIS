import { config } from '../src/config.js';
import { Bot } from 'grammy';

// Replicating the proxy logic from src/bot/telegram.ts
const bot = new Bot(config.TELEGRAM_BOT_TOKEN, {
    client: {
        buildUrl: (root, token, method) => {
            const proxyUrl = 'https://jarvis-seven-kappa.vercel.app/api/proxy';
            return `${proxyUrl}?method=${method}`;
        }
    }
});

const alertMessage = `🚨 *ALERTA DE TRADING JARVIS* 🚨

*Modelo:* Kronos AI v2
*Par:* BTC/USDT
*Acción:* 🟢 COMPRA (LONG)
*Precio:* $65,432.10

🎯 *Objetivos:*
• TP1: $67,500.00
• TP2: $69,000.00

🛑 *Stop Loss:* $64,200.00

📊 *Razón:*
Cambio de Estructura de Mercado (MSS) alcista en temporalidad de 15m. El perfil de volumen indica una fuerte presión de compra institucional en el nivel actual.

_Este es un mensaje de prueba para verificar que las alertas en español se vean correctamente._`;

async function sendTestAlert() {
    const userId = config.TELEGRAM_ALLOWED_USER_IDS[0];
    if (!userId) {
        console.error("No allowed user IDs found in config.");
        return;
    }

    console.log(`Enviando alerta de trading a usuario ${userId} vía proxy (Español)...`);
    try {
        await bot.api.sendMessage(userId, alertMessage, { parse_mode: 'Markdown' });
        console.log("✅ ¡Alerta enviada con éxito en español!");
    } catch (error) {
        console.error("❌ Error al enviar alerta:", error);
    }
}

sendTestAlert();
