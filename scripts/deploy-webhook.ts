import https from 'node:https';
import fetch from 'node-fetch';
import * as dotenv from 'dotenv';

dotenv.config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = 'https://jarvis-seven-kappa.vercel.app/api/webhook';

if (!TOKEN) {
    console.error('FATAL: TELEGRAM_BOT_TOKEN missing in .env');
    process.exit(1);
}

const ipv4Agent = new https.Agent({ family: 4 });

async function setWebhook() {
    console.log(`Setting Webhook to: ${WEBHOOK_URL}`);
    const url = `https://api.telegram.org/bot${TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_URL)}&drop_pending_updates=true`;
    
    try {
        const response = await fetch(url, { agent: ipv4Agent });
        const data = await response.json();
        
        if (data.ok) {
            console.log('✅ Webhook successfully established!');
            console.log(data);
        } else {
            console.error('❌ Failed to set webhook:', data);
        }
    } catch (e: any) {
        console.error('❌ Network error setting webhook:', e.message);
    }
}

setWebhook();
