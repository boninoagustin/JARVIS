import { db } from './memory.js';
import admin from 'firebase-admin';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

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

    const prefix = parts[0].toUpperCase();
    const ticker = parts[1];
    const message = parts.slice(2).join(' | ');

    // Extraer dirección desde el texto completo de la alerta
    const upperText = alertText.toUpperCase();
    let currentDirection: 'BUY' | 'SELL' | null = null;
    if (upperText.includes('BUY') || upperText.includes('BULLISH')) {
        currentDirection = 'BUY';
    } else if (upperText.includes('SELL') || upperText.includes('BEARISH')) {
        currentDirection = 'SELL';
    }

    console.log(`[TRADING] Procesando Alerta SMC -> Prefijo: ${prefix}, Par: ${ticker}, Dir: ${currentDirection}`);

    const targetUserId = config.TELEGRAM_ALLOWED_USER_IDS[0];
    const docRef = db.collection('market_states').doc(ticker);
    
    // Checkear estado actual para caducidad y contexto
    const docSnap = await docRef.get();
    let state: any = docSnap.exists ? docSnap.data() : null;
    const now = Date.now();

    if (state && state.timestamp) {
        const diff = now - state.timestamp;
        if (diff > SIX_HOURS_MS) {
            console.log(`[TRADING] El contexto de ${ticker} ha expirado (> 6h). Reseteando y borrando.`);
            await docRef.delete();
            state = null;
        }
    }
    const FIFTY_MINUTES_MS = 50 * 60 * 1000;

    try {
        if (prefix === 'LOCAL_CRT') {
            // Fase 1 - Activación oficial de la secuencia operativa
            await docRef.set({
                phase1: true,
                direction: currentDirection,
                timestamp: now,
                phase2: false, // Reset phases posteriores si re-inicia Fase 1
                phase3: false,
                phase3_timestamp: 0
            }, { merge: true });

            const dirText = currentDirection ? ` (${currentDirection})` : '';
            await bot.api.sendMessage(targetUserId, `🎯 *Fase 1 Activada*: Señal *LOCAL_CRT* en *${ticker}*${dirText}. El bot se pone en guardia.`, { parse_mode: 'Markdown' });
        } 
        else if (prefix === 'GLOBAL_CRT' || prefix === 'RADAR_AVISO' || prefix === 'CONTEXT_LIQ' || prefix === 'MASTER_SWEEP') {
            // Información / Notificación sin activar secuencia oficial
            const dirText = currentDirection ? ` (${currentDirection})` : '';
            await bot.api.sendMessage(targetUserId, `👀 *Radar Info*: Alerta *${prefix}* en *${ticker}*${dirText}. Solo informativo.`, { parse_mode: 'Markdown' });
        }
        else if (prefix === 'MASTER_STRUCT' || prefix === 'BOS' || prefix === 'CHOCH') {
            // Fase 2 - Confirmación de giro
            if (state && state.phase1) {
                // Si la Fase 1 tenía un Bias (dirección), la Fase 2 debe ser obligatoriamente en esa dirección
                if (state.direction) {
                    if (!currentDirection) {
                        console.log(`[TRADING] Se ignoró ${prefix} en ${ticker} - Se requiere dirección explícita (BOS SELL o CHoCH SELL) para validar Fase 2.`);
                        return; // No validamos Fase 2 sin dirección si Fase 1 tiene Bias
                    }

                    if (currentDirection !== state.direction) {
                        console.log(`[TRADING] Invalidez en ${ticker}: Dirección Fase 2 (${currentDirection}) opuesta a Fase 1 (${state.direction}).`);
                        await docRef.delete();
                        await bot.api.sendMessage(targetUserId, `⚠️ *Secuencia Invalidada*: Estructura en contra en *${ticker}* (Esperaba ${state.direction}, llegó ${currentDirection}). Setup SMC abortado.`, { parse_mode: 'Markdown' });
                        return;
                    }
                } else if (currentDirection) {
                    // Si Fase 1 no tenía Bias, lo adoptamos de la Fase 2
                    await docRef.update({ direction: currentDirection });
                }

                await docRef.update({
                    phase2: true,
                    timestamp: now // Refrescamos el timestamp global
                });
                await bot.api.sendMessage(targetUserId, `🔄 *Fase 2 (Estructura)*: *${ticker}* validó dirección. Esperando zona.`, { parse_mode: 'Markdown' });
            } else {
                console.log(`[TRADING] Se ignoró ${prefix} en ${ticker} porque no hay Fase 1 previa.`);
            }
        } 
        else if (prefix === 'MASTER_ZONE') {
            // Fase 3 - Precio en zona (OB/FVG) con caducidad de 50 min
            if (state && state.phase1 && state.phase2) {
                await docRef.update({
                    phase3: true,
                    phase3_timestamp: now
                });
                await bot.api.sendMessage(targetUserId, `📍 *Fase 3 (Zona)*: El precio entró en zona de interés en *${ticker}*. Válido por 50 min.`, { parse_mode: 'Markdown' });
            } else {
                console.log(`[TRADING] Se ignoró MASTER_ZONE en ${ticker} por falta de Fase 1 o 2.`);
            }
        }
        else if (prefix === 'MASTER_SIGNAL' || prefix === 'ENGULFING') {
            // Gatillo Final
            
            // Validar caducidad de Fase 3
            let isPhase3Valid = false;
            if (state && state.phase3 && state.phase3_timestamp) {
                const zoneDiff = now - state.phase3_timestamp;
                if (zoneDiff <= FIFTY_MINUTES_MS) {
                    isPhase3Valid = true;
                } else {
                    console.log(`[TRADING] Fase 3 de ${ticker} caducada (${Math.round(zoneDiff/60000)} min).`);
                    await docRef.update({ phase3: false });
                }
            }

            const hasAllPhases = (state && state.phase1 && state.phase2 && isPhase3Valid);

            if (hasAllPhases) {
                // Verificar direccionalidad final
                if (currentDirection && state.direction && currentDirection !== state.direction) {
                    console.log(`[TRADING] Invalidez en ${ticker}: Gatillo (${currentDirection}) opuesto a secuencia (${state.direction}).`);
                    await docRef.delete();
                    await bot.api.sendMessage(targetUserId, `⚠️ *Secuencia Invalidada*: Gatillo en contra en *${ticker}*. Setup abortado.`, { parse_mode: 'Markdown' });
                    return;
                }

                await bot.api.sendMessage(targetUserId, `🚀 *DISPARO A+*: Gatillo final en *${ticker}*! Secuencia completa: 1, 2 y 3 ✅. Ejecutar orden.`, { parse_mode: 'Markdown' });
                // Aquí podrías resetear el estado tras el disparo o mantenerlo para TP
            } else {
                console.log(`[TRADING] Se ignoró ${prefix} en ${ticker} - Faltan confluencias (1, 2 o 3 válida).`);
                let missing = [];
                if (!state?.phase1) missing.push("Fase 1");
                if (!state?.phase2) missing.push("Fase 2");
                if (!isPhase3Valid) missing.push("Fase 3 (o caducada)");
                // Opcional: Avisar por qué no disparó
                // await bot.api.sendMessage(targetUserId, `❌ *Disparo denegado* en ${ticker}: Falta ${missing.join(', ')}.`);
            }
        } 
        else if (prefix === 'CONTEXT_EXIT') {
            await bot.api.sendMessage(targetUserId, `💰 *Take Profit*: *${ticker}* alcanzó objetivo. Sugiero cerrar parciales.`, { parse_mode: 'Markdown' });
        } 
        else if (prefix === 'MASTER_INVALID') {
            if (docSnap.exists) {
                await docRef.delete();
            }
            await bot.api.sendMessage(targetUserId, `⚠️ *Invalidez*: *${ticker}* rompió estructura. Setup SMC abortado.`, { parse_mode: 'Markdown' });
        }
        else {
            console.log(`[TRADING] Alerta ignorada: ${prefix}`);
        }
    } catch (e: any) {
        console.error(`[TRADING] Error crítico:`, e.message);
    }
}
