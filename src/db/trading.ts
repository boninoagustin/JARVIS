import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';

// --- INTERFACES DEL RADAR JSON ---
interface RadarZone {
    tf?: string;
    dir: 'BUY' | 'SELL';
    top: number;
    btm: number;
    lvl: string;
    medal?: string;
}

// NUEVO: Sistema de memoria temporal para puntajes
interface ScoreState {
    points: number;
    lastUpdate: number; // Timestamp para limpiar memoria vieja
    events: string[];   // Lista de eventos que sumaron puntos (ej: ["TOUCH_OB", "SWEEP"])
}

interface RadarState {
    lastSyncDate: string | null;
    zones: RadarZone[];
    activeLocks: string[];
    lastPrice: number | null;
    scoreBuy: ScoreState;   // Memoria de compras
    scoreSell: ScoreState;  // Memoria de ventas
}

const emptyState = (): RadarState => ({
    lastSyncDate: null,
    zones: [],
    activeLocks: [],
    lastPrice: null,
    scoreBuy: { points: 0, lastUpdate: 0, events: [] },
    scoreSell: { points: 0, lastUpdate: 0, events: [] }
});

// Tiempo de expiración de la memoria del setup (ej. 4 horas = 14400000 ms)
const SETUP_MEMORY_WINDOW_MS = 14400000;

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
}

export async function processTradingAlert(alertText: string) {
    if (!db) {
        console.error('[TRADING] Base de datos no inicializada.');
        return;
    }

    const textUpToPayload = alertText.includes('Payload:') ? alertText.split('Payload:')[0] : alertText;
    const parts = textUpToPayload.split(/[,|]/).map(p => p.trim());

    if (parts.length < 2) return;

    const prefix = parts[0].toUpperCase();
    const ticker = parts[1].replace(/"/g, '');
    const upperText = alertText.toUpperCase();

    let currentDirection: 'BUY' | 'SELL' | null = null;
    if (upperText.includes('BUY') || upperText.includes('BULLISH') || upperText.includes('COMPRA')) {
        currentDirection = 'BUY';
    } else if (upperText.includes('SELL') || upperText.includes('BEARISH') || upperText.includes('VENTA')) {
        currentDirection = 'SELL';
    }

    const docRef = db.collection('radar_states').doc(ticker);
    const todayStr = new Date().toISOString().split('T')[0];
    const nowMs = Date.now();

    try {
        await db.runTransaction(async (transaction) => {
            const docSnap = await transaction.get(docRef);
            let state: RadarState = docSnap.exists ? (docSnap.data() as RadarState) : emptyState();

            // Compatibilidad con documentos antiguos que no tienen scoreBuy o scoreSell
            if (!state.scoreBuy) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
            if (!state.scoreSell) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };

            // Limpieza de memoria temporal (Si pasaron más de 4hs sin confirmación, resetea los puntos)
            if (nowMs - state.scoreBuy.lastUpdate > SETUP_MEMORY_WINDOW_MS) {
                state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
            }
            if (nowMs - state.scoreSell.lastUpdate > SETUP_MEMORY_WINDOW_MS) {
                state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };
            }

            // =========================================================================
            // 📡 MOTOR 1: SINCRONIZACIÓN DE MAPA EN VIVO
            // =========================================================================
            if (prefix === 'SYNC_ZONES') {
                if (!alertText.includes('Payload:')) return;
                const tfMatch = alertText.match(/TF:\s*([a-zA-Z0-9]+)/i);
                const sourceTf = tfMatch ? tfMatch[1] : 'UNKNOWN';
                const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();

                try {
                    const parsedZones = JSON.parse(payloadStr) as RadarZone[];
                    parsedZones.forEach(z => z.tf = sourceTf);

                    if (state.lastSyncDate !== todayStr) {
                        state.zones = [];
                        state.activeLocks = [];
                        state.lastSyncDate = todayStr;
                    }
                    state.zones = state.zones.filter(z => z.tf !== sourceTf);
                    state.zones.push(...parsedZones);
                } catch (e) {
                    console.error(`[RADAR] Error parseando JSON de zonas:`, e);
                }
            }

            // =========================================================================
            // 📍 MOTOR 2: RASTREO POR GPS (PING PRICE - Modo Silencioso)
            // =========================================================================
            else if (prefix === 'PING_PRICE') {
                const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
                if (!priceMatch) return;
                state.lastPrice = parseFloat(priceMatch[1]);
            }

            // =========================================================================
            // 🎯 MOTOR 3: SISTEMA DE PUNTUACIÓN SCALPER SMC (0 a 10 Puntos)
            // =========================================================================
            else if (currentDirection) {
                const activeScore = currentDirection === 'BUY' ? state.scoreBuy : state.scoreSell;
                const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
                let addedPoints = 0;
                let eventName = "";

                // 1. Llegada a POI (Order Block)
                if (prefix === 'TOUCH_ZONE' && !activeScore.events.includes('TOUCH')) {
                    if (upperText.includes('GOD_ZONE') || upperText.includes('ORO')) {
                        addedPoints = 3;
                        eventName = "Touch OB Oro/God Zone";
                    } else {
                        addedPoints = 2;
                        eventName = "Touch OB Plata/Bronce";
                    }
                    activeScore.events.push('TOUCH');
                }

                // 2. Barrido de Liquidez (Sweep/CRT)
                else if ((prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') && !activeScore.events.includes('SWEEP')) {
                    addedPoints = 3;
                    eventName = "Barrido de Liquidez Macro";
                    activeScore.events.push('SWEEP');
                }

                // 3. Confluencia por Agotamiento Extremo (SMC DIV)
                else if (prefix === 'EVENTO_SMC_DIV' && !activeScore.events.includes('DIV')) {
                    addedPoints = 2;
                    eventName = "Divergencia SMC (Agotamiento)";
                    activeScore.events.push('DIV');
                }

                // 4. Gatillo Definitivo (CHoCH)
                else if (prefix === 'EVENTO_CHOCH') {
                    addedPoints = 2;
                    eventName = "CHoCH Estructural";
                    // El CHoCH es la orden de ejecución, no bloqueamos duplicados por si hace re-entradas.
                }

                // Procesamos los puntos si hubo un evento válido
                if (addedPoints > 0) {
                    activeScore.points += addedPoints;
                    activeScore.lastUpdate = nowMs;
                    // Si sumamos puntos hacia un lado, limpiamos el mapa del lado opuesto por seguridad
                    oppositeScore.points = 0;
                    oppositeScore.events = [];

                    console.log(`[RADAR] ➕ +${addedPoints} pts para ${ticker} ${currentDirection}. Total: ${activeScore.points}/10`);

                    // Evaluador Final de Setup
                    if (prefix === 'EVENTO_CHOCH') {
                        const dirText = currentDirection === 'BUY' ? 'COMPRA' : 'VENTA';

                        if (activeScore.points >= 8) {
                            // SETUP A+ (Puntaje Máximo)
                            let msg = `🔥 *ALERTA FRANCOTIRADOR A+ | ${ticker} | ${dirText}*\n\n`;
                            msg += `🎯 *Puntaje:* ${activeScore.points}/10\n`;
                            msg += `🛠️ *Confluencias:* ${activeScore.events.join(', ')} + CHoCH\n\n`;
                            msg += `🧠 *Acción:* Gatillo institucional confirmado. Entrar con riesgo operativo estándar.`;

                            await enqueueScreenshotRequest(ticker, msg);
                            // Reseteo post-disparo exitoso para no hacer spam si lateraliza
                            activeScore.points = 0;
                            activeScore.events = [];

                        } else if (activeScore.points >= 5) {
                            // SETUP B (Puntaje Medio)
                            let msg = `⚠️ *SETUP CALIDAD MEDIA (B) | ${ticker} | ${dirText}*\n\n`;
                            msg += `🎯 *Puntaje:* ${activeScore.points}/10\n`;
                            msg += `🛠️ *Confluencias:* ${activeScore.events.length > 0 ? activeScore.events.join(', ') : 'Ninguna previa'} + CHoCH\n\n`;
                            msg += `🧠 *Acción:* Faltó confirmación en POI macro o barrido. Reducir riesgo a la mitad (0.5%).`;

                            await enqueueScreenshotRequest(ticker, msg);
                            activeScore.points = 0;
                            activeScore.events = [];
                        } else {
                            console.log(`[RADAR] ❌ CHoCH en ${ticker} ignorado por bajo puntaje (${activeScore.points}/10). Basura.`);
                        }
                    }
                }
            }

            transaction.set(docRef, state);
        });
    } catch (e: any) {
        console.error(`[RADAR] Error crítico en Firebase:`, e.message);
    }
}