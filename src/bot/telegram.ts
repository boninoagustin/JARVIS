import { Bot, Context, NextFunction, HttpError, InputFile } from 'grammy';
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
 * Conexión directa a api.telegram.org vía long polling (sin proxy ni webhooks).
 */
export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

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

// Command /clear
bot.command('clear', async (ctx) => {
    const userId = ctx.from!.id;
    try {
        const { memory } = await import('../db/memory.js');
        await memory.clearHistory(userId);
        await ctx.reply("🧹 Memoria borrada. El contexto de la conversación ha sido reiniciado.");
    } catch (e: any) {
        await ctx.reply("Error al borrar memoria: " + e.message);
    }
});

// Global text message handling
bot.on('message:text', async (ctx) => {
    const userId = ctx.from!.id;
    const userText = ctx.message!.text!;
    await handleIncomingText(ctx, userId, userText);
});

// 🤖 cTrader: Handle inline button callbacks for trade confirmation
bot.on('callback_query:data', async (ctx) => {
    const callbackData = ctx.callbackQuery.data;
    const userId = ctx.from!.id;
    const chatId = ctx.callbackQuery.message?.chat.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    
    // Answer the callback immediately to remove loading spinner
    await ctx.answerCallbackQuery();
    
    // Route cTrader callbacks
    if (callbackData.startsWith('ctrader_') && chatId && messageId) {
        try {
            const { handleTradeCallback } = await import('../services/ctrader_confirmation.js');
            await handleTradeCallback(callbackData, chatId, messageId, userId);
        } catch (err: any) {
            console.error('[CALLBACK] Error handling cTrader callback:', err.message);
        }
    }
});

async function handleIncomingMedia(ctx: Context) {
    const userId = ctx.from!.id;
    const caption = ctx.message?.caption || '';
    
    await ctx.replyWithChatAction('typing');
    
    try {
        let fileId = '';
        
        if (ctx.message?.photo) {
            // Photos come in arrays of different sizes, get the largest one
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            fileId = photo.file_id;
        }
        
        if (!fileId) return;
        
        const file = await ctx.api.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        
        // @ts-ignore
        const response = await nodeFetch(fileUrl);
        const buffer = await response.buffer();
        
        const systemMsg = `[Sistema: El usuario te ha enviado una imagen]\n\nMensaje o notas del usuario adjuntas a la imagen: ${caption}`;
        
        let inlineData = {
            data: buffer.toString('base64'),
            mimeType: 'image/jpeg'
        };
        
        await handleIncomingText(ctx, userId, systemMsg, inlineData);
        
    } catch (error: any) {
        console.error('[MEDIA ERROR]', error);
        await ctx.reply(`⚠️ No pude descargar tu imagen: ${error.message}`);
    }
}

bot.on('message:photo', handleIncomingMedia);



/**
 * Shared logic for processing text
 */
async function handleIncomingText(ctx: Context, userId: number, text: string, inlineData?: { data: string; mimeType: string }) {
    console.log(`[AGENT] Processing from ${userId}: "${text}"`);
    await ctx.replyWithChatAction('typing');

    try {
       const replyText = await processUserMessage(userId, text, inlineData);
       await ctx.reply(replyText, { parse_mode: 'Markdown' });
    } catch (error: any) {
        console.error('[AGENT ERROR]', error);
        await ctx.reply(`⚠️ Error de procesamiento: ${error.message || 'Desconocido'}`);
    }
}

bot.catch((err) => {
  console.error('[TELEGRAM FATAL]', err.error);
});
