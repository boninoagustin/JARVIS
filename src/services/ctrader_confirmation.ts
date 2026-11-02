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
import { invalidateRiskCache } from '../engine/PortfolioModel.js';
import { commitTradeCloseAccounting } from '../engine/TradeAccountingPersistence.js';
import { buildExecutionNotice } from '../engine/ExecutionNotice.js';
import { globalState, hasUnresolvedExecutionIncidents, recheckLiveExecutionRisk, retainExecutionIncident, updateTradePositionId, finalizeClosedPositionFromDeals } from '../db/trading.js';

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
    swarmConsensus?: string; // 🛡️ sep-2026: enjambre multi-IA eliminado (era solo anotación, nunca gate)
    messageId?: number;      // Telegram message ID (for editing after response)
    chatId?: number;         // Telegram chat ID
    timestamp: number;       // When the confirmation was sent
    journalId?: string;      // Journal entry ID
    isChochEntry?: boolean;
    sarPendingClose?: any;   // To close old trade ONLY after user approves new SAR trade
    riskMult?: number;       // 🆕 TimesFM F1: multiplicador de riesgo (default 1)
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
    swarmConsensus?: string; // 🛡️ sep-2026: enjambre multi-IA eliminado
    alertMessage: string;       // The full alert message already built
    journalId?: string;
    isChochEntry?: boolean;
    sarPendingClose?: any;
    riskMult?: number;       // 🆕 TimesFM F1
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
        sarPendingClose: data.sarPendingClose,
        riskMult: data.riskMult ?? 1,
    };

    pendingConfirmations.set(data.tradeId, pending);

    // Build confirmation message with execution details
    const riskMult = data.riskMult ?? 1;
    const riskPercent = config.CTRADER_RISK_PERCENT * riskMult;
    const slDistPercent = (Math.abs(data.entryPrice - data.slPrice) / data.entryPrice * 100).toFixed(3);
    const timesfmNote = riskMult < 1 ? ` (×${riskMult} TimesFM)` : '';
    
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
        beforeExecution: () => recheckLiveExecutionRisk(pending.ticker),
        riskPercent: config.CTRADER_RISK_PERCENT * (pending.riskMult ?? 1), // 🆕 TimesFM F1
    };

    if (hasUnresolvedExecutionIncidents()) {
        await bot.api.sendMessage(chatId, '⚠️ Nuevas entradas retenidas: ejecución/contabilidad pendiente de reconciliación.').catch(() => {});
        return;
    }
    // Approval may arrive after another position closes or policy changes. The
    // user approves this candidate, not a bypass of current account/asset limits.
    let riskBlock: string | null;
    try { riskBlock = await recheckLiveExecutionRisk(pending.ticker); }
    catch { riskBlock = 'risk-data-unavailable: manual approval recheck failed'; }
    if (riskBlock) {
        const candidate = globalState.activeTrades.get(tradeId);
        if (!candidate?.ctraderPositionId && !candidate?.executionUncertain && !candidate?.executionIncidentPending) {
            globalState.activeTrades.delete(tradeId);
            if (db) {
                await db.collection('active_trades').doc(tradeId).delete().catch(() => {});
                if (pending.journalId) await db.collection('trade_journal').doc(pending.journalId).update({
                    result: 'SKIP', ctraderStatus: 'ABORTED', skipReason: riskBlock,
                }).catch(() => {});
            }
        }
        await bot.api.sendMessage(chatId, `⚠️ Entrada no enviada: ${riskBlock}`).catch(() => {});
        return;
    }
    let result: CTraderOrderResult | null;
    try { result = await executeMarketOrder(orderParams); }
    catch (error: any) { result = { success: false, executionUncertain: true, error: error?.message }; }

    if (result?.success && result.positionId) {
        // Persist the exact broker denominator before announcing success. Never turn a
        // persistence failure after a fill into an EXECUTION_FAILED/aborted position.
        const riskFields = result.riskSnapshot
            ? { riskSnapshot: result.riskSnapshot, accountCurrency: result.riskSnapshot.currency, riskAccountingStatus: 'VERIFIED' }
            : { riskAccountingStatus: 'UNVERIFIED' };
        try {
            await updateTradePositionId(tradeId, result.positionId, result.riskSnapshot);
            if (!db) throw new Error('Contabilidad no disponible tras el fill');
            const normPayload: Record<string, unknown> = {
                ctraderPositionId: result.positionId,
                ctraderLots: result.lots,
                ctraderExecutedPrice: result.executedPrice,
                entryPrice: Number(result.executedPrice) || pending.entryPrice,
                slPrice: result.riskSnapshot?.initialSlPrice ?? pending.slPrice,
                initialSlPrice: result.riskSnapshot?.initialSlPrice ?? pending.slPrice,
                tp1Price: pending.tp1Price,
                ...(Number.isFinite(result.riskBudgetAccount) ? { riskBudgetAccount: result.riskBudgetAccount } : {}),
                ...riskFields,
            };
            if (pending.tp2Price !== undefined && pending.tp2Price !== null) normPayload.tp2Price = pending.tp2Price;
            if (pending.journalId) await db.collection('trade_journal').doc(pending.journalId).update({
                ...normPayload, ctraderStatus: 'EXECUTED', ctraderDemo: config.CTRADER_DEMO,
            });
            await db.collection('active_trades').doc(tradeId).update(normPayload);
        } catch (error: any) {
            await retainExecutionIncident(tradeId, pending.journalId, result);
            console.error(`[CTRADER_CONFIRM] Posición ${result.positionId} ejecutada; contabilidad pendiente:`, error?.message);
            await bot.api.sendMessage(chatId, `⚠️ Posición ${result.positionId} ejecutada en cTrader, pero no se pudo confirmar la persistencia de su riesgo. Requiere reconciliación; no se reintentó la orden.`).catch(() => {});
            return;
        }
        // Ejecución exitosa de la nueva posición. Si hay un SAR pendiente, cerrar la vieja ahora.
        if (pending.sarPendingClose) {
            const old = pending.sarPendingClose;
            await retainExecutionIncident(old.tradeId, old.journalId, { success: false, positionId: old.ctraderPositionId, executionUncertain: !old.ctraderPositionId, error: 'SAR close accounting pending' });
            try {
                if (old.ctraderPositionId) {
                    const ctrader = await import('./ctrader.js');
                    const closed = await ctrader.closePosition(old.ctraderPositionId);
                    const fin = closed ? await finalizeClosedPositionFromDeals(old.ctraderPositionId, old) : null;
                    if (fin && fin.closedAt && fin.closedAtSource === 'broker_execution' && db) {
                        await commitTradeCloseAccounting(db, old.journalId || old.tradeId, fin, { reversalClosed: true });
                        await db.collection('active_trades').doc(old.tradeId).delete();
                        globalState.activeTrades.delete(old.tradeId);
                    }
                }
            } catch (e) {
                console.error('[SAR] Cierre/contabilidad pendiente en confirmación manual:', e);
            }
        }

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

        console.log(`[CTRADER_CONFIRM] 🎉 Trade ejecutado: ${pending.ticker} ${pending.direction} | ${result.lots} lotes @ ${result.executedPrice} | posID: ${result.positionId}`);
    } else if (await retainExecutionIncident(tradeId, pending.journalId, result)) {
        await bot.api.sendMessage(chatId, `⚠️ Ejecución pendiente de reconciliación${result?.positionId ? ` (posID ${result.positionId})` : ''}. No se reintentó la orden; nuevas entradas retenidas.`).catch(() => {});
    } else {
        // Verified no-fill rejection only — notify user
        const notice = buildExecutionNotice(result.error, 'MANUAL');
        const errorText = `${notice.headingHtml}\n\n` +
            `${notice.reasonHtml}\n\n` +
            `El trade fue registrado en el Journal pero NO se ejecutó en cTrader.`;

        try {
            await bot.api.editMessageReplyMarkup(chatId, messageId, {
                reply_markup: { inline_keyboard: [[{ text: notice.buttonText, callback_data: 'noop' }]] }
            });
            
            await bot.api.sendMessage(chatId, errorText, { parse_mode: 'HTML' });
        } catch {}

        if (db && pending.journalId) {
            db.collection('trade_journal').doc(pending.journalId).update({
                ctraderStatus: 'EXECUTION_FAILED',
                ctraderError: result.error,
                // 🛡️ FIX: marcar SKIP para que no se contabilice como LOSS en el diario/killswitch.
                result: 'SKIP',
                skipReason: `Ejecución fallida en cTrader: ${result.error}`,
            }).catch(() => {});
        }

        // 🛡️ FIX: limpiar el trade de active_trades (RAM + Firestore) para que el gestor
        // no lo marque LOSS por un trade que nunca se abrió en cTrader.
        globalState.activeTrades.delete(tradeId);
        if (db) db.collection('active_trades').doc(tradeId).delete().catch(() => {});

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
