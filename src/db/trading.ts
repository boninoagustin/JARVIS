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
    // Capa 1: Memoria de Contexto Macro
    marketBias: { [tf: string]: 'BUY' | 'SELL' | 'NEUTRAL' };
    lastApproachAlert?: number; // <--- NUEVO: Evita spam de pre-alertas
}

const emptyState = (): RadarState => ({
    lastSyncDate: null,
    zones: [],
    activeLocks: [],
    lastPrice: null,
    scoreBuy: { points: 0, lastUpdate: 0, events: [] },
    scoreSell: { points: 0, lastUpdate: 0, events: [] },
    marketBias: { "240": 'NEUTRAL', "60": 'NEUTRAL', "15": 'NEUTRAL', "5": 'NEUTRAL' },
    lastApproachAlert: 0
});

const SETUP_MEMORY_WINDOW_MS = 14400000; // 4 Horas

// Helper para traducir Timeframes a texto legible
const parseTF = (tf: string) => {
    if (tf === '240') return '4H';
    if (tf === '60') return '1H';
    if (tf === '15') return '15M';
    if (tf === '5') return '5M';
    return `${tf}M`;
};

async function sendTelegramAlert(message: string) {
    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try {
            await bot.api.sendMessage(userId, message, { parse_mode: 'Markdown' });
        } catch (err: any) {
            console.error(`[TRADING] Error enviando alerta a ${userId}:`, err.message);
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

    // Extractor de Temporalidad
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

    try {
        await db.runTransaction(async (transaction) => {
            const docSnap = await transaction.get(docRef);
            let state: RadarState = docSnap.exists ? (docSnap.data() as RadarState) : emptyState();

            // Compatibilidad
            if (!state.scoreBuy) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
            if (!state.scoreSell) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };
            if (!state.marketBias) state.marketBias = emptyState().marketBias;
            if (!state.lastApproachAlert) state.lastApproachAlert = 0;

            // Limpieza de memoria temporal (4hs)
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
                const sourceTf = eventTf;
                const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();

                // --- NUEVO: Extraer la tendencia macro al sincronizar el mapa ---
                const trendMatch = alertText.match(/Trend:\s*(BUY|SELL)/i);
                if (trendMatch) {
                    state.marketBias[sourceTf] = trendMatch[1].toUpperCase() as 'BUY' | 'SELL';
                    console.log(`[RADAR] 🧭 Sesgo Macro actualizado por SYNC en ${sourceTf}M: ${state.marketBias[sourceTf]}`);
                }
                // ----------------------------------------------------------------

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
            // 📍 MOTOR 2: RASTREO POR GPS (SISTEMA DE ALERTA TEMPRANA)
            // =========================================================================
            else if (prefix === 'PING_PRICE') {
                const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
                if (!priceMatch) return;

                const currentPrice = parseFloat(priceMatch[1]);
                state.lastPrice = currentPrice;

                // --- RADAR DE APROXIMACIÓN ---
                // Solo evaluamos si pasaron al menos 2 horas desde la última pre-alerta de este activo
                if (nowMs - state.lastApproachAlert > 7200000) { // 7200000 ms = 2 horas
                    for (const z of state.zones) {
                        // Filtro: Solo nos importan las murallas macro (1H/4H) de alta probabilidad
                        if ((z.tf === '60' || z.tf === '240') && (z.medal === 'Oro' || z.medal === 'Platino' || z.medal === 'Diamante')) {

                            // Calculamos si el precio está "arriba" buscando un soporte, o "abajo" buscando resistencia
                            const targetPrice = z.dir === 'BUY' ? z.top : z.btm;

                            // Distancia porcentual universal
                            const distancePct = Math.abs((currentPrice - targetPrice) / currentPrice) * 100;

                            // Si está a menos de 0.15% de tocar la zona y asegurando que aún no entró a la caja
                            const noCruzoAun = z.dir === 'BUY' ? currentPrice > z.top : currentPrice < z.btm;

                            if (distancePct > 0 && distancePct <= 0.15 && noCruzoAun) {
                                let msg = `👀 *RADAR DE APROXIMACIÓN | ${ticker}*\n\n`;
                                msg += `El precio actual (\`${currentPrice}\`) está a menos de 0.15% de colisionar con una zona institucional pesada.\n\n`;
                                msg += `🧱 *Muro Detectado:* ${z.medal} OB (${z.tf}M)\n`;
                                msg += `🧭 *Dirección Esperada:* ${z.dir === 'BUY' ? '🟢 COMPRAS (Soporte)' : '🔴 VENTAS (Resistencia)'}\n\n`;
                                msg += `👉 *Jarvis:* Abrí TradingView. El choque es inminente. Prepará la Killzone y esperá manipulación en 5M.`;

                                await sendTelegramAlert(msg);
                                state.lastApproachAlert = nowMs; // Apagamos el radar por 2 horas para este activo
                                break; // Mandamos una sola alerta y cortamos el loop
                            }
                        }
                    }
                }
            }
            // =========================================================================
            // 🎯 MOTOR 3: CEREBRO ANALÍTICO (CAPAS Y CONFLUENCIAS)
            // =========================================================================
            else if (currentDirection) {
                const activeScore = currentDirection === 'BUY' ? state.scoreBuy : state.scoreSell;
                const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
                let addedPoints = 0;

                // --- CAPA 1: ACTUALIZACIÓN DE TENDENCIA MACRO ---
                if (prefix === 'EVENTO_CHOCH') {
                    state.marketBias[eventTf] = currentDirection; // Jarvis anota para dónde va esta temporalidad
                }
                // --- 💥 NUEVO: SISTEMA DE INVALIDACIÓN (KILLSWITCH INTELIGENTE) ---
                if (prefix === 'ZONE_BROKEN') {
                    const eventOB = `OB_${readableTf}`;
                    const eventPOC = `POC_Volume_${readableTf}`;
                    const eventBreaker = `Breaker_${readableTf}`;

                    let pointsToDeduct = 0;
                    const initialLength = activeScore.events.length;

                    // Filtramos los eventos para eliminar SOLO los de la temporalidad rota
                    activeScore.events = activeScore.events.filter(e => {
                        if (e === eventPOC) { pointsToDeduct += 4; return false; }
                        if (e === eventBreaker) { pointsToDeduct += 3; return false; }
                        if (e === eventOB) { pointsToDeduct += 3; return false; } // Descontamos 3 pts por seguridad
                        return true;
                    });

                    // Si efectivamente borramos algo, actualizamos el puntaje
                    if (activeScore.events.length < initialLength) {
                        activeScore.points = Math.max(0, activeScore.points - pointsToDeduct);
                        console.log(`[RADAR] 🩹 ZONA ROTA en ${readableTf}. Restando ${pointsToDeduct} pts en ${currentDirection}. Puntos restantes: ${activeScore.points}`);
                    }
                    return; // Salimos para no sumar puntos nuevos en esta lectura
                }
                // --- CAPA 2 Y 3: RECOLECCIÓN DE PUNTOS (Apilamiento por TF) ---
                if (prefix === 'TOUCH_ZONE') {
                    if (upperText.includes('BREAKER')) {
                        const eventName = `Breaker_${readableTf}`;
                        if (!activeScore.events.includes(eventName)) {
                            addedPoints = 3;
                            activeScore.events.push(eventName);
                        }
                    } else {
                        const eventName = `OB_${readableTf}`;
                        if (!activeScore.events.includes(eventName)) {
                            if (upperText.includes('PLATINO') || upperText.includes('POC')) {
                                addedPoints = 4;
                                activeScore.events.push(`POC_Volume_${readableTf}`);
                            }
                            else if (upperText.includes('GOD_ZONE') || upperText.includes('ORO')) {
                                addedPoints = 3;
                                activeScore.events.push(eventName);
                            }
                            else {
                                addedPoints = 2;
                                activeScore.events.push(eventName);
                            }
                        }
                    }
                }
                else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP' || prefix === 'PO3_LIVE') {
                    const eventName = `Sweep_${readableTf}`;
                    if (!activeScore.events.includes(eventName)) {
                        // --- INTEGRACIÓN: Validación de Absorción Institucional ---
                        if (upperText.includes('ABSORCION')) {
                            addedPoints = 5; // Puntos nucleares
                            activeScore.events.push(`${eventName}_Absorcion`);
                        } else {
                            addedPoints = 3; // Sweep normal
                            activeScore.events.push(eventName);
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
                    console.log(`[RADAR] ➕ +${addedPoints} pts para ${ticker} ${currentDirection} (${activeScore.events[activeScore.events.length - 1]}). Total: ${activeScore.points}`);
                }

                // --- CAPA 4: EL GATILLO FINAL (SOLO EN 5M) ---
                if (prefix === 'EVENTO_CHOCH' && eventTf === '5') {
                    const dirText = currentDirection === 'BUY' ? 'COMPRA' : 'VENTA';

                    // --- INTEGRACIÓN: Bonus del VWAP ---
                    let vwapBonus = 0;
                    if (upperText.includes('VWAP: UNDER') && currentDirection === 'BUY') {
                        vwapBonus = 2;
                        activeScore.events.push('VWAP_Discount');
                    } else if (upperText.includes('VWAP: OVER') && currentDirection === 'SELL') {
                        vwapBonus = 2;
                        activeScore.events.push('VWAP_Premium');
                    }

                    const totalPoints = activeScore.points + 2 + vwapBonus; // Sumamos CHoCH + VWAP

                    // Análisis del mapa estructural (Capa 1)
                    const getIcon = (tf: string) => state.marketBias[tf] === 'BUY' ? '🟢' : state.marketBias[tf] === 'SELL' ? '🔴' : '⚪';
                    const isMacroAligned = (state.marketBias['240'] === currentDirection) || (state.marketBias['60'] === currentDirection);

                    let confluenceReport = `🗺️ *Contexto Macro:*\n`;
                    confluenceReport += `${getIcon("240")} 4H: ${state.marketBias["240"] || 'NEUTRAL'}\n`;
                    confluenceReport += `${getIcon("60")} 1H: ${state.marketBias["60"] || 'NEUTRAL'}\n`;
                    confluenceReport += `${getIcon("15")} 15M: ${state.marketBias["15"] || 'NEUTRAL'}\n`;
                    confluenceReport += `${getIcon("5")} Gatillo 5M: ${currentDirection}\n\n`;

                    // 💥 ESCENARIO A: SETUP NUCLEAR (8+ Pts)
                    if (totalPoints >= 8) {
                        // Run Kronos + Investment Swarm + Mixture in parallel
                        const { analyzeInvestmentSwarm } = await import('../services/investment.js');
                        const [kronosResult, investmentResult, mixtureResult] = await Promise.all([
                            evaluateWithKronos(ticker, currentDirection as 'BUY' | 'SELL').catch((e: any) => ({
                                trend: null as null, isConfirmed: false, details: `🔴 Kronos Error: ${e.message}`
                            })),
                            analyzeInvestmentSwarm(ticker, currentDirection as 'BUY' | 'SELL').catch((e: any) => `🔴 Error en Swarm: ${e.message}`),
                            evaluateWithMixture(
                                `Activo: ${ticker}\nPuntos: ${totalPoints}\nConfluencias: ${activeScore.events.join(', ')} + CHoCH_5M\n${confluenceReport}`,
                                currentDirection as 'BUY' | 'SELL'
                            ).catch(() => null)
                        ]);

                        // Build Kronos annotation
                        let kronosAnnotation = '';
                        if (kronosResult.trend === null) {
                            kronosAnnotation = `\n\n🤖 *Kronos AI:* ${kronosResult.details}`;
                        } else {
                            const icon = kronosResult.isConfirmed ? '🟢 CONFIRMADO' : '🟠 DIVERGENCIA';
                            kronosAnnotation = `\n\n🤖 *Kronos AI:* ${icon}\n${kronosResult.details}`;
                        }

                        let msg = `🔥 *ALERTA FRANCOTIRADOR A+ | ${ticker} | ${dirText}*\n\n`;
                        msg += confluenceReport;
                        msg += `🎯 *Puntaje Total:* ${totalPoints} Puntos\n`;
                        msg += `🧱 *Confluencias Apiladas:* ${activeScore.events.join(', ')} + CHoCH_5M\n\n`;
                        msg += `🧠 *Análisis de Jarvis:* Gatillo en 5M activado con alineación brutal. Tocamos zonas pesadas y barrieron liquidez. Probabilidad altísima. Operar con riesgo estándar.`;
                        msg += kronosAnnotation;

                        // Investment Swarm annotation
                        if (investmentResult) {
                            msg += `\n\n👔 *Comité de Inversión (Swarm):*\n${investmentResult}`;
                        }

                        // Mixture of Agents annotation
                        if (mixtureResult) {
                            msg += `\n\n${mixtureResult.summary}`;
                        }

                        await sendTelegramAlert(msg);

                        // Journal: log trade
                        logTrade({
                            ticker, direction: currentDirection as 'BUY' | 'SELL',
                            grade: 'A+', points: totalPoints, events: [...activeScore.events, 'CHoCH_5M'],
                            macroContext: state.marketBias,
                            kronosVerdict: kronosResult.isConfirmed ? 'CONFIRMED' : 'DIVERGENCE',
                            investmentSentiment: 'SWARM_ANALYZED', // Simplified as Swarm returns a string report now
                            mixtureConsensus: mixtureResult?.consensus,
                            timestamp: Date.now()
                        }).then(id => console.log(`[JOURNAL] A+ trade logged: #${id}`)).catch(() => { });

                        // Reseteo post-disparo
                        activeScore.points = 0; activeScore.events = [];
                        oppositeScore.points = 0; oppositeScore.events = [];
                    }
                    else if (totalPoints >= 5) {
                        // Run Kronos + Investment in parallel (no Mixture for B setups)
                        const { analyzeInvestment, formatInvestmentAlert } = await import('../services/investment.js');
                        const [kronosResult, investmentResult] = await Promise.all([
                            evaluateWithKronos(ticker, currentDirection as 'BUY' | 'SELL').catch((e: any) => ({
                                trend: null as null, isConfirmed: false, details: `🔴 Kronos Error: ${e.message}`
                            })),
                            analyzeInvestment(ticker, currentDirection as 'BUY' | 'SELL').catch(() => null)
                        ]);

                        // Build Kronos annotation
                        let kronosAnnotation = '';
                        if (kronosResult.trend === null) {
                            kronosAnnotation = `\n\n🤖 *Kronos AI:* ${kronosResult.details}`;
                        } else {
                            const icon = kronosResult.isConfirmed ? '🟢 CONFIRMADO' : '🟠 DIVERGENCIA';
                            kronosAnnotation = `\n\n🤖 *Kronos AI:* ${icon}\n${kronosResult.details}`;
                        }

                        let msg = `⚠️ *SETUP CALIDAD MEDIA (B) | ${ticker} | ${dirText}*\n\n`;
                        msg += confluenceReport;
                        msg += `🎯 *Puntaje Total:* ${totalPoints} Puntos\n`;
                        msg += `🧱 *Confluencias:* ${activeScore.events.join(', ')} + CHoCH_5M\n\n`;

                        // LÓGICA DE AVISO DE RIESGO
                        const isMacroAgainst = (state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL') ||
                            (state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL');

                        let avisoRiesgo = '';
                        if (isMacroAligned) {
                            avisoRiesgo = `Faltó barrido de liquidez o zonas más pesadas para ser un trade A+. Reducir riesgo.`;
                        } else if (isMacroAgainst) {
                            avisoRiesgo = `Las tendencias de 1H/4H están en contra. Este es un trade de retroceso agresivo. Reducir el riesgo a la mitad (0.5%).`;
                        } else {
                            avisoRiesgo = `El contexto macro está neutral (esperando confirmación estructural). Operar con precaución (0.5%).`;
                        }

                        msg += `🧠 *Análisis de Jarvis:* Gatillo activado. ${avisoRiesgo}`;
                        msg += kronosAnnotation;

                        // Investment Agent annotation
                        if (investmentResult) {
                            msg += `\n\n${formatInvestmentAlert(investmentResult)}`;
                        }

                        await sendTelegramAlert(msg);

                        // Journal: log trade
                        logTrade({
                            ticker, direction: currentDirection as 'BUY' | 'SELL',
                            grade: 'B', points: totalPoints, events: [...activeScore.events, 'CHoCH_5M'],
                            macroContext: state.marketBias,
                            kronosVerdict: kronosResult.isConfirmed ? 'CONFIRMED' : 'DIVERGENCE',
                            investmentSentiment: investmentResult?.sentiment,
                            timestamp: Date.now()
                        }).then(id => console.log(`[JOURNAL] B trade logged: #${id}`)).catch(() => { });

                        // Reseteo post-disparo
                        activeScore.points = 0; activeScore.events = [];
                        oppositeScore.points = 0; oppositeScore.events = [];
                    }
                    // 🔴 ESCENARIO C: RUIDO / BASURA (< 5 Pts)
                    else {
                        console.log(`[RADAR] ❌ CHoCH en 5M ignorado (${totalPoints} Pts). No hay zonas HTF ni manipulación. Puro ruido.`);
                    }
                }
            }
            transaction.set(docRef, state);
        });
    } catch (e: any) {
        console.error(`[RADAR] Error crítico en Firebase:`, e.message);
    }
}