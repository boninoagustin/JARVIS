import { config } from '/home/agustinbonino/Descargas/JARVIS/src/config.js';
import { Bot, InputFile } from 'grammy';
import https from 'https';
import fs from 'fs';
import nodeFetch from 'node-fetch';

const ipv4Agent = new https.Agent({ family: 4, keepAlive: false, timeout: 30000 });

const testBot = new Bot(config.TELEGRAM_BOT_TOKEN, {
    client: {
        // @ts-ignore
        fetch: (url, options: any = {}) => {
            return nodeFetch(url, {
                ...options,
                agent: ipv4Agent
            });
        }
    }
});

async function main() {
    const targetUserId = config.TELEGRAM_ALLOWED_USER_IDS[0];
    const path = '/tmp/test_image.jpg';
    if (!fs.existsSync(path)) {
        fs.writeFileSync(path, Buffer.from([]));
    }
    
    // We already have /tmp/test_image.jpg from before, let's use it
    try {
        console.log("Enviando foto a Telegram (Custom Fetch minimal)...");
        await testBot.api.sendPhoto(targetUserId, new InputFile(fs.createReadStream('/tmp/test_image.jpg')), { 
            caption: 'Test minimal fetch'
        });
        console.log("Foto enviada con exito.");
    } catch (e: any) {
        console.error("Error al enviar foto:", e);
    }
    process.exit(0);
}
main().catch(console.error);
