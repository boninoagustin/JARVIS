import https from 'https';
import fetch from 'node-fetch';
import { Bot } from 'grammy';
import * as dotenv from 'dotenv';
dotenv.config();

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();

// Force IPv4 for all network requests to avoid Node 24 timeouts with Telegram's dual-stack
const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

const bot = new Bot(token, {
    client: {
        // @ts-ignore
        fetch: (url, options) => fetch(url, { ...options, agent: ipv4Agent })
    }
});

console.log('[DEBUG] Testing bot with FORCED IPv4 agent...');

bot.on('message:text', async (ctx) => {
    console.log('[DEBUG] Got message:', ctx.message.text);
    await ctx.reply(`Echo (IPv4): ${ctx.message.text}`);
});

bot.start({
    drop_pending_updates: true,
    onStart: (info) => console.log('[DEBUG] ECHO BOT ONLINE as @' + info.username)
}).catch(e => console.error('[DEBUG] FAILED TO START:', e));
