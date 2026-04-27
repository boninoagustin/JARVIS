import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';
import { evaluateWithKronos } from '../services/kronos.js';
import { evaluateWithMixture } from '../llm/mixture.js';
import { logTrade } from '../services/journal.js';

// --- INTERFACES DEL RADAR JSON ---
interface RadarZone {
    tf?: string;
    dir: 'BUY' | 'SELL';
    top: number;
    btm: number;
    lvl: string;
    medal?: string;
}

// SISTEMA DE MEMORIA TEMPORAL PARA APILAMIENTO
interface ScoreState {
    points: number;
    lastUpdate: number;
    events: string[];
}

interface RadarState {
    lastSyncDate: string | null;
    zones: RadarZone[];
    activeLocks: string[];
    lastPrice: number | null;
    scoreBuy: ScoreState;
    scoreSell: ScoreState;
    marketBias: { [tf: string]: 'BUY' | 'SELL' | 'NEUTRAL' };
    lastApproachAlert?: number;
    lastSniperAlert?: number;
}

const emptyState = (): RadarState => ({
    lastSyncDate: null,
    zones: [],
    activeLocks: [],
    lastPrice: null,
    scoreBuy: { points: 0, lastUpdate: 0, events: [] },
    scoreSell: { points: 0, lastUpdate: 0, events: [] },
    // Cambiamos el 5 por el 3 para el mapa de tendencias
    marketBias: { "240": 'NEUTRAL', "60": 'NEUTRAL', "15": 'NEUTRAL', "3": 'NEUTRAL' },
    lastApproachAlert: 0,
    lastSniperAlert: 0
});

const SNIPER_COOLDOWN_MS = 300000; // 5 minutos entre alertas del mismo ticker
const SETUP_MEMORY_WINDOW_MS = 14400000; // 4 Horas

// --- SISTEMA ANTI-DUPLICADOS ---
const recentAlertCache = new Map<string, number>();
const DEDUP_WINDOW_MS = 60000; // 60 segundos de ventana anti-duplicados

function isDuplicate(fingerprint: string): boolean {
    const now = Date.now();
    // Limpiar cache de entradas viejas
    for (const [key, ts] of recentAlertCache) {
        if (now - ts > DEDUP_WINDOW_MS) recentAlertCache.delete(key);
    }
    if (recentAlertCache.has(fingerprint)) {
        console.log(`[RADAR] 🛑 Alerta duplicada ignorada: ${fingerprint}`);
        return true;
    }
    recentAlertCache.set(fingerprint, now);
    return false;
}

const parseTF = (tf: string) => {
    if (tf === '240') return '4H';
    if (tf === '60') return '1H';
    if (tf === '15') return '15M';
    if (tf === '3') return '3M'; // Actualizado a 3M
    return `${tf}M`;
};

async function sendTelegramAlert(message: string) {
    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try {
            await bot.api.sendMessage(userId, message, { parse_mode: 'Markdown' });
        } catch (err: any) {
            console.error(`[TRADING] Error enviando alerta a ${userId}:`, err.message);
            try {
                await bot.api.sendMessage(userId, message);
            } catch (fallbackErr: any) {
                console.error(`[TRADING] Fallback fallo a ${userId}:`, fallbackErr.message);
            }
        }
    }
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

    const tfMatch = alertText.match(/TF:\s*([a-zA-Z0-9]+)/i);
    const eventTf = tfMatch ? tfMatch[1] : 'UNKNOWN';
    const readableTf = parseTF(eventTf);

    let currentDirection: 'BUY' | 'SELL' | null = null;
    if (upperText.includes('BUY') || upperText.includes('BULLISH') || upperText.includes('COMPRA')) {
        currentDirection = 'BUY';
    } else if (upperText.includes('SELL') || upperText.includes('BEARISH') || upperText.includes('VENTA')) {
        currentDirection = 'SELL';
    }

    const docRef = db.collection('radar_states').doc(ticker);
    const todayStr = new Date().toISOString().split('T')[0];
    const nowMs = Date.now();

    let triggerSniperTouch = false;
    let triggerChochA = false;
    let triggerChochB = false;
    let alertData: any = null;

    try {
        await db.runTransaction(async (transaction) => {
            // Reset flags en caso de reintento de la transacción
            triggerSniperTouch = false;
            triggerChochA = false;
            triggerChochB = false;
            alertData = null;

            const docSnap = await transaction.get(docRef);
            let state: RadarState = docSnap.exists ? (docSnap.data() as RadarState) : emptyState();

            if (!state.scoreBuy) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
            if (!state.scoreSell) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };
            if (!state.marketBias) state.marketBias = emptyState().marketBias;
            if (!state.lastApproachAlert) state.lastApproachAlert = 0;
            if (!state.lastSniperAlert) state.lastSniperAlert = 0;

            if (nowMs - state.scoreBuy.lastUpdate > SETUP_MEMORY_WINDOW_MS) {
                state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
            }
            if (nowMs - state.scoreSell.lastUpdate > SETUP_MEMORY_WINDOW_MS) {
                state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };
            }

            // =========================================================================
            // MOTOR 1: SINCRONIZACIÓN DE MAPA
            // =========================================================================
            if (prefix === 'SYNC_ZONES') {
                if (!alertText.includes('Payload:')) return;
                const sourceTf = eventTf;
                const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();

                const trendMatch = alertText.match(/Trend:\s*(BUY|SELL)/i);
                if (trendMatch) {
                    state.marketBias[sourceTf] = trendMatch[1].toUpperCase() as 'BUY' | 'SELL';
                }

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
                    console.error(`[RADAR] Error parseando JSON:`, e);
                }
            }
            // // // =========================================================================
            // MOTOR 2: PING PRECIO (Y RADAR DE COLISIÓN INTERNA)
            // =========================================================================
            else if (prefix === 'PING_PRICE') {
                const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
                if (!priceMatch) return;
                
                const currentPrice = parseFloat(priceMatch[1]);
                state.lastPrice = currentPrice;

                // 📡 Jarvis revisa si el PING cayó adentro de una caja macro (1H o 4H)
                for (const zone of state.zones) {
                    if (currentPrice <= zone.top && currentPrice >= zone.btm) {
                        const activeScore = zone.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
                        
                        // Normalizamos la temporalidad (ej. "240" -> "4H")
                        const zTf = parseTF(zone.tf || '');
                        let eventName = '';
                        let pts = 2;

                        // Unificamos el vocabulario con el MOTOR 3
                        if (zone.medal?.includes('Breaker')) {
                            eventName = `Breaker_${zTf}`;
                            pts = 3;
                        } else if (zone.medal?.includes('Platino') || zone.medal?.includes('POC')) {
                            eventName = `POC_Volume_${zTf}`;
                            pts = 4;
                        } else if (zone.medal?.includes('God') || zone.medal?.includes('Oro')) {
                            eventName = `OB_Gold_${zTf}`;
                            pts = 3;
                        } else {
                            eventName = `OB_${zTf}`;
                            pts = 2;
                        }
                        
                        if (!activeScore.events.includes(eventName)) {
                            activeScore.events.push(eventName);
                            activeScore.points += pts;
                            activeScore.lastUpdate = nowMs;
                            
                            console.log(`[RADAR] 📡 Colisión Interna: Precio ${currentPrice} entró en ${zone.medal} de ${zTf}. ➕ +${pts} pts para ${zone.dir}. Total: ${activeScore.points}`);
                        }
                    }
                }
            }
            // =========================================================================
            // MOTOR 3: CEREBRO ANALÍTICO (CONFLUENCIAS Y GATILLOS)
            // =========================================================================
            else if (currentDirection) {
                const activeScore = currentDirection === 'BUY' ? state.scoreBuy : state.scoreSell;
                const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
                let addedPoints = 0;

                if (prefix === 'EVENTO_CHOCH') {
                    state.marketBias[eventTf] = currentDirection;
                }

                // --- SISTEMA DE INVALIDACIÓN (KILLSWITCH) ---
                if (prefix === 'ZONE_BROKEN') {
                    const eventOB = `OB_${readableTf}`;
                    const eventPOC = `POC_Volume_${readableTf}`;
                    const eventBreaker = `Breaker_${readableTf}`;
                    let pointsToDeduct = 0;
                    const initialLength = activeScore.events.length;

                    activeScore.events = activeScore.events.filter(e => {
                        if (e === eventPOC) { pointsToDeduct += 4; return false; }
                        if (e === eventBreaker) { pointsToDeduct += 3; return false; }
                        if (e === eventOB) { pointsToDeduct += 3; return false; }
                        return true;
                    });

                    if (activeScore.events.length < initialLength) {
                        activeScore.points = Math.max(0, activeScore.points - pointsToDeduct);
                    }
                    return;
                }

                if (prefix === 'DIV_BROKEN') {
                    const eventDIV = `DIV_${readableTf}`;
                    const initialLength = activeScore.events.length;
                    activeScore.events = activeScore.events.filter(e => e !== eventDIV);
                    if (activeScore.events.length < initialLength) {
                        activeScore.points = Math.max(0, activeScore.points - 2);
                    }
                    return;
                }

                if (prefix === 'SWEEP_BROKEN') {
                    const eventSweep = `Sweep_${readableTf}`;
                    const eventAbsorcion = `Sweep_${readableTf}_Absorcion`;
                    let pointsToDeduct = 0;
                    const initialLength = activeScore.events.length;

                    activeScore.events = activeScore.events.filter(e => {
                        if (e === eventAbsorcion) { pointsToDeduct += 5; return false; }
                        if (e === eventSweep) { pointsToDeduct += 3; return false; }
                        return true;
                    });

                    if (activeScore.events.length < initialLength) {
                        activeScore.points = Math.max(0, activeScore.points - pointsToDeduct);
                    }
                    return;
                }

                // --- RECOLECCIÓN DE PUNTOS ---
                if (prefix === 'TOUCH_ZONE') {
                    if (upperText.includes('BREAKER')) {
                        const eventName = `Breaker_${readableTf}`;
                        if (!activeScore.events.includes(eventName)) {
                            addedPoints = 3;
                            activeScore.events.push(eventName);
                        }
                    } else {
                        if (upperText.includes('PLATINO') || upperText.includes('POC')) {
                            const pocEventName = `POC_Volume_${readableTf}`;
                            if (!activeScore.events.includes(pocEventName)) {
                                addedPoints = 4;
                                activeScore.events.push(pocEventName);
                            }
                        } else if (upperText.includes('GOD_ZONE') || upperText.includes('ORO')) {
                            const obGoldName = `OB_Gold_${readableTf}`;
                            if (!activeScore.events.includes(obGoldName)) {
                                addedPoints = 3;
                                activeScore.events.push(obGoldName);
                            }
                        } else {
                            const obEventName = `OB_${readableTf}`;
                            if (!activeScore.events.includes(obEventName)) {
                                addedPoints = 2;
                                activeScore.events.push(obEventName);
                            }
                        }
                    }
                }
                else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
                    const eventNormal = `Sweep_${readableTf}`;
                    const eventAbsorb = `Sweep_${readableTf}_Absorcion`;

                    if (!activeScore.events.includes(eventNormal) && !activeScore.events.includes(eventAbsorb)) {
                        if (upperText.includes('ABSORCION')) {
                            addedPoints = 5;
                            activeScore.events.push(eventAbsorb);
                        } else {
                            addedPoints = 3;
                            activeScore.events.push(eventNormal);
                        }
                    }
                }
                else if (prefix === 'EVENTO_SMC_DIV') {
                    const eventName = `DIV_${readableTf}`;
                    if (!activeScore.events.includes(eventName)) {
                        addedPoints = 2;
                        activeScore.events.push(eventName);
                    }
                }

                if (addedPoints > 0) {
                    activeScore.points += addedPoints;
                    activeScore.lastUpdate = nowMs;
                    console.log(`[RADAR] ➕ +${addedPoints} pts para ${ticker} ${currentDirection}. Total: ${activeScore.points}`);

                    // 💥 GATILLO 1: SNIPER (Entrada Agresiva)
                    const isMacroAligned = (state.marketBias['240'] === currentDirection) || (state.marketBias['60'] === currentDirection);
                    if (activeScore.points >= 5 && isMacroAligned && (prefix === 'TOUCH_ZONE' || prefix.includes('SWEEP'))) {
                        if (nowMs - (state.lastSniperAlert ?? 0) > SNIPER_COOLDOWN_MS) {
                            triggerSniperTouch = true;
                            alertData = {
                                dirText: currentDirection === 'BUY' ? 'COMPRA' : 'VENTA',
                                events: [...activeScore.events],
                                points: activeScore.points
                            };
                            state.lastSniperAlert = nowMs;
                        }
                    }
                }

                // --- CAPA 4: EL GATILLO FINAL (CHOCH VALIDADO EN 3M) ---
                if (prefix === 'EVENTO_CHOCH' && eventTf === '3') { // Actualizado a 3M
                    if (nowMs - (state.lastSniperAlert ?? 0) < SNIPER_COOLDOWN_MS) {
                        return; // Cooldown anti-spam
                    }

                    // 🛡️ CANDADO DE TITANIO: No operamos CHoCH sin mitigar zonas o barrer liquidez antes
                    const hasHTFBacking = activeScore.events.some(e => e.includes('OB_') || e.includes('Sweep_') || e.includes('POC_') || e.includes('Breaker_'));
                    if (!hasHTFBacking) {
                        console.log(`[RADAR] 🗑️ CHoCH BASURA IGNORADO | ${ticker}: Ocurrió sin mitigar zonas ni barrer liquidez previa.`);
                        return;
                    }

                    const dirText = currentDirection === 'BUY' ? 'COMPRA' : 'VENTA';
                    
                    // 🌟 SCORING ASIMÉTRICO Y EVALUACIÓN MACRO
                    const isMacroAligned = (state.marketBias['240'] === currentDirection) || (state.marketBias['60'] === currentDirection);
                    const is4HAgainst = state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL';
                    const is1HAgainst = state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL';

                    // Si está a favor del sesgo macro, le regalamos 5 puntos base para que gatille más fácil.
                    let baseBiasPoints = isMacroAligned ? 5 : 0;

                    let vwapBonus = 0;
                    if (upperText.includes('VWAP: UNDER') && currentDirection === 'BUY') {
                        vwapBonus = 2;
                        activeScore.events.push('VWAP_Discount');
                    } else if (upperText.includes('VWAP: OVER') && currentDirection === 'SELL') {
                        vwapBonus = 2;
                        activeScore.events.push('VWAP_Premium');
                    }

                    // Cálculo final de puntos sumando el bonus asimétrico
                    let totalPoints = activeScore.points + baseBiasPoints + 2 + vwapBonus; // +2 por el CHoCH

                    if (is4HAgainst && is1HAgainst) {
                        totalPoints -= 3;
                        console.log(`[RADAR] ⚠️ Trade contra-tendencia Macro en ${ticker}. Restando 3 pts.`);
                    }

                    const getIcon = (tf: string) => state.marketBias[tf] === 'BUY' ? '🟢' : state.marketBias[tf] === 'SELL' ? '🔴' : '⚪';

                    let confluenceReport = `🗺️ *Contexto Macro:*\n`;
                    confluenceReport += `${getIcon("240")} 4H: ${state.marketBias["240"] || 'NEUTRAL'}\n`;
                    confluenceReport += `${getIcon("60")} 1H: ${state.marketBias["60"] || 'NEUTRAL'}\n`;
                    confluenceReport += `${getIcon("15")} 15M: ${state.marketBias["15"] || 'NEUTRAL'}\n`;
                    confluenceReport += `${getIcon("3")} Gatillo 3M: ${currentDirection}\n\n`; // Actualizado a 3M
                    confluenceReport += `⚖️ *Bono de Alineación Macro:* +${baseBiasPoints} Pts\n`; // Nuevo informe visual del bono

                    // Criterios de Aprobación
                    if (totalPoints >= 8) {
                        triggerChochA = true;
                        alertData = {
                            dirText,
                            confluenceReport,
                            totalPoints,
                            events: [...activeScore.events],
                            marketBias: { ...state.marketBias },
                            currentDirection,
                            isMacroAligned
                        };

                        state.lastSniperAlert = nowMs;
                        activeScore.points = 0; activeScore.events = [];
                        oppositeScore.points = 0; oppositeScore.events = [];
                    }
                    else if (totalPoints >= 5) {
                        triggerChochB = true;
                        alertData = {
                            dirText,
                            confluenceReport,
                            totalPoints,
                            events: [...activeScore.events],
                            marketBias: { ...state.marketBias },
                            currentDirection,
                            isMacroAligned,
                            is4HAgainst,
                            is1HAgainst
                        };

                        state.lastSniperAlert = nowMs;
                        activeScore.points = 0; activeScore.events = [];
                        oppositeScore.points = 0; oppositeScore.events = [];
                    }
                    else {
                        console.log(`[RADAR] ❌ CHoCH ignorado (${totalPoints} Pts). No alcanza puntaje mínimo.`);
                    }
                }
            }
            transaction.set(docRef, state);
        });

        // =========================================================================
        // EJECUCIÓN DE ALERTAS FUERA DE LA TRANSACCIÓN (Evita duplicados por reintentos)
        // =========================================================================
        if (triggerSniperTouch && alertData) {
            const fingerprint = `SNIPER_${ticker}_${alertData.dirText}_${alertData.points}_${alertData.events.join(',')}`;
            if (!isDuplicate(fingerprint)) {
                const kronosResult = await evaluateWithKronos(ticker, alertData.dirText === 'COMPRA' ? 'BUY' : 'SELL').catch((e: any) => ({
                    trend: null as null, isConfirmed: false, details: `🔴 Kronos Error: ${e.message}`
                }));

                let kronosAnnotation = kronosResult.trend === null
                    ? `\n\n🤖 *Kronos AI:* ${kronosResult.details}`
                    : `\n\n🤖 *Kronos AI:* ${kronosResult.isConfirmed ? '🟢 CONFIRMADO' : '🟠 DIVERGENCIA'}\n${kronosResult.details}`;

                let msg = `🎯 *GATILLO SNIPER (AL TOQUE) | ${ticker} | ${alertData.dirText}*\n\n`;
                msg += `🧱 *Eventos Recientes:* ${alertData.events.join(', ')}\n`;
                msg += `⚖️ *Puntaje Acumulado:* ${alertData.points} Pts\n\n`;
                msg += `🧠 *Jarvis:* El precio alcanzó una zona macro (3M). Operar con riesgo estándar (1%).`;
                msg += kronosAnnotation;


                await sendTelegramAlert(msg);
            }
        }

        if (triggerChochA && alertData) {
            const fingerprint = `CHOCHA_${ticker}_${alertData.dirText}_${alertData.totalPoints}_${alertData.events.join(',')}`;
            if (!isDuplicate(fingerprint)) {
                const { analyzeInvestmentSwarm } = await import('../services/investment.js');
                const [kronosResult, investmentResult, mixtureResult] = await Promise.all([
                    evaluateWithKronos(ticker, alertData.currentDirection as 'BUY' | 'SELL').catch((e: any) => ({
                        trend: null as null, isConfirmed: false, details: `🔴 Kronos Error: ${e.message}`
                    })),
                    analyzeInvestmentSwarm(ticker, alertData.currentDirection as 'BUY' | 'SELL').catch((e: any) => `🔴 Error en Swarm: ${e.message}`),
                    evaluateWithMixture(
                        `Activo: ${ticker}\nPuntos: ${alertData.totalPoints}\nConfluencias: ${alertData.events.join(', ')} + CHoCH_3M\n${alertData.confluenceReport}`,
                        alertData.currentDirection as 'BUY' | 'SELL'
                    ).catch(() => null)
                ]);

                let kronosAnnotation = kronosResult.trend === null ? `\n\n🤖 *Kronos AI:* ${kronosResult.details}` : `\n\n🤖 *Kronos AI:* ${kronosResult.isConfirmed ? '🟢 CONFIRMADO' : '🟠 DIVERGENCIA'}\n${kronosResult.details}`;

                let msg = `🔥 *ALERTA FRANCOTIRADOR A+ | ${ticker} | ${alertData.dirText}*\n\n`;
                msg += alertData.confluenceReport;
                msg += `🎯 *Puntaje Total:* ${alertData.totalPoints} Puntos\n`;
                msg += `🧱 *Confluencias:* ${alertData.events.join(', ')} + CHoCH_3M\n\n`;
                
                // GESTIÓN DE RIESGO DINÁMICA
                let avisoRiesgo = alertData.isMacroAligned 
                    ? "Operar con riesgo estándar (1%)." 
                    : "Setup en contra-tendencia. Riesgo reducido (0.5%).";
                
                msg += `🧠 *Jarvis:* Gatillo en 3M activado. ${avisoRiesgo}`;
                msg += kronosAnnotation;

                if (investmentResult) msg += `\n\n👔 *Comité de Inversión (Swarm):*\n${investmentResult}`;
                if (mixtureResult) msg += `\n\n${mixtureResult.summary}`;

                await sendTelegramAlert(msg);

                logTrade({
                    ticker, direction: alertData.currentDirection as 'BUY' | 'SELL',
                    grade: 'A+', points: alertData.totalPoints, events: [...alertData.events, 'CHoCH_3M'],
                    macroContext: alertData.marketBias,
                    kronosVerdict: kronosResult.isConfirmed ? 'CONFIRMED' : 'DIVERGENCE',
                    investmentSentiment: 'SWARM_ANALYZED',
                    mixtureConsensus: mixtureResult?.consensus,
                    timestamp: Date.now()
                }).catch(() => { });
            }
        }

        if (triggerChochB && alertData) {
            const fingerprint = `CHOCHB_${ticker}_${alertData.dirText}_${alertData.totalPoints}_${alertData.events.join(',')}`;
            if (!isDuplicate(fingerprint)) {
                const { analyzeInvestment, formatInvestmentAlert } = await import('../services/investment.js');
                const [kronosResult, investmentResult] = await Promise.all([
                    evaluateWithKronos(ticker, alertData.currentDirection as 'BUY' | 'SELL').catch((e: any) => ({
                        trend: null as null, isConfirmed: false, details: `🔴 Kronos Error: ${e.message}`
                    })),
                    analyzeInvestment(ticker, alertData.currentDirection as 'BUY' | 'SELL').catch(() => null)
                ]);

                let kronosAnnotation = kronosResult.trend === null ? `\n\n🤖 *Kronos AI:* ${kronosResult.details}` : `\n\n🤖 *Kronos AI:* ${kronosResult.isConfirmed ? '🟢 CONFIRMADO' : '🟠 DIVERGENCIA'}\n${kronosResult.details}`;

                let msg = `⚠️ *SETUP CALIDAD MEDIA (B) | ${ticker} | ${alertData.dirText}*\n\n`;
                msg += alertData.confluenceReport;
                msg += `🎯 *Puntaje Total:* ${alertData.totalPoints} Puntos\n`;
                msg += `🧱 *Confluencias:* ${alertData.events.join(', ')} + CHoCH_3M\n\n`;

                // GESTIÓN DE RIESGO DINÁMICA AVANZADA
                let avisoRiesgo = alertData.isMacroAligned 
                    ? `Faltó barrido de liquidez o zonas pesadas. Reducir riesgo (0.5%).` 
                    : (alertData.is4HAgainst && alertData.is1HAgainst) 
                        ? `Trade contra-tendencia agresivo. Riesgo mínimo (0.25%).` 
                        : `Contexto macro neutral. Operar con precaución (0.5%).`;

                msg += `🧠 *Jarvis:* Gatillo activado. ${avisoRiesgo}`;
                msg += kronosAnnotation;

                if (investmentResult) msg += `\n\n${formatInvestmentAlert(investmentResult)}`;

                await sendTelegramAlert(msg);

                logTrade({
                    ticker, direction: alertData.currentDirection as 'BUY' | 'SELL',
                    grade: 'B', points: alertData.totalPoints, events: [...alertData.events, 'CHoCH_3M'],
                    macroContext: alertData.marketBias,
                    kronosVerdict: kronosResult.isConfirmed ? 'CONFIRMED' : 'DIVERGENCE',
                    investmentSentiment: investmentResult?.sentiment,
                    timestamp: Date.now()
                }).catch(() => { });
            }
        }

    } catch (e: any) {
        console.error(`[RADAR] Error crítico en Firebase:`, e.message);
    }
}
