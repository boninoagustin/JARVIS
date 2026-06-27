/**
 * cTrader Trade Confirmation System — Telegram Inline Buttons
 * 
 * When JARVIS detects a valid trade setup, instead of executing immediately,
 * it sends the alert with inline buttons [✅ EJECUTAR] [❌ IGNORAR].
 * The user responds via Telegram and JARVIS executes (or skips) accordingly.
 * 
 * Flow:
 * 1. Trade alert detected → sendTradeConfirmation() → Telegram message with buttons
 * 2. User presses button → handleTradeCallback() → execute or ignore
 * 3. Timeout after 5 minutes → auto-ignore (market may have moved)
 */

import { bot } from '../bot/telegram.js';
import { config } from '../config.js';
import { executeMarketOrder, isCTraderReady, type CTraderOrderParams, type CTraderOrderResult } from './ctrader.js';
import { db } from '../db/memory.js';
import { updateTradePositionId } from '../db/trading.js';

// ─── Pending Confirmations Store ───

interface PendingConfirmation {
    tradeId: string;
    ticker: string;
    direction: 'BUY' | 'SELL';
    entryPrice: number;
    slPrice: number;
    tp1Price: number;
    tp2Price?: number;
    points: number;
    grade: string;
    events: string[];
    confluenceReport: string;
    kronosVerdict: string;
    swarmConsensus: string;
    messageId?: number;      // Telegram message ID (for editing after response)
    chatId?: number;         // Telegram chat ID
    timestamp: number;       // When the confirmation was sent
    journalId?: string;      // Journal entry ID
    isChochEntry?: boolean;
}

// Map: tradeId → pending confirmation data
const pendingConfirmations = new Map<string, PendingConfirmation>();

// Timeout: auto-reject after 5 minutes
const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Send Confirmation ───

/**
 * Send a trade confirmation message with inline buttons to Telegram.
 * Called from trading.ts after the sniper alert is generated.
 */
export async function sendTradeConfirmation(data: {
    tradeId: string;
    ticker: string;
    direction: 'BUY' | 'SELL';
    dirText: string;
    entryPrice: number;
    slPrice: number;
    tp1Price: number;
    tp2Price?: number;
    points: number;
    grade: string;
    events: string[];
    confluenceReport: string;
    kronosVerdict: string;
    swarmConsensus: string;
    alertMessage: string;       // The full alert message already built
    journalId?: string;
    isChochEntry?: boolean;
}): Promise<void> {
    // Check if cTrader is configured (if not, skip confirmation flow)
    if (!config.CTRADER_CLIENT_ID || !config.CTRADER_ACCESS_TOKEN) {
        console.log('[CTRADER_CONFIRM] cTrader no configurado. Solo se envía la alerta sin botones de ejecución.');
        return;
    }

    // Store pending confirmation
    const pending: PendingConfirmation = {
        tradeId: data.tradeId,
        ticker: data.ticker,
        direction: data.direction,
        entryPrice: data.entryPrice,
        slPrice: data.slPrice,
        tp1Price: data.tp1Price,
        tp2Price: data.tp2Price,
        points: data.points,
        grade: data.grade,
        events: data.events,
        confluenceReport: data.confluenceReport,
        kronosVerdict: data.kronosVerdict,
        swarmConsensus: data.swarmConsensus,
        timestamp: Date.now(),
        journalId: data.journalId,
        isChochEntry: data.isChochEntry,
    };

    pendingConfirmations.set(data.tradeId, pending);

    // Build confirmation message with execution details
    const riskPercent = config.CTRADER_RISK_PERCENT;
    const slDistPercent = (Math.abs(data.entryPrice - data.slPrice) / data.entryPrice * 100).toFixed(3);
    
    const confirmMsg = `\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🤖 <b>EJECUCIÓN cTrader</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 Riesgo: ${riskPercent}% del equity\n` +
        `📏 Distancia SL: ${slDistPercent}%\n` +
        `🏦 Modo: ${config.CTRADER_DEMO ? '🧪 DEMO' : '🔴 LIVE'}\n` +
        `⏳ Tiempo límite: 5 minutos\n\n` +
        `¿Ejecutar este trade?`;

    const fullMessage = data.alertMessage + confirmMsg;

    // Send to all allowed users with inline buttons
    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try {
            const sent = await bot.api.sendMessage(userId, fullMessage, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ EJECUTAR', callback_data: `ctrader_execute_${data.tradeId}` },
                            { text: '❌ IGNORAR', callback_data: `ctrader_ignore_${data.tradeId}` },
                        ]
                    ]
                }
            });
            
            // Store message info for later editing
            pending.messageId = sent.message_id;
            pending.chatId = userId;
            
            console.log(`[CTRADER_CONFIRM] ✅ Confirmación enviada: ${data.ticker} ${data.direction} #${data.tradeId} → userId=${userId}`);
        } catch (err: any) {
            console.error(`[CTRADER_CONFIRM] ❌ Error enviando confirmación a ${userId}:`, err.message);
            // Fallback: send without buttons
            try {
                await bot.api.sendMessage(userId, fullMessage.replace(/<[^>]*>?/gm, ''));
            } catch {}
        }
    }

    // Set auto-timeout
    setTimeout(() => {
        const stillPending = pendingConfirmations.get(data.tradeId);
        if (stillPending) {
            pendingConfirmations.delete(data.tradeId);
            console.log(`[CTRADER_CONFIRM] ⏰ Timeout: ${data.ticker} ${data.direction} #${data.tradeId} expirado.`);
            
            // Edit the message to show it expired
            if (stillPending.messageId && stillPending.chatId) {
                bot.api.editMessageReplyMarkup(stillPending.chatId, stillPending.messageId, {
                    reply_markup: { inline_keyboard: [[{ text: '⏰ EXPIRADO (5 min)', callback_data: 'noop' }]] }
                }).catch(() => {});
            }
        }
    }, CONFIRMATION_TIMEOUT_MS);
}

// ─── Handle Callback ───

/**
 * Handle callback_query from Telegram inline buttons.
 * This is registered in telegram.ts.
 */
export async function handleTradeCallback(callbackData: string, chatId: number, messageId: number, userId: number): Promise<void> {
    // Parse callback data
    const executeMatch = callbackData.match(/^ctrader_execute_(.+)$/);
    const ignoreMatch = callbackData.match(/^ctrader_ignore_(.+)$/);
    
    if (!executeMatch && !ignoreMatch) return;
    
    const tradeId = (executeMatch || ignoreMatch)![1];
    const isExecute = !!executeMatch;
    
    // Get pending confirmation
    const pending = pendingConfirmations.get(tradeId);
    if (!pending) {
        // Already processed or expired
        try {
            await bot.api.editMessageReplyMarkup(chatId, messageId, {
                reply_markup: { inline_keyboard: [[{ text: '⚠️ Ya procesado o expirado', callback_data: 'noop' }]] }
            });
        } catch {}
        return;
    }

    // Remove from pending
    pendingConfirmations.delete(tradeId);

    if (!isExecute) {
        // User chose to IGNORE
        console.log(`[CTRADER_CONFIRM] ❌ Trade ${pending.ticker} ${pending.direction} #${tradeId} IGNORADO por el usuario.`);
        
        try {
            await bot.api.editMessageReplyMarkup(chatId, messageId, {
                reply_markup: { inline_keyboard: [[{ text: '❌ IGNORADO por usuario', callback_data: 'noop' }]] }
            });
        } catch {}

        // Log in Firestore
        if (db && pending.journalId) {
            db.collection('trade_journal').doc(pending.journalId).update({
                ctraderStatus: 'IGNORED_BY_USER',
            }).catch(() => {});
        }
        return;
    }

    // User chose to EXECUTE
    console.log(`[CTRADER_CONFIRM] ✅ Trade ${pending.ticker} ${pending.direction} #${tradeId} APROBADO por el usuario. Ejecutando...`);

    // Update button to show "processing"
    try {
        await bot.api.editMessageReplyMarkup(chatId, messageId, {
            reply_markup: { inline_keyboard: [[{ text: '⏳ Ejecutando...', callback_data: 'noop' }]] }
        });
    } catch {}

    // Execute the trade
    const orderParams: CTraderOrderParams = {
        ticker: pending.ticker,
        direction: pending.direction,
        entryPrice: pending.entryPrice,
        slPrice: pending.slPrice,
        tp1Price: pending.tp1Price,
        tp2Price: pending.tp2Price,
        tradeId: pending.tradeId,
    };

    const result: CTraderOrderResult = await executeMarketOrder(orderParams);

    if (result.success) {
        // Success — update Telegram message
        const successText = `\n\n✅ <b>EJECUTADO EN CTRADER</b>\n` +
            `📊 Lotes: ${result.lots}\n` +
            `💰 Precio: ${result.executedPrice}\n` +
            `🆔 Position ID: ${result.positionId}\n` +
            `🏦 ${config.CTRADER_DEMO ? '🧪 DEMO' : '🔴 LIVE'}`;

        try {
            await bot.api.editMessageReplyMarkup(chatId, messageId, {
                reply_markup: { inline_keyboard: [[{ text: `✅ EJECUTADO (${result.lots} lotes)`, callback_data: 'noop' }]] }
            });
            
            // Send confirmation message
            await bot.api.sendMessage(chatId, successText, { parse_mode: 'HTML' });
        } catch {}

        // Update Firestore journal & active_trades with cTrader position ID
        if (db) {
            if (pending.journalId) {
                db.collection('trade_journal').doc(pending.journalId).update({
                    ctraderPositionId: result.positionId,
                    ctraderLots: result.lots,
                    ctraderExecutedPrice: result.executedPrice,
                    ctraderStatus: 'EXECUTED',
                    ctraderDemo: config.CTRADER_DEMO,
                }).catch(() => {});
            }

            // Also update active_trades
            db.collection('active_trades').doc(tradeId).update({
                ctraderPositionId: result.positionId,
                ctraderLots: result.lots,
                ctraderExecutedPrice: result.executedPrice,
            }).catch(() => {});
        }

        if (result.positionId) {
            updateTradePositionId(tradeId, result.positionId);
        }

        console.log(`[CTRADER_CONFIRM] 🎉 Trade ejecutado: ${pending.ticker} ${pending.direction} | ${result.lots} lotes @ ${result.executedPrice} | posID: ${result.positionId}`);
    } else {
        // Error — notify user
        const errorText = `❌ <b>ERROR DE EJECUCIÓN</b>\n\n` +
            `${result.error}\n\n` +
            `El trade fue registrado en el Journal pero NO se ejecutó en cTrader.`;

        try {
            await bot.api.editMessageReplyMarkup(chatId, messageId, {
                reply_markup: { inline_keyboard: [[{ text: '❌ ERROR DE EJECUCIÓN', callback_data: 'noop' }]] }
            });
            
            await bot.api.sendMessage(chatId, errorText, { parse_mode: 'HTML' });
        } catch {}

        if (db && pending.journalId) {
            db.collection('trade_journal').doc(pending.journalId).update({
                ctraderStatus: 'EXECUTION_FAILED',
                ctraderError: result.error,
            }).catch(() => {});
        }

        console.error(`[CTRADER_CONFIRM] ❌ Error ejecutando trade: ${result.error}`);
    }
}

// ─── Utility ───

/**
 * Get count of pending confirmations (for diagnostics).
 */
export function getPendingConfirmationCount(): number {
    return pendingConfirmations.size;
}

/**
 * Check if a trade has a pending confirmation.
 */
export function hasPendingConfirmation(tradeId: string): boolean {
    return pendingConfirmations.has(tradeId);
}
