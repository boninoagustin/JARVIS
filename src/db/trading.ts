import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';
import { evaluateWithKronos } from '../services/kronos.js';
import { evaluateWithMixture } from '../llm/mixture.js';
import { logTrade, recordResult } from '../services/journal.js';

// --- INTERFACES DEL RADAR JSON ---
interface RadarZone {
    // v5.1 (long) field names
    tf?: string;
    dir?: 'BUY' | 'SELL';
    top?: number;
    btm?: number;
    lvl?: string;
    medal?: string;
    score?: number;
    tp?: number;
    sl?: number;
    mid?: number;
    atr?: number;
    // v5.1.1 (short) field aliases → merged into above at parse time
    t?: string;      // tf
    d?: 'BUY' | 'SELL';  // dir
    p?: number;      // top (price)
    b?: number;      // btm (bottom)
    lv?: string;     // lvl
    md?: string;     // medal
    sc?: number;     // score
    mi?: number;     // mid
    a?: number;      // atr
    createdAt?: number;
}

/**
 * Normalize a RadarZone (from old long-format or new short-format) to the canonical fields.
 */
function normalizeZone(raw: any): RadarZone {
    // If short-format fields present, map them to long names
    if (raw.t !== undefined && raw.tf === undefined) raw.tf = raw.t;
    if (raw.d !== undefined && raw.dir === undefined) raw.dir = raw.d;
    if (raw.p !== undefined && raw.top === undefined) raw.top = raw.p;
    if (raw.b !== undefined && raw.btm === undefined) raw.btm = raw.b;
    if (raw.lv !== undefined && raw.lvl === undefined) raw.lvl = raw.lv;
    if (raw.md !== undefined && raw.medal === undefined) raw.medal = raw.md;
    if (raw.sc !== undefined && raw.score === undefined) raw.score = raw.sc;
    if (raw.mi !== undefined && raw.mid === undefined) raw.mid = raw.mi;
    if (raw.a !== undefined && raw.atr === undefined) raw.atr = raw.a;
    return raw as RadarZone;
}

// SISTEMA DE MEMORIA TEMPORAL PARA APILAMIENTO
interface ScoreState {
    points: number;
    lastUpdate: number;
    events: string[];
}

interface ImpulseLeg {
    dir: 'BUY' | 'SELL';
    origin: number;
    extreme: number;
    tp2?: number | null;       // 🚀 Liquidez Externa (DOL macro del ciclo anterior)
    oteScored?: boolean;       // 🔒 Candado para no sumar puntos infinitos
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
    nextZones?: RadarZone[];     // 🆕 v5.1: Agenda de próximas zonas por distancia
    lastHeartbeat?: number;       // 🆕 v5.1: timestamp del último HEARTBEAT
    activeImpulseBuy?: ImpulseLeg | null;  // 🆕 Canal de Compras
    activeImpulseSell?: ImpulseLeg | null; // 🆕 Canal de Ventas
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
    lastSniperAlert: 0,
    activeImpulseBuy: null,
    activeImpulseSell: null
});

const SETUP_MEMORY_WINDOW_MS = 14400000; // 4 Horas

// 🆕 v5.2: Trades activos para auto-detección de TP/SL
interface ActiveTrade {
    tradeId: string;
    ticker: string;
    direction: 'BUY' | 'SELL';
    entryPrice: number;
    tpPrice: number;
    slPrice: number;
    timestamp: number;
}
const activeTrades = new Map<string, ActiveTrade>();

let consecutiveLosses = 0; // 🆕 v5.2: Protección anti-racha

let globalKillswitches: Record<string, boolean> = {};
let dynamicBotConfig = {
    sniperCooldownMs: 120000,     // 🔥 2 minutos (más rápido para scalping real)
    minPointsForBuy: 5,           // Bajado a 5: más permisivo, la dirección validada + orphan penalty filtran
    minPointsForSell: 5,          // Bajado a 5
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

// 🆕 v5.1: Throttle para SYNC_ZONES (evita saturar Firebase)
const lastSyncTime = new Map<string, number>();
const SYNC_THROTTLE_MS: Record<string, number> = {
    '3': 0,       // 3M no sincroniza (solo PING)
    '15': 120000, // 15M: máximo 1 sync cada 2 min
    '60': 300000, // 1H: máximo 1 sync cada 5 min
    '240': 600000 // 4H: máximo 1 sync cada 10 min
};

// 🆕 v5.1: Watchdog - tracking de última alerta por ticker
const tickerLastSeen = new Map<string, number>();
const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos sin alerta → warning

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

    const nowMs = Date.now();

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

    // 🆕 v5.1: Actualizar timestamp de última actividad (watchdog)
    tickerLastSeen.set(ticker, nowMs);

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
                
                // 🆕 v5.1: Throttle - no sincronizar más de lo necesario
                const syncKey = `${ticker}_${sourceTf}`;
                const lastSync = lastSyncTime.get(syncKey) || 0;
                const throttleMs = SYNC_THROTTLE_MS[sourceTf] || 60000;
                if (nowMs - lastSync < throttleMs) {
                    console.log(`[RADAR] ⏭️ SYNC_ZONES throttled para ${ticker} ${readableTf} (último: hace ${Math.round((nowMs - lastSync)/1000)}s)`);
                    return;
                }
                lastSyncTime.set(syncKey, nowMs);
                
                const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();

                const trendMatch = alertText.match(/Trend:\s*(BUY|SELL)/i);
                if (trendMatch) {
                    state.marketBias[sourceTf] = trendMatch[1].toUpperCase() as 'BUY' | 'SELL';
                }

                try {
                    const rawZones = JSON.parse(payloadStr) as any[];
                    const parsedZones: RadarZone[] = rawZones.map(normalizeZone);
                    parsedZones.forEach(z => { z.tf = sourceTf; z.createdAt = nowMs; });

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

                // =========================================================================
                // 📏 CÁLCULO DINÁMICO DE OTE (DOBLE MOTOR)
                // =========================================================================
                const processImpulse = (leg: ImpulseLeg | null | undefined, price: number) => {
                    if (!leg) return null;
                    let impulseInvalidated = false;

                    // 1. Estirar el Fibo si el precio sigue rompiendo a favor
                    if (leg.dir === 'BUY' && price > leg.extreme) leg.extreme = price;
                    else if (leg.dir === 'SELL' && price < leg.extreme) leg.extreme = price;

                    // 2. Verificar Invalidación (Stop Hunt del Origen)
                    if (leg.dir === 'BUY' && price < leg.origin) {
                        impulseInvalidated = true;
                        console.log(`[FIBO] 🗑️ Impulso BUY invalidado. Rompió el Origen (${leg.origin}).`);
                    } else if (leg.dir === 'SELL' && price > leg.origin) {
                        impulseInvalidated = true;
                        console.log(`[FIBO] 🗑️ Impulso SELL invalidado. Rompió el Origen (${leg.origin}).`);
                    }

                    // 3. Procesar zona OTE si el impulso sigue vivo
                    if (!impulseInvalidated) {
                        const range = Math.abs(leg.extreme - leg.origin);
                        const oteTop = leg.dir === 'BUY' ? leg.extreme - (range * 0.62) : leg.extreme + (range * 0.79);
                        const oteBtm = leg.dir === 'BUY' ? leg.extreme - (range * 0.79) : leg.extreme + (range * 0.62);

                        // 4. Verifica si el precio entra a la zona dorada Y AÚN NO COBRÓ LOS PUNTOS
                        if (price <= Math.max(oteTop, oteBtm) && price >= Math.min(oteTop, oteBtm) && !leg.oteScored) {
                            const activeScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
                            const eventName = `🎯_OTE_Retracement_3M`;
                            
                            if (!activeScore.events.includes(eventName)) {
                                activeScore.events.push(eventName);
                                activeScore.points += 4;
                                activeScore.lastUpdate = nowMs;
                                leg.oteScored = true;
                                
                                const stopLoss = leg.origin.toFixed(5);
                                const tp1 = leg.extreme.toFixed(5);
                                const tp2 = leg.tp2 ? leg.tp2.toFixed(5) : 'Buscando nuevo DOL macro...';

                                console.log(`
🎯 ENTRADA SNIPER OTE CONFIRMADA
🟢 Dirección: ${leg.dir}
🛡️ Stop Loss (Origin): ${stopLoss}
💰 TP 1 (Liq. Interna): ${tp1}
🚀 TP 2 (Liq. Externa): ${tp2}
                                `);
                            }
                        }
                    }
                    // Si se invalidó, retorna null para limpiar esa dirección de la RAM
                    return impulseInvalidated ? null : leg;
                };

                // Ejecutamos ambos canales en cada Ping
                state.activeImpulseBuy = processImpulse(state.activeImpulseBuy, currentPrice);
                state.activeImpulseSell = processImpulse(state.activeImpulseSell, currentPrice);

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
                    
                    // 🆕 Jarvis inicializa el impulso al recibir el CHoCH (Doble Canal)
                    const originMatch = alertText.match(/ORIGIN:\s*([0-9.]+)/i);
                    if (originMatch && state.lastPrice) {
                        const newOrigin = parseFloat(originMatch[1]);
                        const isBuy = currentDirection === 'BUY';
                        const activeLeg = isBuy ? state.activeImpulseBuy : state.activeImpulseSell;
                        
                        let shouldCreateNew = true;
                        
                        // 🛡️ Escudo Anti-Amnesia: no pisar impulso si el precio está dentro de su rango
                        if (activeLeg) {
                            const isInsideRange = state.lastPrice > Math.min(activeLeg.origin, activeLeg.extreme) && 
                                                  state.lastPrice < Math.max(activeLeg.origin, activeLeg.extreme);
                            if (isInsideRange) shouldCreateNew = false;
                        }
                        
                        if (shouldCreateNew) {
                            const newLeg = {
                                dir: currentDirection as 'BUY' | 'SELL',
                                origin: newOrigin,
                                extreme: state.lastPrice,
                                tp2: null,
                                oteScored: false
                            };
                            
                            if (isBuy) state.activeImpulseBuy = newLeg;
                            else state.activeImpulseSell = newLeg;
                            
                            console.log(`[FIBO] 📏 Nuevo Impulso ${currentDirection} iniciado. Origen: ${newOrigin}`);
                        }
                    }
                    
                    addedPoints = 3; // Cambio de estructura = más peso
                }
                // 🆕 v5.1: BOS es continuación de tendencia, menor peso
                else if (prefix === 'EVENTO_BOS') {
                    state.marketBias[eventTf] = currentDirection;
                    addedPoints = 1; // Continuación = menos peso
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
                    const eventTLSweep = `📉_TL_Sweep_${readableTf}`;
                    let pointsToDeduct = 0;
                    const initialLength = activeScore.events.length;

                    activeScore.events = activeScore.events.filter(e => {
                        if (e === eventAbsorcion) { pointsToDeduct += 5; return false; }
                        if (e === eventSweep) { pointsToDeduct += 3; return false; }
                        if (e === eventTLSweep) { pointsToDeduct += 2; return false; }
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
                // 🆕 v5.2: Trendline Liquidity Sweep (Trampas Retail)
                else if (prefix === 'EVENTO_SWEEP_TL') {
                    const tlEvent = `📉_TL_Sweep_${readableTf}`;
                    if (!activeScore.events.includes(tlEvent)) {
                        addedPoints = 2;
                        activeScore.events.push(tlEvent);
                    }
                    // Invalidar TL del lado opuesto (si la tenía)
                    const oppTlEvent = `📉_TL_Sweep_${readableTf}`;
                    if (oppositeScore.events.includes(oppTlEvent)) {
                        oppositeScore.events = oppositeScore.events.filter(e => e !== oppTlEvent);
                        oppositeScore.points = Math.max(0, oppositeScore.points - 2);
                        console.log(`[RADAR] 🔄 TL Sweep invalida lado opuesto para ${ticker}. -2 pts.`);
                    }
                }
                // 🆕 v5.1: ZONE_TOUCHED viene del indicador con medal/score/level precisos
                else if (prefix === 'ZONE_TOUCHED') {
                    const medalMatch = alertText.match(/Medal:\s*([\w🚀♻️💎]+)/i);
                    const scoreMatch = alertText.match(/Score:\s*([0-9]+)/i);
                    const zoneMedal = medalMatch?.[1] || 'OB';
                    const zoneScore = parseInt(scoreMatch?.[1] || '2');
                    
                    const eventName = `🎯_ZoneTouched_${zoneMedal}_${readableTf}`;
                    if (!activeScore.events.includes(eventName)) {
                        // Score base según calidad de la zona tocada
                        const basePts = zoneScore >= 9 ? 5 : zoneScore >= 7 ? 4 : zoneScore >= 5 ? 3 : 2;
                        addedPoints = basePts;
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
                    const hasHTFBacking = activeScore.events.some(e => e.includes('OB_') || e.includes('GOD_') || e.includes('Sweep_') || e.includes('DIV_') || e.includes('Breaker_') || e.includes('ZoneTouched_') || e.includes('TL_Sweep_'));
                    
                    // 🆕 v5.1: FALLBACK INTELIGENTE - Si no hay zonas en memoria, 
                    // en vez de ignorar, aplicamos una penalización fuerte pero dejamos pasar
                    let orphanPenalty = 0;
                    if (!hasHTFBacking) {
                        const hasZonesInMap = state.zones.length > 0;
                        if (hasZonesInMap) {
                            orphanPenalty = 2;  // 🟢 Más leve: si hay zonas pero no se tocaron, solo -2
                            console.log(`[RADAR] ⚠️ CHoCH sin toques previos en ${ticker}. Penalización leve (-${orphanPenalty} pts). Zonas mapeadas: ${state.zones.length}`);
                        } else {
                            orphanPenalty = 3;  // 🟢 Más leve: -3 en vez de -5. Sigue duro pero no mata setups válidos
                            console.log(`[RADAR] ⚠️ CHoCH HUÉRFANO en ${ticker}: sin zonas en memoria. Penalización (-${orphanPenalty} pts).`);
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
                    confluenceReport += `⚖️ *Bono de Alineación Macro:* +${baseBiasPoints} Pts\n`;
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
                // 🆕 v5.1: HEARTBEAT - actualizar timestamp de último latido
                else if (prefix === 'HEARTBEAT') {
                    state.lastHeartbeat = nowMs;
                    console.log(`[RADAR] 💓 Heartbeat: ${ticker} ${readableTf} | Zones: ${state.zones.length} | Bias: ${state.marketBias[eventTf] || 'NEUTRAL'}`);
                }
            }

            // 🆕 v5.1: TTL CLEANUP - limpiar zonas viejas
            const MAX_ZONE_AGE_MS: Record<string, number> = {
                '3': 30 * 60 * 1000,     // 3M: 30 min
                '15': 2 * 60 * 60 * 1000, // 15M: 2 horas
                '60': 8 * 60 * 60 * 1000, // 1H: 8 horas
                '240': 24 * 60 * 60 * 1000 // 4H: 24 horas
            };
            const beforeCount = state.zones.length;
            state.zones = state.zones.filter(z => {
                if (!z.createdAt) return true; // Zonas legacy sin timestamp se mantienen
                const maxAge = MAX_ZONE_AGE_MS[z.tf || '60'] || 4 * 60 * 60 * 1000;
                return (nowMs - z.createdAt) < maxAge;
            });
            if (state.zones.length < beforeCount) {
                console.log(`[RADAR] 🧹 TTL: ${beforeCount - state.zones.length} zonas expiradas de ${ticker}`);
            }

            // 🆕 v5.1: AGENDA DE PRÓXIMAS ZONAS (ordenadas por cercanía al precio)
            if (state.lastPrice && state.zones.length > 0) {
                const sortedZones = [...state.zones]
                    .filter(z => {
                        if (z.dir === 'BUY') return z.top < state.lastPrice!;
                        return z.btm > state.lastPrice!;
                    })
                    .sort((a, b) => {
                        const distA = Math.abs(state.lastPrice! - (a.dir === 'BUY' ? a.top : a.btm));
                        const distB = Math.abs(state.lastPrice! - (b.dir === 'BUY' ? b.top : b.btm));
                        return distA - distB;
                    })
                    .slice(0, 3);
                state.nextZones = sortedZones;
            }

            transaction.set(docRef, state);
        });

        // =========================================================================
        // EJECUCIÓN DE ALERTAS FUERA DE LA TRANSACCIÓN (Evita duplicados por reintentos)
        // =========================================================================
        if (triggerChochA && alertData) {
            const fingerprint = `CHOCHA_${ticker}_${alertData.dirText}_${alertData.totalPoints}_${alertData.events.join(',')}`;
            if (!isDuplicate(fingerprint)) {
                const [kronosResult, mixtureResult] = await Promise.all([
                    evaluateWithKronos(ticker, alertData.currentDirection as 'BUY' | 'SELL').catch((e: any) => ({
                        trend: null as null, isConfirmed: false, details: `🔴 Kronos Error: ${e.message}`
                    })),
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
                if (alertData.bestZone) {
                    msg += `\n\n📐 *Niveles Sugeridos:*`;
                    msg += `\n🎯 Zona: ${alertData.bestZone.medal || 'OB'} ${alertData.bestZone.tf ? parseTF(alertData.bestZone.tf) : ''}`;
                    if (alertData.bestZone.top && alertData.bestZone.btm) {
                        msg += `\n📊 Rango: ${alertData.bestZone.btm} - ${alertData.bestZone.top}`;
                    }
                    if (alertData.bestZone.sl) msg += `\n🛑 SL sugerido: ${alertData.bestZone.sl}`;
                    if (alertData.bestZone.mid) msg += `\n📍 Mid: ${alertData.bestZone.mid}`;
                }

                msg += kronosAnnotation;

                if (mixtureResult) msg += `\n\n${mixtureResult.summary}`;

                await sendTelegramAlert(msg);

                logTrade({
                    ticker, direction: alertData.currentDirection as 'BUY' | 'SELL',
                    grade: 'A+', points: alertData.totalPoints, events: [...alertData.events, 'CHoCH_3M'],
                    macroContext: alertData.marketBias,
                    kronosVerdict: kronosResult.isConfirmed ? 'CONFIRMED' : 'DIVERGENCE',
                    mixtureConsensus: mixtureResult?.consensus,
                    timestamp: Date.now()
                }).catch(() => { });
            }
        }

        if (triggerChochB && alertData) {
            const fingerprint = `CHOCHB_${ticker}_${alertData.dirText}_${alertData.totalPoints}_${alertData.events.join(',')}`;
            if (!isDuplicate(fingerprint)) {
                const kronosResult = await evaluateWithKronos(ticker, alertData.currentDirection as 'BUY' | 'SELL').catch((e: any) => ({
                    trend: null as null, isConfirmed: false, details: `🔴 Kronos Error: ${e.message}`
                }));

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

                // Usar la zona precalculada dentro de la transacción
                if (alertData.bestZone) {
                    msg += `\n\n📐 *Niveles Sugeridos:*`;
                    msg += `\n🎯 Zona: ${alertData.bestZone.medal || 'OB'} ${alertData.bestZone.tf ? parseTF(alertData.bestZone.tf) : ''}`;
                    if (alertData.bestZone.top && alertData.bestZone.btm) {
                        msg += `\n📊 Rango: ${alertData.bestZone.btm} - ${alertData.bestZone.top}`;
                    }
                    if (alertData.bestZone.sl) msg += `\n🛑 SL sugerido: ${alertData.bestZone.sl}`;
                    if (alertData.bestZone.mid) msg += `\n📍 Mid: ${alertData.bestZone.mid}`;
                }

                msg += kronosAnnotation;

                await sendTelegramAlert(msg);

                logTrade({
                    ticker, direction: alertData.currentDirection as 'BUY' | 'SELL',
                    grade: 'B', points: alertData.totalPoints, events: [...alertData.events, 'CHoCH_3M'],
                    macroContext: alertData.marketBias,
                    kronosVerdict: kronosResult.isConfirmed ? 'CONFIRMED' : 'DIVERGENCE',
                    timestamp: Date.now()
                }).catch(() => { });
            }
        }

    } catch (e: any) {
        console.error(`[RADAR] Error crítico en Firebase:`, e.message);
    }
}

// =========================================================================
// 🆕 v5.1: WATCHDOG - Monitorea desconexiones de TradingView
// Cada 2 minutos verifica que todos los tickers activos reciban señales
// =========================================================================
const WATCHDOG_INTERVAL_MS = 2 * 60 * 1000;
let watchdogStarted = false;

export function startWatchdog() {
    if (watchdogStarted) return;
    watchdogStarted = true;
    
    setInterval(() => {
        const now = Date.now();
        for (const [ticker, lastSeen] of tickerLastSeen) {
            const elapsed = now - lastSeen;
            if (elapsed > HEARTBEAT_TIMEOUT_MS) {
                console.warn(`[WATCHDOG] ⚠️ ${ticker}: SIN ALERTAS hace ${Math.round(elapsed / 60000)} minutos. ¿TradingView desconectado?`);
                // ⚠️ Solo logging en consola. Telegram desactivado a pedido del usuario.
            }
        }
    }, WATCHDOG_INTERVAL_MS);
    
    console.log('[WATCHDOG] ✅ Watchdog iniciado. Verificando cada 2 minutos.');
}
