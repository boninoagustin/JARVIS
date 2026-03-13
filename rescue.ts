import { Bot } from 'grammy';
import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
import { memory } from './src/db/memory.js';
import { processUserMessage } from './src/agent/loop.js';
import { config } from './src/config.js';

dotenv.config();

/**
 * JARVIS RESCUE MODE
 * 1. Manually check connection
 * 2. Force delete any existing webhooks
 * 3. Start minimal bot logic
 */
async function rescue() {
    console.log('[DEBUG] --- JARVIS RESCUE START ---');
    console.log('[DEBUG] Token:', config.TELEGRAM_BOT_TOKEN.substring(0, 10) + '...');
    
    try {
        // Step 1: Force identity check via raw fetch
        console.log('[DEBUG] Checking Telegram connectivity via raw fetch...');
        const resMe = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getMe`, { timeout: 10000 });
        const meData = await resMe.json();
        
        if (!meData.ok) {
            throw new Error(`Telegram API rejected token: ${JSON.stringify(meData)}`);
        }
        console.log(`[DEBUG] Connection SUCCESS! Logged in as: @${meData.result.username}`);

        // Step 2: Clean up webhooks (just in case)
        console.log('[DEBUG] Cleaning up any old webhooks...');
        await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`);

        // Step 3: Initialize bot with standard settings
        const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

        bot.use(async (ctx, next) => {
            const userId = ctx.from?.id;
            console.log(`[RESCUE] Incoming msg from ${userId}: ${ctx.message?.text || '(no text)'}`);
            if (userId && config.TELEGRAM_ALLOWED_USER_IDS.includes(userId)) {
                return await next();
            }
            console.warn(`[SECURITY] ID ${userId} is NOT in whitelist ${config.TELEGRAM_ALLOWED_USER_IDS}`);
        });

        bot.on('message:text', async (ctx) => {
            const userId = ctx.from!.id;
            const text = ctx.message!.text!;
            await ctx.replyWithChatAction('typing');
            try {
                const reply = await processUserMessage(userId, text);
                await ctx.reply(reply, { parse_mode: 'Markdown' });
            } catch (err: any) {
                console.error('[AGENT ERROR]', err);
                await ctx.reply(`⚠️ Processing error: ${err.message}`);
            }
        });

        console.log('[DEBUG] Starting long polling handle...');
        bot.start({
            onStart: (info) => console.log(`[SYSTEM] JARVIS is ONLINE (@${info.username})`)
        });

    } catch (err: any) {
        console.error('[FATAL RESCUE ERROR]', err.message);
        console.log('\n--- DIAGNÓSTICO ---');
        console.log('1. ¿Tu terminal tiene internet? (Verifica con ping google.com)');
        console.log('2. ¿Tu token es correcto? (El bot @agus_fx_bot)');
        console.log('3. ¿Estás bajo una red restringida? (Empresa, Universidad, etc.)');
    }
}

rescue();
