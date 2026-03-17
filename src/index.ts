import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

// Polyfill global fetch BEFORE anything else
import nodeFetch from 'node-fetch';
// @ts-ignore
global.fetch = nodeFetch;

import { bot } from './bot/telegram.js';
import { startScreenshotWorker } from './utils/screenshot_worker.js';
import { startCleanupTimer } from './db/cleanup.js';

console.log('[SYSTEM] --- FINAL CLEAN START ---');

async function main() {
    try {
        console.log('[DEBUG] Memory check (Firebase)...');
        // Firebase initialization is done in memory.ts side-effect

        console.log('[TELEGRAM] Cleaning webhooks...');
        await bot.api.deleteWebhook({ drop_pending_updates: true });

        console.log('[TELEGRAM] Fetching bot info...');
        const botInfo = await bot.api.getMe();
        console.log(`[SYSTEM] JARVIS is online as @${botInfo.username}`);

        // Iniciar worker de screenshots y limpieza automática
        startScreenshotWorker();
        startCleanupTimer();

        console.log('[TELEGRAM] Starting long polling...');
        await bot.start({
            drop_pending_updates: true,
            allowed_updates: ['message'],
            onStart: () => console.log('[SYSTEM] --- POLLING ESTABLISHED. Ready for messages ---')
        });

    } catch (err: any) {
        console.error('[CRITICAL]', err.message);
        if (err.stack) console.error(err.stack);
    }
}

main();
