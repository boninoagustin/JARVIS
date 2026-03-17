import { config } from '/home/agustinbonino/Descargas/JARVIS/src/config.js';
import FormData from 'form-data';
import https from 'https';
import fs from 'fs';
import axios from 'axios';

const ipv4Agent = new https.Agent({ family: 4, keepAlive: false, timeout: 30000 });

async function main() {
    const targetUserId = config.TELEGRAM_ALLOWED_USER_IDS[0];
    const path = '/tmp/test_image.jpg';
    if (!fs.existsSync(path)) {
        fs.writeFileSync(path, Buffer.from([]));
    }

    try {
        console.log("Enviando foto a Telegram vía Axios con ipv4Agent...");
        const formData = new FormData();
        formData.append('chat_id', targetUserId);
        formData.append('photo', fs.createReadStream(path));
        formData.append('caption', 'Test photo via axios ipv4');

        const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendPhoto`;
        const res = await axios.post(url, formData, {
            headers: formData.getHeaders(),
            httpsAgent: ipv4Agent
        });
        
        console.log("Foto enviada con exito:", res.data.ok);
    } catch (e: any) {
        console.error("Error al enviar foto:", e.message);
    }
    process.exit(0);
}
main().catch(console.error);
