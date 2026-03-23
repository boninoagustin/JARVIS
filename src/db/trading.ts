import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const LATENCY_WINDOW_MS = 5000;

interface PendingStruct {
    type: 'CHOCH' | 'BOS';
    timestamp: number;
}

interface LaneState {
    setupReady: boolean;
    setupTimestamp: number | null;
    activeSetups: string[];
    pendingStruct: PendingStruct | null;
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
    activeSetups: [],
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

            // 1. LIMPIEZA POR CADUCIDAD
            if (state.macroTimestamp && (now - state.macroTimestamp > SIX_HOURS_MS)) {
                state.macroBias = null;
                state.macroTimestamp = null;
                console.log(`[TRADING] MacroBias caducado en ${ticker}`);
            }

            const cleanLane = (lane: LaneState, dirName: string) => {
                if (lane.setupTimestamp && (now - lane.setupTimestamp > FOUR_HOURS_MS)) {
                    lane.setupReady = false;
                    lane.setupTimestamp = null;
                    lane.activeSetups = [];
                    console.log(`[TRADING] Setup ${dirName} caducado en ${ticker}`);
                }
                if (lane.pendingStruct && (now - lane.pendingStruct.timestamp > LATENCY_WINDOW_MS)) {
                    lane.pendingStruct = null;
                }
            };

            cleanLane(state.bullishLane, 'BULLISH');
            cleanLane(state.bearishLane, 'BEARISH');

            // --- FASE 1: MACRO CONTEXT & PO3 ---
            if (prefix === 'PO3_LIVE') {
                const typePart = parts[3]?.split(':')[1]?.trim().toUpperCase() || '';
                const isBullish = typePart.includes('BULLISH');
                const isBearish = typePart.includes('BEARISH');

                if (isBullish || isBearish) {
                    const direction = isBullish ? 'BUY' : 'SELL';
                    state.macroBias = isBullish ? 'BULLISH' : 'BEARISH';
                    state.macroTimestamp = now;

                    // SOBREESCRITURA DE ESTADO: Borramos la memoria del carril opuesto
                    const oppositeDirection = direction === 'BUY' ? 'SELL' : 'BUY';
                    if (oppositeDirection === 'BUY') state.bullishLane = emptyLane();
                    else state.bearishLane = emptyLane();

                    const lane = isBullish ? state.bullishLane : state.bearishLane;
                    lane.setupReady = true;
                    lane.setupTimestamp = now;
                    if (!lane.activeSetups.includes('PO3')) lane.activeSetups.push('PO3');

                    console.log(`[TRADING] Fase 1: PO3 activó carril ${direction}. Carril ${oppositeDirection} limpiado.`);

                    if (lane.pendingStruct && (now - lane.pendingStruct.timestamp <= LATENCY_WINDOW_MS)) {
                        await handleTrigger(ticker, state, direction, lane.pendingStruct.type, transaction, docRef);
                        lane.pendingStruct = null;
                    }
                }
            }

            // --- FASE 2: SETUP LOCAL Y BREAKER BLOCKS (Sobre-escritura) ---
            else if (prefix === 'LOCAL_CRT' || prefix === 'LOCAL_CRT_SCALP' || prefix === 'MASTER_ZONE') {
                if (!currentDirection) return;

                // TradingView ya manda la dirección invertida para los Breakers, no hace falta invertirla en Node.
                const effectiveDirection = currentDirection;
                const isBreaker = upperText.includes('BREAKER_BLOCK') || upperText.includes('BREAKER BLOCK');

                // SOBREESCRITURA DE ESTADO: Llegó un OB/Breaker nuevo, borramos el carril contrario
                const oppositeDirection = effectiveDirection === 'BUY' ? 'SELL' : 'BUY';
                if (oppositeDirection === 'BUY') state.bullishLane = emptyLane();
                else state.bearishLane = emptyLane();

                const lane = (effectiveDirection === 'BUY') ? state.bullishLane : state.bearishLane;
                lane.setupReady = true;
                lane.setupTimestamp = now;

                const newSetup = prefix === 'MASTER_ZONE' ? (isBreaker ? 'BREAKER' : 'ZONE') : 'CRT';
                if (!lane.activeSetups.includes(newSetup)) lane.activeSetups.push(newSetup);

                console.log(`[TRADING] Fase 2: Setup ${newSetup} activó carril ${effectiveDirection}. Carril ${oppositeDirection} limpiado.`);

                if (lane.pendingStruct && (now - lane.pendingStruct.timestamp <= LATENCY_WINDOW_MS)) {
                    await handleTrigger(ticker, state, effectiveDirection, lane.pendingStruct.type, transaction, docRef);
                    lane.pendingStruct = null;
                }
            }

            // --- FASE 3: GATILLO ESTRUCTURAL (Ignora ruido contrario) ---
            else if (prefix === 'MASTER_STRUCT' || prefix.startsWith('BOS') || prefix.startsWith('CHOCH')) {
                const triggerType: 'CHOCH' | 'BOS' = (prefix.startsWith('CHOCH') || (prefix === 'MASTER_STRUCT' && upperText.includes('CHOCH'))) ? 'CHOCH' : 'BOS';

                if (!currentDirection) return;

                console.log(`[TRADING] Fase 3: Gatillo ${triggerType} ${currentDirection} recibido en ${ticker}`);

                // Procesamiento EXCLUSIVO en el carril de la misma dirección (Ignora el opuesto)
                const currentLane = (currentDirection === 'BUY') ? state.bullishLane : state.bearishLane;

                if (currentLane.setupReady) {
                    await handleTrigger(ticker, state, currentDirection, triggerType, transaction, docRef);
                    currentLane.pendingStruct = null;
                } else {
                    currentLane.pendingStruct = { type: triggerType, timestamp: now };
                    console.log(`[TRADING] Gatillo ${triggerType} pendiente en carril ${currentDirection}.`);
                }
            }

            // --- RESET TOTAL MANUAL ---
            else if (prefix === 'MASTER_INVALID') {
                state.bullishLane = emptyLane();
                state.bearishLane = emptyLane();
                state.macroBias = null;
                state.macroTimestamp = null;
                console.log(`[TRADING] Memoria reseteada manualmente para ${ticker}`);
            }

            transaction.set(docRef, state);
        });
    } catch (e: any) {
        console.error(`[TRADING] Error crítico en Firebase:`, e.message);
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
    const setupsText = lane.activeSetups.join(' + ');

    let alertType: 'GOD' | 'SNIPER' | 'CONTINUATION' | null = null;
    let message = '';

    const macroAligned = (state.macroBias === 'BULLISH' && isBullish) || (state.macroBias === 'BEARISH' && !isBullish);
    // Agregamos 'BREAKER' a la lista para que el BOS lo active correctamente
    const hasValidContinuationSetup = lane.activeSetups.includes('CRT') || lane.activeSetups.includes('ZONE') || lane.activeSetups.includes('PO3') || lane.activeSetups.includes('BREAKER');

    // P1: GOD TIER
    if (type === 'CHOCH' && macroAligned && lane.setupReady) {
        alertType = 'GOD';
        message = `🚀 *ALERTA GOD TIER*: ${ticker} | *${dirText}*\n\n💎 *Confluencia Confirmada*\n✅ MacroBias a Favor\n🔥 Setups: *${setupsText}*\n✅ Gatillo CHOCH\n\n📊 [TradingView](${tvLink})`;
    }
    // P2: SNIPER
    else if (type === 'CHOCH' && lane.setupReady) {
        alertType = 'SNIPER';
        message = `🎯 *ALERTA SNIPER*: ${ticker} | *${dirText}*\n\n🧠 *Contexto Intradía*\n🔥 Setups: *${setupsText}*\n⚡ Gatillo CHOCH\n⚠️ MacroBias: ${state.macroBias || 'Neutro'}\n\n📊 [TradingView](${tvLink})`;
    }
    // P3: CONTINUACIÓN (Se activa si el Setup es BREAKER y llega un BOS)
    else if (type === 'BOS' && lane.setupReady && hasValidContinuationSetup) {
        alertType = 'CONTINUATION';
        message = `🛤️ *ALERTA CONTINUACIÓN*: ${ticker} | *${dirText}*\n\n🏃 *Movimiento en Tendencia*\n🔥 Setups: *${setupsText}*\n⚡ Gatillo BOS\n\n📊 [TradingView](${tvLink})`;
    }

    if (alertType) {
        if (alertType === 'GOD') {
            await sendTelegramAlert(message);
        } else {
            await enqueueScreenshotRequest(ticker, message);
        }

        // Vaciamos ÚNICAMENTE el carril usado.
        if (isBullish) state.bullishLane = emptyLane();
        else state.bearishLane = emptyLane();

        console.log(`[TRADING] ✅ ALERTA ${alertType} para ${ticker} | ${dirText} | Gatillo: ${type}`);
    } else {
        console.log(`[TRADING] ⚠️ Gatillo ${type} ignorado por falta de confluencias.`);
    }
}