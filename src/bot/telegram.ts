import { Bot, Context, NextFunction, HttpError } from 'grammy';
import { config } from '../config.js';
import { processUserMessage } from '../agent/loop.js';
import nodeFetch from 'node-fetch';
import https from 'https';

const ipv4Agent = new https.Agent({ 
    family: 4, 
    keepAlive: false,
    timeout: 30000 
});

/**
 * JARVIS TELEGRAM CLIENT
 * Exported for modular use in both local index.ts (Long Polling)
 * and Vercel serverless functions (Webhooks).
 */
export const bot = new Bot(config.TELEGRAM_BOT_TOKEN, {
    client: {
        // @ts-ignore
        fetch: (url, options) => {
            return nodeFetch(url, {
                ...options,
                agent: ipv4Agent as any,
                headers: {
                    ...options.headers,
                    'User-Agent': 'Mozilla/5.0'
                }
            });
        }
    }
});

// Whitelist Security
const whitelistMiddleware = async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id;
    if (!userId || !config.TELEGRAM_ALLOWED_USER_IDS.includes(userId)) {
        console.warn(`[SECURITY] Blocked ID: ${userId}.`);
        return;
    }
    return await next();
};

bot.use(whitelistMiddleware);

// Command /start
bot.command('start', async (ctx) => {
    await ctx.reply("🔥 JARVIS is ONLINE (Cloud Mode). How can I help you?");
});

// Global message handling
bot.on('message:text', async (ctx) => {
    const userId = ctx.from!.id;
    const userText = ctx.message!.text!;

    console.log(`[AGENT] Processing from ${userId}: "${userText}"`);
    await ctx.replyWithChatAction('typing');

    try {
       const replyText = await processUserMessage(userId, userText);
       await ctx.reply(replyText, { parse_mode: 'Markdown' });
    } catch (error: any) {
        console.error('[AGENT ERROR]', error);
        await ctx.reply(`⚠️ Processing error: ${error.message || 'Unknown'}`);
    }
});

bot.catch((err) => {
  console.error('[TELEGRAM FATAL]', err.error);
});
