import { Bot } from 'grammy';
import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
dotenv.config();

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const bot = new Bot(token, {
    client: {
        // @ts-ignore
        fetch: fetch
    }
});

console.log('Testing ECHO BOT with token:', token.substring(0, 5) + '...');

bot.on('message:text', async (ctx) => {
    console.log('Got message:', ctx.message.text);
    await ctx.reply(`Echo: ${ctx.message.text}`);
});

bot.start({
    drop_pending_updates: true,
    onStart: (info) => console.log('ECHO BOT ONLINE as @' + info.username)
}).catch(e => console.error('FAILED TO START ECHO BOT:', e));
