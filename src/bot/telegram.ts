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
 * Exported for modular use in both local index.ts (Long Polling)
 * and Vercel serverless functions (Webhooks).
 */
export const bot = new Bot(config.TELEGRAM_BOT_TOKEN, {
    client: {
        buildUrl: (root, token, method) => {
            // Local PC: override to proxy via Vercel
            const proxyUrl = 'https://jarvis-seven-kappa.vercel.app/api/proxy';
            return `${proxyUrl}?method=${method}`;
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

async function handleIncomingMedia(ctx: Context) {
    const userId = ctx.from!.id;
    const caption = ctx.message?.caption || '';
    
    await ctx.replyWithChatAction('typing');
    
    try {
        let fileId = '';
        let fileName = 'file_unknown';
        
        if (ctx.message?.photo) {
            // Photos come in arrays of different sizes, get the largest one
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            fileId = photo.file_id;
            fileName = `photo_${Date.now()}.jpg`;
        } else if (ctx.message?.video) {
            fileId = ctx.message.video.file_id;
            fileName = ctx.message.video.file_name || `video_${Date.now()}.mp4`;
        } else if (ctx.message?.document) {
            fileId = ctx.message.document.file_id;
            fileName = ctx.message.document.file_name || `document_${Date.now()}`;
        }
        
        if (!fileId) return;
        
        const file = await ctx.api.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        
        console.log(`[BOT] Downloading media to: ${fileName}`);
        
        // @ts-ignore
        const response = await nodeFetch(fileUrl);
        const buffer = await response.buffer();
        
        const fs = await import('fs');
        const path = await import('path');
        
        const downloadsDir = path.join(process.cwd(), 'downloads');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
        }
        
        const filePath = path.join(downloadsDir, fileName);
        fs.writeFileSync(filePath, buffer);
        console.log(`[BOT] Saved media to: ${filePath}`);
        
        const systemMsg = `[Sistema: El usuario te ha enviado un archivo. Se ha guardado localmente en: ${filePath}]\n\nMensaje o notas del usuario adjuntas al archivo: ${caption}`;
        
        // If it's a photo, extract inlineData to pass along
        let inlineData = undefined;
        if (ctx.message?.photo) {
            inlineData = {
                data: buffer.toString('base64'),
                mimeType: 'image/jpeg'
            };
        }
        
        await handleIncomingText(ctx, userId, systemMsg, false, inlineData);
        
    } catch (error: any) {
        console.error('[MEDIA ERROR]', error);
        await ctx.reply(`⚠️ No pude descargar tu archivo: ${error.message}`);
    }
}

bot.on('message:photo', handleIncomingMedia);
bot.on('message:video', handleIncomingMedia);
bot.on('message:document', handleIncomingMedia);

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

        // 4. Process as normal text but reply as audio
        await ctx.reply(`🎤 _Escuché:_ "${transcription}"`, { parse_mode: 'Markdown' });
        await handleIncomingText(ctx, userId, transcription, true);

    } catch (error: any) {
        console.error('[VOICE ERROR]', error);
        await ctx.reply(`⚠️ No pude procesar tu audio: ${error.message}`);
    }
});

/**
 * Shared logic for processing text (either raw or transcribed)
 */
async function handleIncomingText(ctx: Context, userId: number, text: string, replyAsAudio: boolean = false, inlineData?: { data: string; mimeType: string }) {
    console.log(`[AGENT] Processing from ${userId}: "${text}"`);
    await ctx.replyWithChatAction('typing');

    try {
       const replyText = await processUserMessage(userId, text, inlineData);
       
       if (replyAsAudio) {
           await ctx.replyWithChatAction('record_voice');
           const { generateVoice } = await import('../llm/elevenlabs.js');
           const audioBuffer = await generateVoice(replyText);
           
           if (audioBuffer) {
               // Provide to Telegram as voice note
               await ctx.replyWithVoice(new InputFile(audioBuffer, 'jarvis.mp3'));
               return; // Exit here since we responded
           } else {
               await ctx.reply("⚠️ Error deElevenLabs, respondiendo con texto.");
           }
       }

       // Text fallback or raw text processing
       await ctx.reply(replyText, { parse_mode: 'Markdown' });
    } catch (error: any) {
        console.error('[AGENT ERROR]', error);
        await ctx.reply(`⚠️ Error de procesamiento: ${error.message || 'Desconocido'}`);
    }
}

bot.catch((err) => {
  console.error('[TELEGRAM FATAL]', err.error);
});
