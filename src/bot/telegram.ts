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
        fetch: (url, options = {}) => {
            const headers = {
                ...(options.headers || {}),
                'User-Agent': 'Mozilla/5.0'
            };
            return nodeFetch(url, {
                ...options,
                agent: ipv4Agent as any,
                headers
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

// Global text message handling
bot.on('message:text', async (ctx) => {
    const userId = ctx.from!.id;
    const userText = ctx.message!.text!;
    await handleIncomingText(ctx, userId, userText);
});

// Voice message handling
bot.on('message:voice', async (ctx) => {
    const userId = ctx.from!.id;
    console.log(`[BOT] Voice note received from ${userId}`);
    
    await ctx.replyWithChatAction('typing');
    
    try {
        // 1. Get file path from Telegram
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        
        // 2. Download the file
        console.log('[BOT] Downloading voice note...');
        // @ts-ignore
        const response = await nodeFetch(fileUrl);
        const buffer = await response.buffer();

        // 3. Transcribe using Groq
        const transcription = await import('../llm/client.js').then(m => m.transcribeAudio(buffer, 'voice.ogg'));
        console.log(`[BOT] Transcription result: "${transcription}"`);

        if (!transcription || transcription.length < 2) {
            await ctx.reply("No pude entender el audio, ¿podrías repetirlo?");
            return;
        }

        // 4. Process as normal text
        await ctx.reply(`🎤 _Escuché:_ "${transcription}"`, { parse_mode: 'Markdown' });
        await handleIncomingText(ctx, userId, transcription);

    } catch (error: any) {
        console.error('[VOICE ERROR]', error);
        await ctx.reply(`⚠️ No pude procesar tu audio: ${error.message}`);
    }
});

/**
 * Shared logic for processing text (either raw or transcribed)
 */
async function handleIncomingText(ctx: Context, userId: number, text: string) {
    console.log(`[AGENT] Processing from ${userId}: "${text}"`);
    await ctx.replyWithChatAction('typing');

    try {
       const replyText = await processUserMessage(userId, text);
       await ctx.reply(replyText, { parse_mode: 'Markdown' });
    } catch (error: any) {
        console.error('[AGENT ERROR]', error);
        await ctx.reply(`⚠️ Error de procesamiento: ${error.message || 'Desconocido'}`);
    }
}

bot.catch((err) => {
  console.error('[TELEGRAM FATAL]', err.error);
});
