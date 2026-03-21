import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWO_HOURS_MS = 4 * 60 * 60 * 1000;
const LATENCY_WINDOW_MS = 5000; // 5 segundos de ventana de latencia

interface PendingStruct {
    type: 'CHOCH' | 'BOS';
    timestamp: number;
}

interface LaneState {
    setupReady: boolean;
    setupTimestamp: number | null;
    setupType: 'CRT' | 'ZONE' | 'BREAKER' | 'PO3' | null;
    pendingStruct: PendingStruct | null; // <-- Ahora la sala de espera es individual por carril
}

interface MarketState {
    macroBias: 'BULLISH' | 'BEARISH' | null;
    macroTimestamp: number | null;
    bullishLane: LaneState;
    bearishLane: LaneState;
}

const emptyLane = (): LaneState => ({
    setupReady: false,
    setupTimestamp: null,
    setupType: null,
    pendingStruct: null
});

const emptyState = (): MarketState => ({
    macroBias: null,
    macroTimestamp: null,
    bullishLane: emptyLane(),
    bearishLane: emptyLane()
});

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

    const parts = alertText.split(/[,|]/).map(p => p.replace(/"/g, '').trim());
    if (parts.length < 2) {
        console.error('[TRADING] Formato de alerta inválido:', alertText);
        return;
    }

    const prefix = parts[0].toUpperCase();
    const ticker = parts[1];
    const upperText = alertText.toUpperCase();

    let currentDirection: 'BUY' | 'SELL' | null = null;
    if (upperText.includes('BUY') || upperText.includes('BULLISH') || upperText.includes('ALCISTA') || upperText.includes('COMPRA') || upperText.includes('LONG')) {
        currentDirection = 'BUY';
    } else if (upperText.includes('SELL') || upperText.includes('BEARISH') || upperText.includes('BAJISTA') || upperText.includes('VENTA') || upperText.includes('SHORT')) {
        currentDirection = 'SELL';
    }

    const docRef = db.collection('market_states').doc(ticker);
    const now = Date.now();

    try {
        await db.runTransaction(async (transaction) => {
            const docSnap = await transaction.get(docRef);
            let state: MarketState = docSnap.exists ? (docSnap.data() as MarketState) : emptyState();

            // 1. LIMPIEZA POR CADUCIDAD (Mantenimiento de Memoria)
            if (state.macroTimestamp && (now - state.macroTimestamp > SIX_HOURS_MS)) {
                state.macroBias = null;
                state.macroTimestamp = null;
                console.log(`[TRADING] MacroBias caducado en ${ticker}`);
            }

            const cleanLane = (lane: LaneState, dirName: string) => {
                // Caducidad del Setup (4 horas)
                if (lane.setupTimestamp && (now - lane.setupTimestamp > FOUR_HOURS_MS)) {
                    lane.setupReady = false;
                    lane.setupTimestamp = null;
                    lane.setupType = null;
                    console.log(`[TRADING] Setup ${dirName} caducado en ${ticker}`);
                }
                // Caducidad de la sala de espera de structs (5 segundos)
                if (lane.pendingStruct && (now - lane.pendingStruct.timestamp > LATENCY_WINDOW_MS)) {
                    lane.pendingStruct = null;
                }
            };

            cleanLane(state.bullishLane, 'BULLISH');
            cleanLane(state.bearishLane, 'BEARISH');

            // 2. PROCESAMIENTO POR PREFIJO

            // --- FASE 1: MACRO CONTEXT & PO3 (Fusión de Permiso y Setup) ---
            if (prefix === 'PO3_LIVE') {
                const typePart = parts[3]?.split(':')[1]?.trim().toUpperCase() || '';
                const isBullish = typePart.includes('BULLISH');
                const isBearish = typePart.includes('BEARISH');

                if (isBullish || isBearish) {
                    const direction = isBullish ? 'BUY' : 'SELL';
                    state.macroBias = isBullish ? 'BULLISH' : 'BEARISH';
                    state.macroTimestamp = now;
                    console.log(`[TRADING] Fase 1: MacroBias ${state.macroBias} en ${ticker}`);

                    // NUEVO: PO3 también funciona como Setup local
                    const lane = isBullish ? state.bullishLane : state.bearishLane;
                    lane.setupReady = true;
                    lane.setupTimestamp = now;
                    lane.setupType = 'PO3';
                    console.log(`[TRADING] Fase 2 Automática: PO3 activó SetupReady en carril ${direction} para ${ticker}`);

                    // REGLA DE LATENCIA INVERSA (Si el CHOCH se adelantó)
                    if (lane.pendingStruct && (now - lane.pendingStruct.timestamp <= LATENCY_WINDOW_MS)) {
                        console.log(`[TRADING] Latencia: PO3 capturó un struct pendiente ${lane.pendingStruct.type}`);
                        await handleTrigger(ticker, state, direction, lane.pendingStruct.type, transaction, docRef);
                        lane.pendingStruct = null; // Limpiamos después de usar
                    }
                }
            }

            // --- FASE 2: SETUP LOCAL (Zonas o Trampas Menores) ---
            else if (prefix === 'LOCAL_CRT' || prefix === 'LOCAL_CRT_SCALP' || prefix === 'MASTER_ZONE') {
                if (!currentDirection) {
                    console.log(`[TRADING] Alerta ${prefix} sin dirección clara en ${ticker}. Ignorada.`);
                    return;
                }

                let effectiveDirection = currentDirection;
                const isBreaker = upperText.includes('BREAKER_BLOCK') || upperText.includes('BREAKER BLOCK');
                if (isBreaker) {
                    effectiveDirection = (currentDirection === 'BUY') ? 'SELL' : 'BUY';
                    console.log(`[TRADING] BREAKER detectado. Invirtiendo ${currentDirection} -> ${effectiveDirection}`);
                }

                const lane = (effectiveDirection === 'BUY') ? state.bullishLane : state.bearishLane;
                lane.setupReady = true;
                lane.setupTimestamp = now;
                lane.setupType = prefix === 'MASTER_ZONE' ? (isBreaker ? 'BREAKER' : 'ZONE') : 'CRT';

                console.log(`[TRADING] Fase 2: SetupReady en carril ${effectiveDirection} (${lane.setupType}) para ${ticker}`);

                // REGLA DE LATENCIA INVERSA
                if (lane.pendingStruct && (now - lane.pendingStruct.timestamp <= LATENCY_WINDOW_MS)) {
                    console.log(`[TRADING] Latencia: Setup capturó un struct pendiente ${lane.pendingStruct.type}`);
                    await handleTrigger(ticker, state, effectiveDirection, lane.pendingStruct.type, transaction, docRef);
                    lane.pendingStruct = null; // Limpiamos después de usar
                }
            }

            // --- FASE 3: GATILLO (MASTER_STRUCT / CHOCH / BOS) ---
            else if (prefix === 'MASTER_STRUCT' || prefix.startsWith('BOS') || prefix.startsWith('CHOCH')) {
                const triggerType: 'CHOCH' | 'BOS' = (prefix.startsWith('CHOCH') || (prefix === 'MASTER_STRUCT' && upperText.includes('CHOCH'))) ? 'CHOCH' : 'BOS';

                if (!currentDirection) {
                    console.log(`[TRADING] Gatillo ${triggerType} sin dirección en ${ticker}. Ignorado.`);
                    return;
                }

                console.log(`[TRADING] Fase 3: Gatillo ${triggerType} ${currentDirection} recibido en ${ticker}`);

                // KILL SWITCH: Invalidación lógica por estructura opuesta
                const oppositeDirection = (currentDirection === 'BUY') ? 'SELL' : 'BUY';
                const oppositeLane = (oppositeDirection === 'BUY') ? state.bullishLane : state.bearishLane;

                if (oppositeLane.setupReady || oppositeLane.pendingStruct) {
                    console.log(`[TRADING] KILL SWITCH: Gatillo ${currentDirection} anula operaciones del carril ${oppositeDirection}.`);
                    if (oppositeDirection === 'BUY') state.bullishLane = emptyLane();
                    else state.bearishLane = emptyLane();
                }

                // Procesamiento en el carril correcto
                const currentLane = (currentDirection === 'BUY') ? state.bullishLane : state.bearishLane;

                if (currentLane.setupReady) {
                    // HAY SETUP ACTIVO → Disparar inmediatamente
                    await handleTrigger(ticker, state, currentDirection, triggerType, transaction, docRef);
                    currentLane.pendingStruct = null;
                } else {
                    // NO HAY SETUP → Guardar en la sala de espera de SU carril
                    currentLane.pendingStruct = {
                        type: triggerType,
                        timestamp: now
                    };
                    console.log(`[TRADING] Gatillo ${triggerType} guardado como pendiente en carril ${currentDirection} (Latencia iniciada).`);
                }
            }

            // --- RESET TOTAL MANUAl ---
            else if (prefix === 'MASTER_INVALID') {
                state.bullishLane = emptyLane();
                state.bearishLane = emptyLane();
                state.macroBias = null;
                state.macroTimestamp = null;
                console.log(`[TRADING] Memoria completamente reseteada para ${ticker}`);
            } else {
                console.log(`[TRADING] Alerta ignorada: ${prefix}`);
            }

            // Guardar el estado actualizado en Firebase
            transaction.set(docRef, state);
        });
    } catch (e: any) {
        console.error(`[TRADING] Error crítico en la transacción de Firebase:`, e.message);
    }
}

async function handleTrigger(
    ticker: string,
    state: MarketState,
    direction: 'BUY' | 'SELL',
    type: 'CHOCH' | 'BOS',
    transaction: any,
    docRef: any
) {
    const isBullish = direction === 'BUY';
    const lane = isBullish ? state.bullishLane : state.bearishLane;
    const dirText = isBullish ? 'COMPRA' : 'VENTA';
    const tvLink = `https://www.tradingview.com/chart/orjqnC70/?symbol=${ticker}&interval=15`;

    let alertType: 'GOD' | 'SNIPER' | 'CONTINUATION' | null = null;
    let message = '';

    // JERARQUÍA DE EJECUCIÓN (Evalúa de mayor a menor probabilidad)

    const macroAligned = (state.macroBias === 'BULLISH' && isBullish) || (state.macroBias === 'BEARISH' && !isBullish);

    // P1: GOD TIER - CHOCH + Setup Activo (PO3, CRT o ZONE) + MacroBias a favor
    if (type === 'CHOCH' && macroAligned && lane.setupReady) {
        alertType = 'GOD';
        message = `🚀 *ALERTA GOD TIER*: ${ticker} | *${dirText}*\n\n💎 *Confluencia Total Confirmada*\n✅ MacroBias a Favor\n✅ Setup Activo (${lane.setupType})\n✅ Gatillo CHOCH\n\n📊 [Ver en TradingView](${tvLink})`;
    }
    // P2: SNIPER - CHOCH + Setup Activo (MacroBias en contra o neutro)
    else if (type === 'CHOCH' && lane.setupReady) {
        alertType = 'SNIPER';
        message = `🎯 *ALERTA SNIPER*: ${ticker} | *${dirText}*\n\n🧠 *Contexto Intradía*\n✅ Setup Activo (${lane.setupType})\n⚡ Gatillo CHOCH\n⚠️ MacroBias: ${state.macroBias || 'Neutro'}\n\n📊 [Ver en TradingView](${tvLink})`;
    }
    // P3: CONTINUACIÓN - BOS + Setup Activo (Pero solo válido en CRT, ZONE o PO3; excluye Breakers para continuación directa)
    else if (type === 'BOS' && lane.setupReady && (lane.setupType === 'CRT' || lane.setupType === 'ZONE' || lane.setupType === 'PO3')) {
        alertType = 'CONTINUATION';
        message = `🛤️ *ALERTA CONTINUACIÓN*: ${ticker} | *${dirText}*\n\n🏃 *Movimiento en Tendencia*\n✅ Setup de Continuación (${lane.setupType})\n⚡ Gatillo BOS\n\n📊 [Ver en TradingView](${tvLink})`;
    }

    if (alertType) {
        if (alertType === 'GOD') {
            await sendTelegramAlert(message);
        } else {
            await enqueueScreenshotRequest(ticker, message);
        }

        // VACIADO DE CARRIL: Borramos toda la memoria del setup usado para evitar que vuelva a disparar
        if (isBullish) state.bullishLane = emptyLane();
        else state.bearishLane = emptyLane();

        console.log(`[TRADING] ✅ ALERTA ${alertType} enviada para ${ticker} | ${dirText} | Gatillo: ${type}`);
    } else {
        console.log(`[TRADING] ⚠️ Gatillo ${type} ignorado por falta de confluencias. Setup actual: ${lane.setupType}`);
    }
}