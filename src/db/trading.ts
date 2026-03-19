import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

async function sendTelegramAlert(message: string) {
    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try {
            await bot.api.sendMessage(userId, message, { parse_mode: 'Markdown' });
        } catch (err: any) {
            console.error(`[TRADING] Error enviando alerta a ${userId}:`, err.message);
        }
    }
}

/**
 * Encola un pedido de screenshot en Firestore para que el worker local lo procese
 * y luego Vercel lo envíe a Telegram.
 */
async function enqueueScreenshotRequest(ticker: string, message: string) {
    if (!db) return;
    const requestRef = db.collection('screenshot_requests').doc();
    await requestRef.set({
        ticker,
        message,
        status: 'pending',
        timestamp: Date.now()
    });
    console.log(`[TRADING] Screenshot encolado (${requestRef.id}) para ${ticker}`);
}

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
    if (upperText.includes('BUY') || upperText.includes('BULLISH') || upperText.includes('ALCISTA') || upperText.includes('COMPRA') || upperText.includes('LONG')) {
        currentDirection = 'BUY';
    } else if (upperText.includes('SELL') || upperText.includes('BEARISH') || upperText.includes('BAJISTA') || upperText.includes('VENTA') || upperText.includes('SHORT')) {
        currentDirection = 'SELL';
    }

    console.log(`[TRADING] Procesando Alerta SMC -> Prefijo: ${prefix}, Par: ${ticker}, Dir: ${currentDirection}`);

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

            // Check retrospectivo: ¿Hubo un MASTER_STRUCT hace muy poco (< 5s) que calce con esta dirección?
            // Esto resuelve el caso donde TV manda STRUCT antes que CRT en la misma vela.
            if (currentDirection && state && state.last_struct_time) {
                const diffStruct = now - state.last_struct_time;
                if (diffStruct < 5000 && state.last_struct_dir === currentDirection) {
                    console.log(`[TRADING] Detectado MASTER_STRUCT previo (${diffStruct}ms). Disparando notificación retroactiva...`);
                    const isChoch = state.last_struct_type === 'CHOCH';
                    const isBos = state.last_struct_type === 'BOS';
                    const tvLink = `https://www.tradingview.com/chart/orjqnC70/?symbol=${ticker}&interval=15`;

                    if (isChoch) {
                        const message = `🚨 *POSIBLE ENTRADA SNIPER*\n🎯 *Activo*: ${ticker} ${currentDirection}\n🧠 *Setup Armado*: Tuvimos el barrido de liquidez (CRT) y acaba de confirmar reversión con un CHoCH.\n⚡ *Acción*: Poner orden Limit en el Order Block / FVG que dejó la ruptura y esperar el retroceso.\n📊 [Ver en TradingView](${tvLink})`;
                        await enqueueScreenshotRequest(ticker, message);
                        await docRef.update({ phase2: true, phase2_timestamp: now });
                    } else if (isBos) {
                        const message = `🚀 *POSIBLE ENTRADA DE CONTINUACIÓN*\n🎯 *Activo*: ${ticker} ${currentDirection}\n🧠 *Contexto*: El precio rompió estructura (BOS) a favor de la tendencia tras tomar liquidez.\n⚡ *Acción*: Buscar el FVG o Order Block fresco que acaba de dejar este impulso para sumarse al movimiento.\n📊 [Ver en TradingView](${tvLink})`;
                        await enqueueScreenshotRequest(ticker, message);
                        await docRef.update({ phase2: true, phase2_timestamp: now });
                    }
                }
            }
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
                        const tvLink = `https://www.tradingview.com/chart/orjqnC70/?symbol=${ticker}&interval=15`;

                        if (isChoch && state.timestamp && (now - state.timestamp) <= TWO_HOURS_MS) {
                            const sniperMsg = `🚨 *POSIBLE ENTRADA SNIPER*\n🎯 *Activo*: ${ticker}${dirText}\n🧠 *Setup Armado*: Tuvimos el barrido de liquidez (CRT) y acaba de confirmar reversión con un CHoCH.\n⚡ *Acción*: Poner orden Limit en el Order Block / FVG que dejó la ruptura y esperar el retroceso.\n📊 [Ver en TradingView](${tvLink})`;
                            
                            console.log(`[TRADING] Entrada Sniper detectada en ${ticker}. Encolando screenshot...`);
                            await enqueueScreenshotRequest(ticker, sniperMsg);
                            handled = true;
                        } else if (isBos && state.timestamp && (now - state.timestamp) <= TWO_HOURS_MS) {
                            const continuationMsg = `🚀 *POSIBLE ENTRADA DE CONTINUACIÓN*\n🎯 *Activo*: ${ticker}${dirText}\n🧠 *Contexto*: El precio rompió estructura (BOS) a favor de la tendencia tras tomar liquidez.\n⚡ *Acción*: Buscar el FVG o Order Block fresco que acaba de dejar este impulso para sumarse al movimiento (o meter una re-entrada).\n📊 [Ver en TradingView](${tvLink})`;
                            
                            console.log(`[TRADING] Entrada Continuación detectada en ${ticker}. Encolando screenshot...`);
                            await enqueueScreenshotRequest(ticker, continuationMsg);
                            handled = true;
                        }
                    }
                    await docRef.update({ direction: currentDirection });
                }
            }

            // Evaluar secuencia MASTER_ZONE -> MASTER_STRUCT
            if (state && state.zone_active) {
                // Si la estructura no trae dirección en el texto, hereda la de la zona para confirmar.
                // Si la trae, DEBE ser igual a la de la zona, de lo contrario invalida.
                const structDirection = currentDirection || state.zone_direction;
                
                if (structDirection === state.zone_direction) {
                    const dirText = structDirection ? ` ${structDirection}` : '';
                    const zoneType = state.zone_type || 'Zona de Interés';
                    const tvLink = `https://www.tradingview.com/chart/orjqnC70/?symbol=${ticker}&interval=15`;
                    const zoneStructMsg = `🔥 *REACCIÓN EN ZONA CONFIRMADA*\n🎯 *Activo*: ${ticker}${dirText}\n🧠 *Contexto*: El precio llegó a una zona de interés (*${zoneType}*) y acaba de confirmar un quiebre estructural a favor.\n⚡ *Acción*: Buscar posicionamiento en el retroceso para tomar el movimiento largo o corto.\n📊 [Ver en TradingView](${tvLink})`;
                    
                    console.log(`[TRADING] MASTER_ZONE + Struct confirmado en ${ticker}. Encolando screenshot...`);
                    await enqueueScreenshotRequest(ticker, zoneStructMsg);
                    
                    // Una vez ejecutada la entrada de la zona, la anulamos
                    await docRef.update({ zone_active: false });
                    handled = true;
                } else if (currentDirection) {
                    // Dirección opuesta: se ignora, la zona sigue activa esperando
                    // Solo un BREAKER_BLOCK o un nuevo MASTER_ZONE pueden cambiar la dirección esperada
                    console.log(`[TRADING] Struct (${currentDirection}) opuesta a zona (${state.zone_direction}) in ${ticker}. Se ignora, zona sigue activa.`);
                    handled = true;
                }
            }

            // --- LÓGICA ALERTA GOD TIER ---
            const isChoch = prefix.startsWith('CHOCH') || (prefix === 'MASTER_STRUCT' && upperText.includes('CHOCH'));
            if (isChoch && currentDirection && state) {
                const isDirAligned = (tfDir: string | null | undefined, tradeDir: 'BUY' | 'SELL'): boolean => {
                    if (!tfDir) return false;
                    const normalizedTfDir = tfDir.toUpperCase();
                    if (tradeDir === 'BUY') return normalizedTfDir === 'BULLISH';
                    if (tradeDir === 'SELL') return normalizedTfDir === 'BEARISH';
                    return false;
                };

                // 1. Macro: D, 4H y 1H alineados con el trade
                const macroAligned = isDirAligned(state.tf_D, currentDirection) && 
                                     isDirAligned(state.tf_4H, currentDirection) && 
                                     isDirAligned(state.tf_1H, currentDirection);
                
                if (macroAligned) {
                    // 2. Contexto/Trampa: Zona activa O CRT registrado (Fase 1)
                    const zoneMatch = state.zone_active && (state.zone_direction === currentDirection);
                    const trapMatch = state.phase1 && (state.direction === currentDirection);

                    if (zoneMatch || trapMatch) {
                        const buySellText = currentDirection === 'BUY' ? 'COMPRA' : 'VENTA';
                        const zoneIcon = zoneMatch ? '✅' : '➖';
                        const trapIcon = trapMatch ? '✅' : '➖';
                        
                        const godTierMsg = `🚀 *ALERTA GOD TIER*: ${ticker} | *${buySellText}*\n\n` +
                                           `💎 *Confluencia Confirmada*:\n` +
                                           `✅ Macro: Barridos D1 + 4H + 1H Alineados.\n` +
                                           `${zoneIcon} Zona: Apoyo en MASTER_ZONE.\n` +
                                           `${trapIcon} Trampa: Barrido de liquidez (CRT Local).\n` +
                                           `✅ Gatillo: CHoCH Confirmado.`;
                        
                        await sendTelegramAlert(godTierMsg);
                        console.log(`[TRADING] ALERTA GOD TIER ENVIADA para ${ticker}`);
                    }
                }
            }
            // ------------------------------

            if (!handled) {
                console.log(`[TRADING] Se ignoró ${prefix} en ${ticker} porque no disparó ni lógica de Fase 1 ni lógica de Zona.`);
            }

            // Guardar este struct como "último visto" para que un CRT lento pueda consumirlo retroactivamente
            const structType = isChoch ? 'CHOCH' : 'BOS';
            await docRef.update({
                last_struct_time: now,
                last_struct_dir: currentDirection,
                last_struct_type: structType
            });
        }  
        else if (prefix === 'PO3_LIVE') {
            // Formato esperado: PO3_LIVE | TF: [X] | [Activo] | Tipo: CRT_[DIR] | Estado: [ESTADO]
            const tfPart = parts[1]?.split(':')[1]?.trim() || ''; // Ej: "1H"
            const ticker = parts[2]?.trim();
            const typePart = parts[3]?.split(':')[1]?.trim() || ''; // Ej: "CRT_BULLISH"
            const estadoPart = parts[4]?.split(':')[1]?.trim() || ''; // Ej: "ACTIVO"
            
            if (!ticker || !tfPart || !estadoPart) {
                console.error('[TRADING] PO3_LIVE alerta incompleta:', alertText);
                return;
            }

            const direction = typePart.toUpperCase().includes('BULLISH') ? 'BULLISH' : 
                             (typePart.toUpperCase().includes('BEARISH') ? 'BEARISH' : null);
            const isActivo = estadoPart.toUpperCase() === 'ACTIVO';
            
            // 1. Actualización Silenciosa en DB
            const tfKey = `tf_${tfPart}`; // Guardará en tf_D, tf_4H, tf_1H, etc.
            const updateObj: any = {};
            updateObj[tfKey] = isActivo ? direction : null;
            updateObj.timestamp = now; // Para evitar caducidad de 6h
            
            await docRef.set(updateObj, { merge: true });
            console.log(`[TRADING] PO3_LIVE ${tfKey} actualizado a ${isActivo ? direction : 'NULL'} para ${ticker}`);

            // 2. Evaluar Triggers (después de actualizar)
            const freshSnap = await docRef.get();
            const freshState = freshSnap.data();

            if (freshState) {
                const d = freshState.tf_D;
                const h4 = freshState.tf_4H;
                const h1 = freshState.tf_1H;
                const oldSniperMode = freshState.sniper_mode || false;

                const isAligned = d && h4 && h1 && (d === h4) && (h4 === h1);
                
                // A. Activación Sniper (Alineación D+4H+1H)
                if (isAligned && !oldSniperMode) {
                    await docRef.update({ sniper_mode: true });
                    const msg = `🟢 *ALERTA SNIPER*: ${ticker} - Confluencia D+4H+1H *${d}*. Listo para buscar gatillo en 5M.`;
                    await sendTelegramAlert(msg);
                    console.log(`[TRADING] SNIPER_MODE ACTIVADO en ${ticker}`);
                } 
                // B. Cancelación Sniper (Ruptura por CANCELADO en temporalidades clave)
                else if (oldSniperMode && !isActivo && ['D', '4H', '1H'].includes(tfPart)) {
                    await docRef.update({ sniper_mode: false });
                    const msg = `🔴 *ALERTA ABORTADA*: ${ticker} - Se perdió el CRT en *${tfPart}*. Cancelar búsqueda en 5M.`;
                    await sendTelegramAlert(msg);
                    console.log(`[TRADING] SNIPER_MODE CANCELADO en ${ticker}`);
                }
            }
        }
        else if (prefix === 'MASTER_ZONE') {
            const isBreakerBlock = upperText.includes('BREAKER_BLOCK') || upperText.includes('BREAKER BLOCK');

            if (isBreakerBlock && currentDirection) {
                // Breaker Block: invierte la dirección esperada en la zona activa
                await docRef.set({
                    zone_active: true,
                    zone_direction: currentDirection,
                    zone_type: 'Breaker Block',
                    zone_timestamp: state?.zone_timestamp || now
                }, { merge: true });
                console.log(`[TRADING] BREAKER BLOCK en ${ticker}: Dirección esperada invertida a ${currentDirection}. Esperando MASTER_STRUCT ${currentDirection}.`);
            } else if (!isBreakerBlock && currentDirection) {
                // MASTER_ZONE normal: setea la zona y dirección desde cero
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
