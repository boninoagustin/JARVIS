import type { RadarZone, RadarState } from './Types.js';

export const SETUP_MEMORY_WINDOW_MS = 172800000; // 48 Horas (Swing Core)

export const TF_WEIGHT: Record<string, number> = {
    '3': 0.5,    // 3M: medio punto (mucho ruido)
    '5': 0.75,   // 5M: tres cuartos
    '15': 1.0,   // 15M: base (gatillo principal)
    '60': 1.5,   // 1H: 50% más
    '240': 2.0,  // 4H: doble
    'D': 3.0,    // Daily: triple
};

export const emptyState = (): RadarState => ({
    lastSyncDate: null,
    zones: [],
    activeLocks: [],
    lastPrice: null,
    scoreBuy: { points: 0, lastUpdate: 0, events: [] },
    scoreSell: { points: 0, lastUpdate: 0, events: [] },
    marketBias: { "D": 'NEUTRAL', "240": 'NEUTRAL', "60": 'NEUTRAL', "15": 'NEUTRAL', "5": 'NEUTRAL' },
    lastApproachAlert: 0,
    lastSniperAlert: 0,
    activeImpulseBuy: null,
    activeImpulseSell: null,
    activeMacroImpulseBuy: null,
    activeMacroImpulseSell: null,
    lastGatillo: undefined,
    version: 0,
    lastModified: 0
});

export function normalizeZone(raw: any): RadarZone {
    if (raw.t !== undefined && raw.tf === undefined) raw.tf = raw.t;
    if (raw.d !== undefined && raw.dir === undefined) raw.dir = raw.d;
    if (raw.p !== undefined && raw.top === undefined) raw.top = raw.p;
    if (raw.b !== undefined && raw.btm === undefined) raw.btm = raw.b;
    if (raw.lv !== undefined && raw.lvl === undefined) raw.lvl = raw.lv;
    if (raw.md !== undefined && raw.medal === undefined) raw.medal = raw.md;
    if (raw.sc !== undefined && raw.score === undefined) raw.score = raw.sc;
    if (raw.mi !== undefined && raw.mid === undefined) raw.mid = raw.mi;
    if (raw.a !== undefined && raw.atr === undefined) raw.atr = raw.a;
    if (raw.mg !== undefined) raw.mg = raw.mg;
    if (raw.kz !== undefined) raw.kz = raw.kz;
    return raw as RadarZone;
}

export const getDecimals = (ticker: string) => (ticker.includes('BTC') || ticker.includes('ETH') || ticker.includes('US30') || ticker.includes('NAS') || ticker.includes('XAU') || ticker.includes('GOLD')) ? 2 : (ticker.includes('JPY') ? 3 : 5);

export function calculateDynamicSlBuffer(ticker: string, originPrice: number, bufferConfig: number): number {
    const t = ticker.toUpperCase();
    if (t.includes('JPY')) return bufferConfig * 0.1;
    const forexPairs = ['EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];
    if (forexPairs.some(fiat => t.includes(fiat)) && !t.includes('BTC') && !t.includes('ETH')) return bufferConfig * 0.001;
    const indices = ['US30', 'NAS', 'NDX', 'SPX', 'US500', 'DJI'];
    if (indices.some(idx => t.includes(idx))) return bufferConfig * 100;
    if (t.includes('XAU') || t.includes('GOLD')) return bufferConfig * 10;
    return originPrice * (bufferConfig / 100);
}

import type { ImpulseLeg, ActiveTrade } from './Types.js';

export interface AlphaContext {
    config: any;
    currentSession: string;
    sessionConfig: any;
}

export interface AlphaInsight {
    updatedLeg: ImpulseLeg | null;
    triggerOte?: boolean;
    oteData?: any;
    newTrade?: ActiveTrade;
}

export function evaluateImpulseCore(
    leg: ImpulseLeg | null | undefined, 
    currentPrice: number, 
    highPrice: number, 
    lowPrice: number, 
    ticker: string, 
    state: RadarState, 
    nowMs: number, 
    sessionThresholds: { buy: number; sell: number } | null,
    ctx: AlphaContext
): AlphaInsight {
    if (!leg) return { updatedLeg: null };
    let impulseInvalidated = false;

    const { config, sessionConfig } = ctx;

    // 🔧 FIX 1: Stale leg cleaner — legs de más de 8 horas se invalidan automáticamente (Intradia)
    const MAX_LEG_AGE_MS = 8 * 60 * 60 * 1000;
    if (leg.createdAt && (nowMs - leg.createdAt) > MAX_LEG_AGE_MS) {
        console.log(`[FIBO] 🧹 Leg ${leg.dir} en ${ticker} EXPIRADO por antigüedad (${Math.round((nowMs - leg.createdAt) / 60000)} min > 480 min).`);
        return { updatedLeg: null };
    }

    // 🔧 FIX 2: Opposite pressure — si el score contrario supera 3x y el minScore de sesión, el leg se anula
    const legScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
    const oppositeScore = leg.dir === 'BUY' ? state.scoreSell : state.scoreBuy;
    const minOppositeScore = sessionConfig?.choch?.minScore ?? 9;
    
    if (oppositeScore.points >= legScore.points * 3 && oppositeScore.points >= minOppositeScore && (nowMs - oppositeScore.lastUpdate) < 900000) {
        console.log(`[FIBO] ⚠️ Leg ${leg.dir} en ${ticker} ANULADO por presión contraria: score opuesto ${oppositeScore.points} pts (mín ${minOppositeScore}) vs propio ${legScore.points} pts (hace ${Math.round((nowMs - oppositeScore.lastUpdate) / 60000)}min).`);
        return { updatedLeg: null };
    }

    // 🔧 FIX 2.5: Invalidación por CHoCH contrario antes de llegar a OTE
    const contraryChochFound = oppositeScore.events?.some((e: string) => e.includes('CHOCH') || e.includes('CHoCH'));
    if (contraryChochFound && leg.createdAt && oppositeScore.lastUpdate > leg.createdAt) {
        console.log(`[FIBO] 🚫 Leg ${leg.dir} en ${ticker} ANULADO: Se detectó un CHoCH contrario posterior a la creación del leg (antes de llegar a OTE).`);
        return { updatedLeg: null };
    }

    // 🔧 FIX 3: Si el precio superó el extreme por >1 ATR y pasaron >30 min, OTE inalcanzable
    const range = Math.abs(leg.extreme - leg.origin);
    const atrEstimate = range * 0.3;
    const priceBeyondExtreme = leg.dir === 'BUY' 
        ? (currentPrice > leg.extreme + atrEstimate) 
        : (currentPrice < leg.extreme - atrEstimate);
    if (priceBeyondExtreme && leg.createdAt && (nowMs - leg.createdAt) > 30 * 60 * 1000) {
        console.log(`[FIBO] 🚫 Leg ${leg.dir} en ${ticker} INALCANZABLE: precio ${currentPrice} ya superó el extreme ${leg.extreme} en más de 1 ATR.`);
        return { updatedLeg: null };
    }

    if (leg.dir === 'BUY' && highPrice > leg.extreme) leg.extreme = highPrice;
    else if (leg.dir === 'SELL' && lowPrice < leg.extreme) leg.extreme = lowPrice;

    if (leg.dir === 'BUY' && lowPrice < leg.origin) impulseInvalidated = true;
    else if (leg.dir === 'SELL' && highPrice > leg.origin) impulseInvalidated = true;

    if (!impulseInvalidated) {
        const range = Math.abs(leg.extreme - leg.origin);
        const isChoch = leg.chochEvents?.some(e => e.includes('CHOCH') || e.includes('CHoCH')) || false;
        const isBos = leg.chochEvents?.some(e => e.includes('BOS')) || false;

        let triggerTfStr = leg.chochEvents?.map(e => {
            const parts = e.split('_');
            return parts[parts.length - 1]; // "5M" or "15M"
        }).find(tf => tf === '3M' || tf === '5M' || tf === '15M') || '';
        let triggerTf = triggerTfStr.toLowerCase(); // "5m" or "15m"

        let activeOteEntryPercent = config.oteEntryPercent || 50;
        if (sessionConfig) {
            if (isChoch) {
                const tfKey = `oteChoch${triggerTf}` as keyof typeof sessionConfig;
                const tfConfig = sessionConfig[tfKey] as any;
                if (tfConfig) {
                    activeOteEntryPercent = tfConfig.entryPercent ?? config.oteEntryPercent ?? 50;
                } else if ((sessionConfig as any).oteChoch) {
                    activeOteEntryPercent = (sessionConfig as any).oteChoch.entryPercent ?? config.oteEntryPercent ?? 50;
                }
            } else if (isBos) {
                const tfKey = `oteBos${triggerTf}` as keyof typeof sessionConfig;
                const tfConfig = sessionConfig[tfKey] as any;
                if (tfConfig) {
                    activeOteEntryPercent = tfConfig.entryPercent ?? config.oteEntryPercent ?? 50;
                } else if ((sessionConfig as any).oteBos) {
                    activeOteEntryPercent = (sessionConfig as any).oteBos.entryPercent ?? config.oteEntryPercent ?? 50;
                }
            } else {
                activeOteEntryPercent = config.oteEntryPercent ?? 50;
            }
        }

        const fibRatio = activeOteEntryPercent / 100;
        const entryLevel = leg.dir === 'BUY' ? leg.extreme - (range * fibRatio) : leg.extreme + (range * fibRatio);
        
        const isEntryHit = leg.dir === 'BUY' ? lowPrice <= entryLevel : highPrice >= entryLevel;
        
        if (isEntryHit && !leg.oteScored) {

            let oteEnabled = false;
            let oteMinScore = 8;

            if (sessionThresholds) {
                oteEnabled = (config.entryTrigger === 'OTE' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
                oteMinScore = leg.dir === 'BUY' ? sessionThresholds.buy : sessionThresholds.sell;
            } else if (sessionConfig) {
                if (isChoch) {
                    const tfKey = `oteChoch${triggerTf}` as keyof typeof sessionConfig;
                    const tfConfig = sessionConfig[tfKey] as any;
                    if (tfConfig) {
                        oteEnabled = tfConfig.enabled ?? false;
                        oteMinScore = leg.dir === 'BUY' 
                            ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? 8) 
                            : (tfConfig.minScoreSell ?? tfConfig.minScore ?? 8);
                    } else if ((sessionConfig as any).oteChoch) {
                        oteEnabled = (sessionConfig as any).oteChoch.enabled ?? false;
                        oteMinScore = (sessionConfig as any).oteChoch.minScore ?? 8;
                    }
                } else if (isBos) {
                    const tfKey = `oteBos${triggerTf}` as keyof typeof sessionConfig;
                    const tfConfig = sessionConfig[tfKey] as any;
                    if (tfConfig) {
                        oteEnabled = tfConfig.enabled ?? false;
                        oteMinScore = leg.dir === 'BUY' 
                            ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? 8) 
                            : (tfConfig.minScoreSell ?? tfConfig.minScore ?? 8);
                    } else if ((sessionConfig as any).oteBos) {
                        oteEnabled = (sessionConfig as any).oteBos.enabled ?? false;
                        oteMinScore = (sessionConfig as any).oteBos.minScore ?? 8;
                    }
                } else {
                    oteEnabled = false;
                    oteMinScore = 8;
                }
            } else {
                oteEnabled = (config.entryTrigger === 'OTE' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
                oteMinScore = 8;
            }
            const basePoints = (leg.chochPoints || 0) + 4;
            
            let scoreMultiplier = 1.0;
            const biasD = state.marketBias['D'] || state.marketBias['1D'];
            const bias4H = state.marketBias['4H'] || state.marketBias['240'];
            const bias1H = state.marketBias['1H'] || state.marketBias['60'];

            let alignedTfs = 0;
            let againstTfs = 0;

            if (biasD === leg.dir) alignedTfs++;
            else if (biasD && biasD !== leg.dir) againstTfs++;

            if (bias4H === leg.dir) alignedTfs++;
            else if (bias4H && bias4H !== leg.dir) againstTfs++;

            if (bias1H === leg.dir) alignedTfs++;
            else if (bias1H && bias1H !== leg.dir) againstTfs++;

            if (alignedTfs >= 3) scoreMultiplier = 1.3;
            else if (againstTfs >= 2) scoreMultiplier = 0.6;
            else if (biasD && biasD !== leg.dir) scoreMultiplier = 0.8;

            const totalPoints = Math.floor(basePoints * scoreMultiplier);

            if (sessionConfig && !sessionThresholds && config.entryTrigger !== 'SMART' && config.entryTrigger !== 'BOTH') {
                if (!oteEnabled || totalPoints < oteMinScore) {
                    console.log(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: OTE deshabilitado o puntaje ${totalPoints} < requerido ${oteMinScore} para esta sesión`);
                    return { updatedLeg: leg };
                }
            } else {
                const MIN_OTE_POINTS = oteMinScore;
                if (!leg.isValidated && totalPoints < MIN_OTE_POINTS) {
                    console.log(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: leg no validado y solo ${totalPoints} pts (< ${MIN_OTE_POINTS})`);
                    return { updatedLeg: leg };
                }
                if (!oteEnabled || totalPoints < oteMinScore) {
                    console.log(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: OTE deshabilitado o puntaje ${totalPoints} < requerido ${oteMinScore} de base`);
                    return { updatedLeg: leg };
                }
            }

            const riskDistanceOTE = Math.abs(leg.extreme - leg.origin) * 0.21;
            const rewardDistanceOTE = Math.abs(leg.extreme - leg.origin) * 0.50;
            const rrRatioOTE = riskDistanceOTE > 0 ? rewardDistanceOTE / riskDistanceOTE : 1.0;
            if (riskDistanceOTE === 0 || rrRatioOTE < 1.2) {
                console.error(`[FIBO] ❌ R:R invalid: risk=${riskDistanceOTE}, reward=${rewardDistanceOTE}, ratio=${rrRatioOTE}`);
                console.log(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} descartado: R:R teórico ${rrRatioOTE.toFixed(2)} < 1.2 (rango impulso: ${(Math.abs(leg.extreme - leg.origin)).toFixed(4)})`);
                return { updatedLeg: leg };
            }

            const activeScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
            const tfFormatted = triggerTf.toUpperCase() || '5M';
            const eventName = `🎯_OTE_Retracement_${tfFormatted}`;
            
            if (!activeScore.events.includes(eventName)) {
                activeScore.events.push(eventName);
                activeScore.points += 4;
                activeScore.lastUpdate = nowMs;
                leg.oteScored = true;
                
                const decimals = getDecimals(ticker);
                const slBuffer = calculateDynamicSlBuffer(ticker, leg.origin, sessionConfig?.slBufferPercent ?? config.slBufferPercent);
                const adjustedSL = leg.dir === 'BUY' ? leg.origin - slBuffer : leg.origin + slBuffer;
                const stopLoss = adjustedSL.toFixed(decimals);
                const tp1 = leg.extreme.toFixed(decimals);
                const riskDist = Math.abs(currentPrice - adjustedSL);
                const oteTP2Limit = leg.dir === 'BUY'
                    ? leg.extreme + (range * 0.27)
                    : leg.extreme - (range * 0.27);
                const fixedTP2 = leg.dir === 'BUY'
                    ? Math.max(oteTP2Limit, currentPrice + (riskDist * config.fixedRR))
                    : Math.min(oteTP2Limit, currentPrice - (riskDist * config.fixedRR));
                const tp2 = fixedTP2.toFixed(decimals);

                const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();

                console.log(`[FIBO] 🎯 RETROCESO 50% CONFIRMADO para ${ticker} ${leg.dir}. Despertando IA...`);

                const bias240 = state.marketBias["240"] || 'NEUTRAL';
                const bias60 = state.marketBias["60"] || 'NEUTRAL';
                const bias15 = state.marketBias["15"] || 'NEUTRAL';
                const getIconStr = (bias: string) => bias === 'BUY' ? '🟢' : bias === 'SELL' ? '🔴' : '⚪';
                const fallbackReport = `🗺️ <b>Contexto Macro:</b>\n` +
                    `${getIconStr(bias240)} 4H: ${bias240}\n` +
                    `${getIconStr(bias60)} 1H: ${bias60}\n` +
                    `${getIconStr(bias15)} 15M: ${bias15}\n\n` +
                    `🎯 <b>Confluencia de Entrada:</b> Retroceso OTE 5M en nivel del 50% Fibo (Puntaje base: ${leg.chochPoints || 0} pts + OTE: +4 pts).`;

                const oteData = {
                    tradeId, 
                    direction: leg.dir,
                    dirText: leg.dir === 'BUY' ? 'COMPRA' : 'VENTA',
                    stopLoss, tp1, tp2,
                    entryPrice: currentPrice,
                    points: (leg.chochPoints || 0) + 4, 
                    events: [...(leg.chochEvents || []), eventName],
                    confluenceReport: leg.chochReport || fallbackReport,
                    bestZone: leg.bestZone || null,
                    marketBias: { ...state.marketBias },
                    tf: eventName.split('_').pop(),
                    isChochEntry: false
                };

                const newTrade: ActiveTrade = {
                    tradeId, ticker, direction: leg.dir,
                    entryPrice: currentPrice,
                    tp1Price: leg.extreme,
                    tp2Price: fixedTP2,
                    slPrice: adjustedSL,
                    tp1Hit: false,
                    tp2Hit: false,
                    score: oteData.points || 0,
                    timestamp: nowMs
                };

                // PURE Alpha Model: Return the decision instead of executing it.
                return { updatedLeg: leg, triggerOte: true, oteData, newTrade };
            }
        }
    }
    return { updatedLeg: impulseInvalidated ? null : leg };
}


export function evaluateMacroStretching(leg: ImpulseLeg | null | undefined, highPrice: number, lowPrice: number, nowMs: number): ImpulseLeg | null {
    if (!leg) return null;

    // 🧹 Expiración: legs macro duran hasta 24 horas en RAM
    const MAX_MACRO_LEG_AGE_MS = 24 * 60 * 60 * 1000;
    if (leg.createdAt && (nowMs - leg.createdAt) > MAX_MACRO_LEG_AGE_MS) {
        console.log(`[FIBO-MACRO] 🧹 Leg MACRO ${leg.dir} expirado por antigüedad.`);
        return null;
    }

    let macroInvalidated = false;
    
    // Invalida si el precio rompe el origen
    if (leg.dir === 'BUY' && lowPrice < leg.origin) macroInvalidated = true;
    else if (leg.dir === 'SELL' && highPrice > leg.origin) macroInvalidated = true;

    if (macroInvalidated) {
        console.log(`[FIBO-MACRO] 🚫 Leg MACRO ${leg.dir} invalidado por ruptura de origen.`);
        return null;
    }

    // Estirar extremo flexible
    if (leg.dir === 'BUY' && highPrice > leg.extreme) {
        leg.extreme = highPrice;
    } else if (leg.dir === 'SELL' && lowPrice < leg.extreme) {
        leg.extreme = lowPrice;
    }

    return leg;
}

export function isInsideMacroOteZone(leg: ImpulseLeg | null | undefined, price: number): boolean {
    if (!leg) return false;
    const range = Math.abs(leg.extreme - leg.origin);
    if (range === 0) return false;
    
    if (leg.dir === 'BUY') {
        const oteBtm = leg.extreme - (range * 0.79);
        const oteTop = leg.extreme - (range * 0.50); // Límite de descuento superior (50%)
        return price >= oteBtm && price <= oteTop;
    } else {
        const oteBtm = leg.extreme + (range * 0.50);
        const oteTop = leg.extreme + (range * 0.79);
        return price >= oteBtm && price <= oteTop;
    }
}
