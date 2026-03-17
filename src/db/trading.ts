import { db } from './memory.js';
import admin from 'firebase-admin';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';
import { InputFile } from 'grammy';
import { takeTradingViewScreenshot } from '../utils/screenshot.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export async function processTradingAlert(alertText: string) {
    if (!db) {
        console.error('[TRADING] Base de datos no inicializada.');
        return;
    }

    // Esperamos que text.body sea String con el formato: PREFIJO | TICKER | MENSAJE
    // O separado por comas, ej: "MASTER_STRUCT", TICKER, "Tipo: BOS | ..."
    const parts = alertText.split(/[,|]/).map(p => p.replace(/"/g, '').trim());
    if (parts.length < 2) {
        console.error('[TRADING] Formato de alerta inválido (Faltan separadores | o ,)', alertText);
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
    try {
        if (prefix === 'LOCAL_CRT' || prefix === 'LOCAL_CRT_SCALP') {
            // Fase 1 - Activación oficial de la secuencia operativa
            await docRef.set({
                phase1: true,
                direction: currentDirection,
                timestamp: now,
                phase2: false // Reset phases posteriores si re-inicia Fase 1
            }, { merge: true });

            const dirText = currentDirection ? ` ${currentDirection}` : '';
            console.log(`[TRADING] Fase 1 Registrada internamente para ${ticker}${dirText}`);
        } 
        else if (prefix === 'GLOBAL_CRT' || prefix === 'RADAR_AVISO' || prefix === 'CONTEXT_LIQ' || prefix === 'MASTER_SWEEP') {
            // Información / Notificación sin activar secuencia oficial
            const dirText = currentDirection ? ` (${currentDirection})` : '';
            console.log(`[TRADING] Alerta informativa ${prefix} en ${ticker}${dirText}`);
        }
        else if (prefix === 'MASTER_STRUCT' || prefix.startsWith('BOS') || prefix.startsWith('CHOCH')) {
            // Fase 2 - Confirmación de giro
            // Anti Race-Condition: Si TradingView manda Fase 1 y Fase 2 al mismo milisegundo en la misma vela, 
            // le damos 2 segundos de ventaja a la Fase 1 para que escriba en BBDD antes de que Fase 2 lea.
            console.log(`[TRADING] Estructura recibida en ${ticker}. Esperando 2s para sincronía concurrente...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const rcSnap = await docRef.get();
            state = rcSnap.exists ? rcSnap.data() : null;

            let handled = false;
            
            // Evaluar secuencia Fase 1 (CRT) -> Fase 2 (Struct)
            if (state && state.phase1) {
                if (state.direction) {
                    if (!currentDirection) {
                        console.log(`[TRADING] Se requiere dirección explícita (BOS SELL o CHoCH SELL) para validar Fase 2. Se ignora para la Fase 1.`);
                    } else if (currentDirection !== state.direction) {
                        console.log(`[TRADING] Invalidez de Fase 1 en ${ticker}: Dirección Struct (${currentDirection}) opuesta a CRT (${state.direction}). Se anula memoria.`);
                        await docRef.update({ phase1: false, phase2: false });
                        handled = true;
                    } else {
                        await docRef.update({ phase2: true, phase2_timestamp: now });

                        const isChoch = prefix.startsWith('CHOCH') || (prefix === 'MASTER_STRUCT' && upperText.includes('CHOCH'));
                        const isBos = prefix.startsWith('BOS') || (prefix === 'MASTER_STRUCT' && upperText.includes('BOS'));
                        const dirText = currentDirection ? ` ${currentDirection}` : '';
                        const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

                        if (isChoch && state.timestamp && (now - state.timestamp) <= TWO_HOURS_MS) {
                            const tvLink = `https://www.tradingview.com/chart/orjqnC70/?symbol=${ticker}&interval=15`;
                            const sniperMsg = `🚨 *POSIBLE ENTRADA SNIPER*\n🎯 *Activo*: ${ticker}${dirText}\n🧠 *Setup Armado*: Tuvimos el barrido de liquidez (CRT) y acaba de confirmar reversión con un CHoCH.\n⚡ *Acción*: Poner orden Limit en el Order Block / FVG que dejó la ruptura y esperar el retroceso.\n📊 [Ver en TradingView](${tvLink})`;
                            
                            console.log(`[TRADING] Ingresando orden Sniper, tomando captura de ${ticker}...`);
                            const screenshotBuffer = await takeTradingViewScreenshot(ticker);
                            
                            if (screenshotBuffer) {
                                await bot.api.sendPhoto(targetUserId, new InputFile(screenshotBuffer, `${ticker}_sniper.jpg`), { caption: sniperMsg, parse_mode: 'Markdown' });
                            } else {
                                await bot.api.sendMessage(targetUserId, sniperMsg, { parse_mode: 'Markdown' });
                            }
                            handled = true;
                        } else if (isBos && state.timestamp && (now - state.timestamp) <= TWO_HOURS_MS) {
                            const tvLink = `https://www.tradingview.com/chart/orjqnC70/?symbol=${ticker}&interval=15`;
                            const continuationMsg = `🚀 *POSIBLE ENTRADA DE CONTINUACIÓN*\n🎯 *Activo*: ${ticker}${dirText}\n🧠 *Contexto*: El precio rompió estructura (BOS) a favor de la tendencia tras tomar liquidez.\n⚡ *Acción*: Buscar el FVG o Order Block fresco que acaba de dejar este impulso para sumarse al movimiento (o meter una re-entrada).\n📊 [Ver en TradingView](${tvLink})`;
                            
                            console.log(`[TRADING] Ingresando orden de Continuación, tomando captura de ${ticker}...`);
                            const screenshotBuffer = await takeTradingViewScreenshot(ticker);
                            
                            if (screenshotBuffer) {
                                await bot.api.sendPhoto(targetUserId, new InputFile(screenshotBuffer, `${ticker}_continuation.jpg`), { caption: continuationMsg, parse_mode: 'Markdown' });
                            } else {
                                await bot.api.sendMessage(targetUserId, continuationMsg, { parse_mode: 'Markdown' });
                            }
                            handled = true;
                        }
                    }
                } else if (currentDirection) {
                    await docRef.update({ direction: currentDirection });
                }
            }

            // Evaluar secuencia MASTER_ZONE -> MASTER_STRUCT
            if (state && state.zone_active) {
                if (currentDirection) {
                    if (currentDirection === state.zone_direction) {
                        const dirText = currentDirection ? ` ${currentDirection}` : '';
                        const zoneType = state.zone_type || 'Zona de Interés';
                        const tvLink = `https://www.tradingview.com/chart/orjqnC70/?symbol=${ticker}&interval=15`;
                        const zoneStructMsg = `🔥 *REACCIÓN EN ZONA CONFIRMADA*\n🎯 *Activo*: ${ticker}${dirText}\n🧠 *Contexto*: El precio llegó a una zona de interés (*${zoneType}*) y acaba de confirmar un quiebre estructural a favor.\n⚡ *Acción*: Buscar posicionamiento en el retroceso para tomar el movimiento largo o corto.\n📊 [Ver en TradingView](${tvLink})`;
                        
                        console.log(`[TRADING] MASTER_ZONE + Struct confirmado en ${ticker}. Tomando captura...`);
                        const screenshotBuffer = await takeTradingViewScreenshot(ticker);
                        
                        if (screenshotBuffer) {
                            await bot.api.sendPhoto(targetUserId, new InputFile(screenshotBuffer, `${ticker}_zone_struct.jpg`), { caption: zoneStructMsg, parse_mode: 'Markdown' });
                        } else {
                            await bot.api.sendMessage(targetUserId, zoneStructMsg, { parse_mode: 'Markdown' });
                        }
                        
                        // Una vez ejecutada la entrada de la zona, la anulamos
                        await docRef.update({ zone_active: false });
                        handled = true;
                    } else {
                        console.log(`[TRADING] Invalidez de ZONA en ${ticker}: Estructura (${currentDirection}) opuesta a la dirección de la zona (${state.zone_direction}). Se anula memoria de la zona.`);
                        await docRef.update({ zone_active: false });
                        handled = true;
                    }
                }
            }

            if (!handled) {
                console.log(`[TRADING] Se ignoró ${prefix} en ${ticker} porque no disparó ni lógica de Fase 1 ni lógica de Zona.`);
            }
        }  
        else if (prefix === 'MASTER_ZONE') {
            // Se guarda silenciosamente en memoria esperando su MASTER_STRUCT confirmatorio
            if (currentDirection) {
                let zoneType = 'Zona de Interés';
                if (upperText.includes('FVG')) zoneType = 'Fair Value Gap (FVG)';
                else if (upperText.includes('OB') || upperText.includes('ORDER BLOCK') || upperText.includes('ORDERBLOCK')) zoneType = 'Order Block (OB)';
                else if (upperText.includes('GOLDEN') || upperText.includes('GOLDEN ZONE')) zoneType = 'Golden Zone';

                await docRef.set({
                    zone_active: true,
                    zone_direction: currentDirection,
                    zone_type: zoneType,
                    zone_timestamp: now
                }, { merge: true });
                console.log(`[TRADING] MASTER_ZONE Registrada para ${ticker} esperando confirmación. Tipo: ${zoneType}, Dir: ${currentDirection}`);
            } else {
                console.log(`[TRADING] MASTER_ZONE ignorada en ${ticker} al no especificar dirección identificable.`);
            }
        } 
        else if (prefix === 'CONTEXT_EXIT') {
            console.log(`[TRADING] Exit signal procesada para ${ticker}`);
        } 
        else if (prefix === 'MASTER_INVALID') {
            if (docSnap.exists) {
                await docRef.delete();
            }
            console.log(`[TRADING] Invalidez procesada para ${ticker}`);
        }
        else {
            console.log(`[TRADING] Alerta ignorada: ${prefix}`);
        }
    } catch (e: any) {
        console.error(`[TRADING] Error crítico:`, e.message);
    }
}
