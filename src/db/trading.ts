import { db } from './memory.js';
import admin from 'firebase-admin';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export async function processTradingAlert(alertText: string) {
    if (!db) {
        console.error('[TRADING] Base de datos no inicializada.');
        return;
    }

    // Esperamos que text.body sea String con el formato: PREFIJO | TICKER | MENSAJE
    const parts = alertText.split('|').map(p => p.trim());
    if (parts.length < 2) {
        console.error('[TRADING] Formato de alerta inválido (Faltan separadores |)', alertText);
        return;
    }

    const prefix = parts[0];
    const ticker = parts[1];
    const message = parts.slice(2).join(' | ');

    console.log(`[TRADING] Procesando Alerta SMC -> Prefijo: ${prefix}, Par: ${ticker}`);

    const targetUserId = config.TELEGRAM_ALLOWED_USER_IDS[0];
    const docRef = db.collection('market_states').doc(ticker);
    
    // Checkear estado actual para caducidad y contexto
    const docSnap = await docRef.get();
    let state: any = docSnap.exists ? docSnap.data() : null;
    const now = Date.now();

    if (state && state.timestamp) {
        const diff = now - state.timestamp;
        if (diff > TWO_HOURS_MS) {
            console.log(`[TRADING] El contexto de ${ticker} ha expirado (> 2h). Reseteando.`);
            state = null;
        }
    }

    try {
        if (prefix === 'CONTEXT_LIQ' || prefix === 'GLOBAL_CRT' || prefix === 'MASTER_SWEEP') {
            // Fase 1 - Alerta Temprana
            await docRef.set({
                phase1: true,
                phase1_trigger: prefix,
                timestamp: now
            }, { merge: false }); // merge = false to reset old phase 2 states

            await bot.api.sendMessage(targetUserId, `👀 *Radar SMC*: Toma de liquidez en *${ticker}*. Posible manipulación institucional.`, { parse_mode: 'Markdown' });
        } 
        else if (prefix === 'MASTER_STRUCT' || prefix === 'BOS') {
            // Fase 2 - Confirmación de giro (CHoCH o BOS)
            if (state && state.phase1) {
                // Actualizamos DB para marcar fase 2 y extendemos el timestamp
                await docRef.update({
                    phase2: true,
                    timestamp: now 
                });
                await bot.api.sendMessage(targetUserId, `🔄 *Confirmación de Estructura*: *${ticker}* hizo CHoCH o BOS tras barrer liquidez. Esperando retroceso.`, { parse_mode: 'Markdown' });
            } else {
                console.log(`[TRADING] Se ignoró ${prefix} en ${ticker} porque no hay Fase 1 previa válida en las últimas 2 horas.`);
            }
        } 
        else if (prefix === 'MASTER_SIGNAL' || prefix === 'ENGULFING' || prefix === 'PIN_BAR') {
            // Fase 3 - Gatillo / Entrada 
            // Evaluamos si el precio está en zona o si viene de la progresión SMC correcta
            const inZone = message.includes('MASTER_ZONE') || alertText.includes('MASTER_ZONE');
            const hasConfluences = (state && state.phase1 && state.phase2);

            if (hasConfluences || inZone) {
                await bot.api.sendMessage(targetUserId, `🚀 *DISPARO A+*: Gatillo detectado en *${ticker}* con todas las confluencias. Considerar entrada.`, { parse_mode: 'Markdown' });
            } else {
                console.log(`[TRADING] Se ignoró ${prefix} en ${ticker} porque no cumple condiciones suficientes.`);
            }
        } 
        else if (prefix === 'CONTEXT_EXIT') {
            // Salidas - Toma de Ganancias
            await bot.api.sendMessage(targetUserId, `💰 *Take Profit*: *${ticker}* alcanzó objetivo macro de liquidez. Sugiero cerrar parciales.`, { parse_mode: 'Markdown' });
        } 
        else if (prefix === 'MASTER_INVALID') {
            // Invalidez - Destruir Setup SMC
            if (docSnap.exists) {
                await docRef.delete();
            }
            await bot.api.sendMessage(targetUserId, `⚠️ *Invalidez*: *${ticker}* rompió estructura en contra. Abortar compras/ventas.`, { parse_mode: 'Markdown' });
        }
        else {
            console.log(`[TRADING] Alerta ignorada. Prefijo no reconocido: ${prefix}`);
        }
    } catch (e: any) {
        console.error(`[TRADING] Error crítico al notificar Telegram:`, e.message);
    }
}
