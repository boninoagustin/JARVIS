import { config } from '/home/agustinbonino/Descargas/JARVIS/src/config.js';
import { Bot } from 'grammy';
const testBot = new Bot(config.TELEGRAM_BOT_TOKEN, {
    client: {
        buildUrl: (root, token, method) => {
            const proxyUrl = 'https://jarvis-seven-kappa.vercel.app/api/proxy';
            return `${proxyUrl}?method=${method}`;
        }
    }
});
async function main() {
    console.log("Testing sendMessage via Vercel Proxy...");
    try {
        await testBot.api.sendMessage(config.TELEGRAM_ALLOWED_USER_IDS[0], '🚀 ¡Hola Agustin! Mensaje de prueba via Proxy Vercel funcionando.');
        console.log("Success");
    } catch(e) {
        console.error("Failed:", e);
    }
}
main();
