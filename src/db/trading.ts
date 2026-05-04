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
    score?: number; // 🆕 Agregamos el Score Matemático de Pine Script
    tp?: number;    // 🆕 Take Profit sugerido por el indicador
    sl?: number;    // 🆕 Stop Loss sugerido por el indicador
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

const SETUP_MEMORY_WINDOW_MS = 14400000; // 4 Horas

let globalKillswitches: Record<string, boolean> = {};
let dynamicBotConfig = {
    sniperCooldownMs: 180000,     // 🆕 3 minutos (alineado con velas de 3M)
    minPointsForBuy: 7,           // 🆕 Bajado de 8 a 7 (más sensible tras fix de dirección)
    minPointsForSell: 7,          // 🆕 Bajado de 8 a 7
    baseRiskPercentage: 1.0
};

if (db) {
    try {
        console.log('[CONFIG] Iniciando listeners de configuración...');
        db.collection('app_settings').doc('global').onSnapshot((snap) => {
            if (snap.exists) globalKillswitches = snap.data()?.killswitches || {};
        });
        db.collection('app_settings').doc('bot_config').onSnapshot((snap) => {
            console.log(`[CONFIG] bot_config snapshot recibido. exists=${snap.exists}`);
            if (snap.exists) {
                dynamicBotConfig = { ...dynamicBotConfig, ...snap.data() };
                console.log(`[CONFIG] ⚙️ Bot config actualizado: minBUY=${dynamicBotConfig.minPointsForBuy} | minSELL=${dynamicBotConfig.minPointsForSell} | cooldown=${dynamicBotConfig.sniperCooldownMs / 60000}min | riesgo=${dynamicBotConfig.baseRiskPercentage}%`);
            } else {
                console.log('[CONFIG] ⚠️ bot_config NO existe en Firebase. Usando defaults.');
            }
        }, (err) => {
            console.error('[CONFIG] ❌ Error en onSnapshot bot_config:', err);
        });
    } catch (e) {
        console.error('[TRADING] Error iniciando listeners de configuración', e);
    }
}

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

    if (globalKillswitches[ticker]) {
        console.log(`[TRADING] 🚫 Alerta ignorada para ${ticker}: KILLSWITCH ACTIVADO.`);
        return;
    }

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

    let triggerChochA = false;
    let triggerChochB = false;
    let alertData: any = null;

    try {
        await db.runTransaction(async (transaction) => {
            // Reset flags en caso de reintento de la transacción
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
            // =========================================================================
            // MOTOR 2: PING PRECIO (Y RADAR DE COLISIÓN INTERNA EN NODE)
            // =========================================================================
            else if (prefix === 'PING_PRICE') {
                const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
                if (!priceMatch) return;

                const currentPrice = parseFloat(priceMatch[1]);
                const previousPrice = state.lastPrice; // 🆕 Guardamos precio anterior para detectar dirección
                state.lastPrice = currentPrice;
                const buffer = currentPrice * 0.0002; // micro-buffer por spread

                // 📡 FASE 1: Recorremos zonas y detectamos toques individuales
                const touchedThisPing: { zone: RadarZone; eventName: string; pts: number }[] = [];

                for (const zone of state.zones) {
                    if (currentPrice <= (zone.top + buffer) && currentPrice >= (zone.btm - buffer)) {
                        // 🆕 DETECCIÓN DE DIRECCIÓN DE ENTRADA (SMC Purista)
                        const enteredFromAbove = previousPrice !== null && previousPrice > zone.top;
                        const enteredFromBelow = previousPrice !== null && previousPrice < zone.btm;
                        
                        const isValidDirection = (zone.dir === 'BUY' && enteredFromAbove) ||
                                                 (zone.dir === 'SELL' && enteredFromBelow);
                        
                        const isFirstPing = previousPrice === null;
                        
                        if (!isValidDirection && !isFirstPing) {
                            console.log(`[RADAR] 🗑️ Toque ignorado en ${zone.medal} ${zone.dir}: dirección incorrecta (prev=${previousPrice}, curr=${currentPrice}, zone=[${zone.btm}-${zone.top}])`);
                            continue;
                        }
                        
                        const activeScore = zone.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
                        const zTf = parseTF(zone.tf || '');
                        
                        let basePts = zone.score !== undefined ? zone.score : 2; 

                        let eventName = zone.medal?.includes('God') ? `💎_GOD_ZONE_${zTf}` :
                                        zone.medal?.includes('CHoCH') ? `🎯_Silver_Bullet_${zTf}` :
                                        zone.medal?.includes('Breaker') ? `♻️_Breaker_${zTf}` :
                                        `OB_${zone.medal}_${zTf}`;

                        let tfMultiplier = 1;
                        if (zTf === '4H') tfMultiplier = 2;
                        else if (zTf === '1H') tfMultiplier = 1.5;

                        const pts = Math.floor(basePts * tfMultiplier);

                        if (!activeScore.events.includes(eventName)) {
                            activeScore.events.push(eventName);
                            activeScore.points += pts;
                            activeScore.lastUpdate = nowMs;

                            const dirTag = enteredFromAbove ? '↓desde arriba' : enteredFromBelow ? '↑desde abajo' : '•primer ping';
                            console.log(`[RADAR] 📡 Colisión Interna: Ping ${currentPrice} ${dirTag} → ${zone.medal} ${zTf}. ➕ +${pts} pts para ${zone.dir}. Total: ${activeScore.points}`);
                            
                            // Guardamos para análisis de confluencia post-loop
                            touchedThisPing.push({ zone, eventName, pts });
                        }
                    }
                }

                // 🆕 FASE 2: DETECCIÓN DE CONFLUENCIA MULTI-TF (4H + 1H + 15M + 3M)
                // Buscamos zonas de DISTINTAS temporalidades tocadas en la misma dirección
                for (const dir of ['BUY', 'SELL'] as const) {
                    const dirZones = touchedThisPing.filter(t => t.zone.dir === dir);
                    if (dirZones.length < 2) continue;

                    const activeScore = dir === 'BUY' ? state.scoreBuy : state.scoreSell;
                    
                    // Agrupar por timeframe y detectar solapamiento de rangos entre zonas
                    const uniqueTFs = new Set(dirZones.map(t => t.zone.tf));
                    const tfCount = uniqueTFs.size;
                    
                    if (tfCount >= 2) {
                        // Verificar que las zonas efectivamente se solapan en precio (no solo que el precio las tocó)
                        const zonesOverlap = dirZones.some((a, i) => 
                            dirZones.some((b, j) => 
                                i !== j && a.zone.tf !== b.zone.tf &&
                                !(a.zone.top < b.zone.btm || a.zone.btm > b.zone.top) // rangos se intersectan
                            )
                        );
                        
                        if (!zonesOverlap) {
                            console.log(`[RADAR] 🔍 ${tfCount} TFs tocadas para ${dir} pero sin solapamiento de rangos. Sin bonus.`);
                            continue;
                        }
                        
                        let confluenceBonus = 0;
                        let confluenceTag = '';
                        
                        if (tfCount === 4) {
                            confluenceBonus = 10;
                            confluenceTag = '🔥 CONFLUENCIA 4-TF';
                        } else if (tfCount === 3) {
                            confluenceBonus = 7;
                            confluenceTag = '🎯 CONFLUENCIA 3-TF';
                        } else {
                            confluenceBonus = 4;
                            confluenceTag = '⚡ CONFLUENCIA 2-TF';
                        }
                        
                        const tfList = [...uniqueTFs].map(t => parseTF(t || '')).sort((a, b) => {
                            const order: Record<string, number> = { '3M': 0, '15M': 1, '1H': 2, '4H': 3 };
                            return (order[b] || 0) - (order[a] || 0);
                        }).join('+');
                        
                        const eventName = `🧲_CONFLUENCIA_${tfCount}TF_${tfList}`;
                        if (!activeScore.events.includes(eventName)) {
                            activeScore.events.push(eventName);
                            activeScore.points += confluenceBonus;
                            activeScore.lastUpdate = nowMs;
                            
                            const medals = dirZones.map(t => `${t.zone.medal}(${parseTF(t.zone.tf || '')})`).join(', ');
                            console.log(`[RADAR] ${confluenceTag} ${tfList} detectada para ${ticker} ${dir}. Zonas: ${medals}. ➕ +${confluenceBonus} pts. Total: ${activeScore.points}`);
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
                    // 🆕 Extraemos los puntos enviados directamente por Pine Script 5.0
                    const ptMatch = alertText.match(/Puntos:\s*(\d+)/i);
                    const dynamicPts = ptMatch ? parseInt(ptMatch[1], 10) : 0;

                    if (upperText.includes('BREAKER')) {
                        const eventName = `Breaker_${readableTf}`;
                        if (!activeScore.events.includes(eventName)) {
                            addedPoints = dynamicPts > 0 ? dynamicPts : 3;
                            activeScore.events.push(eventName);
                        }
                    } else {
                        if (upperText.includes('PLATINO') || upperText.includes('POC')) {
                            const pocEventName = `POC_Volume_${readableTf}`;
                            if (!activeScore.events.includes(pocEventName)) {
                                addedPoints = dynamicPts > 0 ? dynamicPts : 4;
                                activeScore.events.push(pocEventName);
                            }
                        } else if (upperText.includes('GOD_ZONE') || upperText.includes('ORO')) {
                            const obGoldName = `OB_Gold_${readableTf}`;
                            if (!activeScore.events.includes(obGoldName)) {
                                addedPoints = dynamicPts > 0 ? dynamicPts : 3;
                                activeScore.events.push(obGoldName);
                            }
                        } else {
                            const obEventName = `OB_${readableTf}`;
                            if (!activeScore.events.includes(obEventName)) {
                                addedPoints = dynamicPts > 0 ? dynamicPts : 2;
                                activeScore.events.push(obEventName);
                            }
                        }
                    }
                }
                // --- RECOLECCIÓN DE EVENTOS RÁPIDOS (Sweeps y Divergencias) ---
                else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
                    const eventNormal = `Sweep_${readableTf}`;
                    const eventAbsorb = `🩸_V-Shape_Absorb_${readableTf}`;

                    if (!activeScore.events.includes(eventNormal) && !activeScore.events.includes(eventAbsorb)) {
                        if (upperText.includes('ABSORCION')) {
                            addedPoints = 6;
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
                }

                // --- CAPA 4: EL GATILLO FINAL (CHOCH VALIDADO EN 3M) ---
                if (prefix === 'EVENTO_CHOCH' && eventTf === '3') { 
                    if (nowMs - (state.lastSniperAlert ?? 0) < dynamicBotConfig.sniperCooldownMs) {
                        return; // Cooldown anti-spam
                    }

                    // 🛡️ CANDADO DE TITANIO: Verificamos que Jarvis haya registrado toques previos en la zona o sweeps
                    const hasHTFBacking = activeScore.events.some(e => e.includes('OB_') || e.includes('GOD_') || e.includes('Sweep_') || e.includes('DIV_') || e.includes('Breaker_'));
                    
                    // 🆕 FALLBACK INTELIGENTE: Si no hay zonas en memoria (recién arrancó o perdió sync),
                    // en vez de ignorar, aplicamos una penalización y exigimos más puntos.
                    let orphanPenalty = 0;
                    if (!hasHTFBacking) {
                        // Verificamos si hay zonas en el mapa (puede que no se hayan tocado aún)
                        const hasZonesInMap = state.zones.length > 0;
                        if (hasZonesInMap) {
                            // Hay zonas mapeadas pero no tocadas → penalización leve
                            orphanPenalty = 3;
                            console.log(`[RADAR] ⚠️ CHoCH sin toques previos en ${ticker}. Penalización leve (-${orphanPenalty} pts). Zonas mapeadas: ${state.zones.length}`);
                        } else {
                            // No hay zonas en absoluto → penalización fuerte, pero dejamos pasar
                            orphanPenalty = 5;
                            console.log(`[RADAR] ⚠️ CHoCH HUÉRFANO en ${ticker}: sin zonas en memoria. Penalización fuerte (-${orphanPenalty} pts).`);
                        }
                    }

                    const dirText = currentDirection === 'BUY' ? 'COMPRA' : 'VENTA';
                    const isMacroAligned = (state.marketBias['240'] === currentDirection) || (state.marketBias['60'] === currentDirection);
                    const is4HAgainst = state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL';
                    const is1HAgainst = state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL';

                    let baseBiasPoints = isMacroAligned ? 5 : 0;
                    
                    let vwapBonus = 0;
                    if (upperText.includes('VWAP: UNDER') && currentDirection === 'BUY') {
                        vwapBonus = 2;
                        activeScore.events.push('VWAP_Discount');
                    } else if (upperText.includes('VWAP: OVER') && currentDirection === 'SELL') {
                        vwapBonus = 2;
                        activeScore.events.push('VWAP_Premium');
                    }

                    let totalPoints = activeScore.points + baseBiasPoints + 2 + vwapBonus; // +2 por el CHoCH

                    // 🆕 Aplicar penalización por CHoCH huérfano (sin toques previos en zonas)
                    if (orphanPenalty > 0) {
                        totalPoints -= orphanPenalty;
                    }

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
                    if (orphanPenalty > 0) {
                        confluenceReport += `⚠️ *Penalización CHoCH Huérfano:* -${orphanPenalty} Pts (sin toques previos en zonas)\n`;
                    }

                    // Criterios de Aprobación
                    const minPtsRequired = currentDirection === 'BUY' ? dynamicBotConfig.minPointsForBuy : dynamicBotConfig.minPointsForSell;

                    // Buscar la mejor zona tocada para sugerir TP/SL (dentro de la transacción donde state existe)
                    const bestZone = state.zones
                        .filter(z => z.dir === currentDirection)
                        .sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

                    if (totalPoints >= minPtsRequired) {
                        triggerChochA = true;
                        alertData = {
                            dirText,
                            confluenceReport,
                            totalPoints,
                            events: [...activeScore.events],
                            marketBias: { ...state.marketBias },
                            currentDirection,
                            isMacroAligned,
                            bestZone
                        };

                        state.lastSniperAlert = nowMs;
                        activeScore.points = 0; activeScore.events = [];
                        oppositeScore.points = 0; oppositeScore.events = [];
                    }
                    else if (totalPoints >= Math.max(minPtsRequired - 3, 5)) {
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
                            is1HAgainst,
                            bestZone
                        };

                        state.lastSniperAlert = nowMs;
                        activeScore.points = 0; activeScore.events = [];
                        oppositeScore.points = 0; oppositeScore.events = [];
                    }
                    else {
                        console.log(`[RADAR] ❌ CHoCH ignorado (${totalPoints} Pts). No alcanza puntaje mínimo de ${minPtsRequired}.`);
                    }
                }
            }
            transaction.set(docRef, state);
        });

        // =========================================================================
        // EJECUCIÓN DE ALERTAS FUERA DE LA TRANSACCIÓN (Evita duplicados por reintentos)
        // =========================================================================
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
                    ? `Operar con riesgo estándar (${dynamicBotConfig.baseRiskPercentage}%).`
                    : `Setup en contra-tendencia. Riesgo reducido (${dynamicBotConfig.baseRiskPercentage / 2}%).`;

                msg += `🧠 *Jarvis:* Gatillo en 3M activado. ${avisoRiesgo}`;

                // Usar la zona precalculada dentro de la transacción (state no existe aquí)
                if (alertData.bestZone?.tp || alertData.bestZone?.sl) {
                    msg += `\n\n📐 *Niveles Sugeridos (de la zona ${alertData.bestZone.medal || ''}):*`;
                    if (alertData.bestZone.tp) msg += `\n🎯 TP: ${alertData.bestZone.tp}`;
                    if (alertData.bestZone.sl) msg += `\n🛑 SL: ${alertData.bestZone.sl}`;
                }

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

                // Usar la zona precalculada dentro de la transacción (state no existe aquí)
                if (alertData.bestZone?.tp || alertData.bestZone?.sl) {
                    msg += `\n\n📐 *Niveles Sugeridos (de la zona ${alertData.bestZone.medal || ''}):*`;
                    if (alertData.bestZone.tp) msg += `\n🎯 TP: ${alertData.bestZone.tp}`;
                    if (alertData.bestZone.sl) msg += `\n🛑 SL: ${alertData.bestZone.sl}`;
                }

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
