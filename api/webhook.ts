import { webhookCallback } from 'grammy';
import { bot } from '../src/bot/telegram.js';

/**
 * VERCEL WEBHOOK HANDLER
 * This endpoint will be called by Telegram whenever a message is sent.
 * It uses grammatical's webhookCallback to bridge Between HTTP and Grammy.
 */
export default webhookCallback(bot, "next-js"); // works for Vercel/Next routes
