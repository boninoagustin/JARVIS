import type { RadarZone, RadarState, ImpulseLeg, ActiveTrade, ScoreState, ScoreEvent } from './Types.js';
import { extractMgmtOverrides } from './Types.js';
import { predict as mlPredict, isMLActive } from './MLFilter.js';
import { telemetry } from '../services/telemetry.js';

// 🆕 Plan B ago-2026: dbg controlado por env para spot-checks sin recompilar.
// Guard `typeof process` porque este módulo se re-exporta al NAVEGADOR (jarvis-os backtest),
// donde `process` no existe → crasheaba al importar (pantalla negra).
const DEBUG = typeof process !== 'undefined' && process?.env?.JARVIS_DEBUG_FIBO === '1';
const dbg = (...args: unknown[]) => { if (DEBUG) console.log(...args); };
// 🆕 sep-2026 anti-spam: última prob logueada por leg (ticker|dir|createdAt) — el [ML] ⛔
// se loguea solo en el primer rechazo y cuando la prob cambia ≥0.1 (antes: una línea por
// touch/tick, 30-90 repetidas por leg, que además saturaban el canal RPC del worker).
const _mlLogCache = new Map<string, number>();


export const SETUP_MEMORY_WINDOW_MS = 172800000; // 48 Horas (Swing Core) — LEGACY: sustituido por EVENT_TTL_MS por timeframe

// ⏳ TTL de cada evento de scoring según su timeframe (alineado con MAX_ZONE_AGE_MS de trading.ts).
// Los puntos caducan cuando nowMs - ts >= EVENT_TTL_MS[tf]. Fallback: 4h (igual que el de zonas).
export const EVENT_TTL_MS: Record<string, number> = {
    '3': 1800000, '5': 3600000, '15': 21600000,
    '60': 28800000, '240': 86400000, 'D': 604800000,
};
const EVENT_TTL_FALLBACK_MS = 14400000; // 4h para tf fuera de la tabla

// Jerarquía de timeframes para la invalidación estructural (CHoCH/BOS contrario)
export const TF_RANK: Record<string, number> = { '3': 1, '5': 2, '15': 3, '60': 4, '240': 5, 'D': 6 };

const isValidScoreEvent = (e: any): e is ScoreEvent =>
    !!e && typeof e === 'object' && typeof e.id === 'string' &&
    typeof e.pts === 'number' && typeof e.tf === 'string' && typeof e.ts === 'number';

const eventTtl = (tf: string): number => EVENT_TTL_MS[tf] ?? EVENT_TTL_FALLBACK_MS;

// Puntos vivos del score: suma de pts de eventos no caducados, capado a 35
export function computePoints(score: ScoreState, nowMs: number): number {
    let total = 0;
    for (const e of score.events || []) {
        if (isValidScoreEvent(e) && (nowMs - e.ts) < eventTtl(e.tf)) total += e.pts;
    }
    return Math.min(35, total);
}

// Recalcula la caché derivada `points` (no toca lastUpdate)
export function refreshScoreCache(score: ScoreState, nowMs: number): void {
    score.points = computePoints(score, nowMs);
}

// 🧹 Garbage collector: descarta eventos caducados por TTL y entradas legacy inválidas
// (p.ej. strings del formato antiguo persistido en Firebase) y refresca la caché.
export function gcScore(score: ScoreState, nowMs: number): void {
    if (!Array.isArray(score.events)) { score.events = []; score.points = 0; return; }
    score.events = score.events.filter(e => isValidScoreEvent(e) && (nowMs - e.ts) < eventTtl(e.tf));
    refreshScoreCache(score, nowMs);
}

// Añade un evento: gc + dedupe por id + push + refresh de caché points/lastUpdate.
// Devuelve true si el evento se añadió (false si ya existía el id).
export function addScoreEvent(score: ScoreState, ev: ScoreEvent): boolean {
    gcScore(score, ev.ts);
    if (score.events.some(e => e.id === ev.id)) { refreshScoreCache(score, ev.ts); return false; }
    score.events.push(ev);
    score.lastUpdate = ev.ts;
    refreshScoreCache(score, ev.ts);
    return true;
}

// 💥 Invalidación estructural acotada: un CHoCH/BOS en `chochTf` borra del score CONTRARIO
// los eventos de TF de igual o menor jerarquía (TF_RANK[tf] <= TF_RANK[chochTf]).
export function structuralInvalidate(oppositeScore: ScoreState, chochTf: string, nowMs: number): void {
    const rank = TF_RANK[chochTf] ?? 0;
    oppositeScore.events = (oppositeScore.events || []).filter(e =>
        isValidScoreEvent(e) && (TF_RANK[e.tf] ?? 0) > rank
    );
    refreshScoreCache(oppositeScore, nowMs);
}

export const TF_WEIGHT: Record<string, number> = {
    '3': 0.5,    // 3M: medio punto (mucho ruido)
    '5': 0.75,   // 5M: tres cuartos
    '15': 1.0,   // 15M: base (gatillo principal)
    '60': 1.5,   // 1H: 50% más
    '240': 2.5,  // 4H: x2.5 basado en estadística
    'D': 4.0,    // Daily: x4.0 dominante
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
    const r = { ...raw } as Record<string, unknown>;
    if (r.t !== undefined && r.tf === undefined) r.tf = r.t;
    if (r.d !== undefined && r.dir === undefined) r.dir = r.d;
    if (r.p !== undefined && r.top === undefined) r.top = r.p;
    if (r.b !== undefined && r.btm === undefined) r.btm = r.b;
    if (r.lv !== undefined && r.lvl === undefined) r.lvl = r.lv;
    if (r.md !== undefined && r.medal === undefined) r.medal = r.md;
    if (r.sc !== undefined && r.score === undefined) r.score = r.sc;
    if (r.mi !== undefined && r.mid === undefined) r.mid = r.mi;
    if (r.a !== undefined && r.atr === undefined) r.atr = r.a;
    return r as unknown as RadarZone;
}


export function resolveOteGate(isChoch: boolean, isBos: boolean, triggerTf: string, dir: 'BUY'|'SELL', config: any, sessionConfig: any) {
    if (!sessionConfig) return { entryPercent: config.oteEntryPercent || 50, enabled: ['OTE','BOTH','SMART'].includes(config.entryTrigger), minScore: 8 };
    const prefix = isChoch ? 'oteChoch' : isBos ? 'oteBos' : null;
    const tfConfig = prefix ? (sessionConfig[`${prefix}${triggerTf}`] ?? sessionConfig[prefix]) : null;
    if (!tfConfig) return { entryPercent: config.oteEntryPercent ?? 50, enabled: false, minScore: 8 };
    return {
        entryPercent: tfConfig.entryPercent ?? config.oteEntryPercent ?? 50,
        enabled: tfConfig.enabled ?? false,
        minScore: dir === 'BUY' ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? 8) : (tfConfig.minScoreSell ?? tfConfig.minScore ?? 8)
    };
}

export const getDecimals = (ticker: string) => (ticker.includes('BTC') || ticker.includes('ETH') || ticker.includes('US30') || ticker.includes('NAS') || ticker.includes('XAU') || ticker.includes('GOLD')) ? 2 : (ticker.includes('JPY') ? 3 : 5);

/** Distancia mínima en precio absoluto para que cTrader acepte SL/TP. */
export function getMinPipDistance(ticker: string): number {
    const t = ticker.toUpperCase();
    if (t.includes('BTC') || t.includes('ETH')) return 50;         // crypto: $50
    if (t.includes('XAU') || t.includes('GOLD')) return 1.0;       // gold: $1
    if (t.includes('US30') || t.includes('NAS') || t.includes('SPX') || t.includes('US500')) return 5; // índices: 5 pts
    if (t.includes('USOIL') || t.includes('XTI') || t.includes('WTI')) return 0.10; // oil: 10 cents
    if (t.includes('JPY')) return 0.10;                             // JPY pairs: 10 pips (0.10)
    return 0.0010;                                                   // forex majors: 10 pips (0.0010)
}

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



export interface AlphaContext {
    config: any;
    currentSession: string;
    sessionConfig: any;
    // 🛡️ sep-2026 fix OTE: high/low de la última vela CERRADA (undefined en backtest)
    prevHigh?: number;
    prevLow?: number;
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
    ctx: AlphaContext
): AlphaInsight {
    if (!leg) return { updatedLeg: null };
    let impulseInvalidated = false;

    const { config, sessionConfig } = ctx;

    // 🆕 Plan B ago-2026: familia/tf del leg para la telemetría de gatillos
    let _legFam = 'Choch'; let _legTf = '5m';
    for (const e of leg.chochEvents ?? []) {
        if (e.includes('BOS')) _legFam = 'Bos';
        if (e.includes('CHOCH') || e.includes('CHoCH')) _legFam = 'Choch';
        const m = String(e).match(/_(\d+M)$/);
        if (m && ['3M', '5M', '15M'].includes(m[1])) _legTf = m[1].toLowerCase();
    }
    const _oteKey = `ote${_legFam}${_legTf}`;

    // 🔧 FIX 1: Stale leg cleaner — legs de más de 8 horas se invalidan automáticamente (Intradia)
    const MAX_LEG_AGE_MS = 8 * 60 * 60 * 1000;
    if (leg.createdAt && (nowMs - leg.createdAt) > MAX_LEG_AGE_MS) {
        dbg(`[FIBO] 🧹 Leg ${leg.dir} en ${ticker} EXPIRADO por antigüedad (${Math.round((nowMs - leg.createdAt) / 60000)} min > 480 min).`);
        // 🆕 sep-2026: separar expiración "pura" (la zona nunca se retrazó) de la que tuvo
        // al menos un rechazo ML en touch de zona (el leg siguió vivo esperando tras el veto).
        telemetry.oteDeath(ticker, ctx.currentSession, _oteKey, leg.mlRejectedOnce ? 'otraMl' : 'otra');
        return { updatedLeg: null };
    }

    // 🔧 FIX 2: Opposite pressure — si el score contrario supera 3x y el minScore de sesión, el leg se anula
    const legScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
    const oppositeScore = leg.dir === 'BUY' ? state.scoreSell : state.scoreBuy;
    const minOppositeScore = sessionConfig?.choch5m?.minScore ?? sessionConfig?.choch15m?.minScore ?? 9;
    
    const ownStrength = Math.max(computePoints(legScore, nowMs), leg.chochPoints ?? 0);
    const dominanceThreshold = Math.max(ownStrength * 3, minOppositeScore * 2);
    const oppositePoints = computePoints(oppositeScore, nowMs);
    
    if (oppositePoints >= dominanceThreshold && (nowMs - oppositeScore.lastUpdate) < 900000) {
        dbg(`[FIBO] ⚠️ Leg ${leg.dir} en ${ticker} ANULADO por presión contraria: score opuesto ${oppositePoints} pts vs propio histórico ${ownStrength} pts (hace ${Math.round((nowMs - oppositeScore.lastUpdate) / 60000)}min).`);
        telemetry.oteDeath(ticker, ctx.currentSession, _oteKey, 'opuesta');
        return { updatedLeg: null };
    }

    // 🔧 FIX 2.5: Invalidación por CHoCH contrario antes de llegar a OTE
    const contraryChochFound = oppositeScore.events?.some(e => e.id.includes('CHOCH') || e.id.includes('CHoCH'));
    if (contraryChochFound && leg.createdAt && oppositeScore.lastUpdate > leg.createdAt) {
        dbg(`[FIBO] 🚫 Leg ${leg.dir} en ${ticker} ANULADO: Se detectó un CHoCH contrario posterior a la creación del leg (antes de llegar a OTE).`);
        telemetry.oteDeath(ticker, ctx.currentSession, _oteKey, 'chochContrario');
        return { updatedLeg: null };
    }

    // 🔧 FIX 3: Si el precio superó el extreme por >1 ATR y pasaron >30 min, OTE inalcanzable
    const range = Math.abs(leg.extreme - leg.origin);
    const atrEstimate = state.atr14 ?? (range * 0.3);
    const priceBeyondExtreme = leg.dir === 'BUY' 
        ? (currentPrice > leg.extreme + atrEstimate) 
        : (currentPrice < leg.extreme - atrEstimate);
    if (priceBeyondExtreme && leg.createdAt && (nowMs - leg.createdAt) > 30 * 60 * 1000) {
        dbg(`[FIBO] 🚫 Leg ${leg.dir} en ${ticker} INALCANZABLE: precio ${currentPrice} ya superó el extreme ${leg.extreme} en más de 1 ATR.`);
        telemetry.oteDeath(ticker, ctx.currentSession, _oteKey, 'inalcanzable');
        return { updatedLeg: null };
    }

    // 🛡️ sep-2026 fix OTE: estirar el extreme SOLO con vela CERRADA (prevHigh/prevLow).
    // Antes usaba high/low de la vela en formación (pings de tick) → la OTE "huía" del precio.
    const stretchHigh = ctx.prevHigh ?? highPrice;
    const stretchLow = ctx.prevLow ?? lowPrice;

    if (leg.dir === 'BUY' && stretchHigh > leg.extreme) leg.extreme = stretchHigh;
    else if (leg.dir === 'SELL' && stretchLow < leg.extreme) leg.extreme = stretchLow;

    // 🛡️ sep-2026 fix OTE: invalidación por origin también con vela CERRADA (paridad backtest)
    if (leg.dir === 'BUY' && stretchLow < leg.origin) impulseInvalidated = true;
    else if (leg.dir === 'SELL' && stretchHigh > leg.origin) impulseInvalidated = true;

    if (!impulseInvalidated) {
        const range = Math.abs(leg.extreme - leg.origin);
        let isChoch = false, isBos = false, triggerTfStr = '';
        for (const e of leg.chochEvents ?? []) {
            if (e.includes('CHOCH') || e.includes('CHoCH')) isChoch = true;
            if (e.includes('BOS')) isBos = true;
            if (!triggerTfStr) {
                const tf = e.substring(e.lastIndexOf('_') + 1);
                if (tf === '3M' || tf === '5M' || tf === '15M') triggerTfStr = tf;
            }
        }
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

            // 🆕 FILTRO DE CALIDAD DE VELA DE GATILLO (Clímax y Rechazo)
            const atr = state.atr14 ?? 0;
            const barRange = highPrice - lowPrice;
            if (atr > 0 && barRange > 2.0 * atr) return { updatedLeg: leg }; // vela clímax
            const openApprox = state.previousPrice ?? currentPrice;
            if (barRange > 0) {
                const upperWick = (highPrice - Math.max(openApprox, currentPrice)) / barRange;
                const lowerWick = (Math.min(openApprox, currentPrice) - lowPrice) / barRange;
                if (leg.dir === 'BUY' && upperWick > 0.6) return { updatedLeg: leg };
                if (leg.dir === 'SELL' && lowerWick > 0.6) return { updatedLeg: leg };
            }

            let oteEnabled = false;
            let oteMinScore = 8;
            let oteTriggerCfg: any = null; // 🆕 config del gatillo OTE (genes tuneados)

            if (sessionConfig) {
                if (isChoch) {
                    const tfKey = `oteChoch${triggerTf}` as keyof typeof sessionConfig;
                    const tfConfig = sessionConfig[tfKey] as any;
                    if (tfConfig) {
                        oteTriggerCfg = tfConfig;
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
                        oteTriggerCfg = tfConfig;
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

            if (config.entryTrigger === 'SMART' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'OTE') {
                oteEnabled = true;
            }

            const totalPoints = (leg.chochPoints || 0) + 4;

            // 🆕 ML FILTER (FreqAI-style): si hay modelo, la predicción reemplaza la heurística
            const activeScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
            const scorePts = computePoints(activeScore, nowMs);
            const tfKey = triggerTf === '15m' ? '15' : triggerTf === '3m' ? '3' : '5';
            const mlPred = mlPredict(state, leg.dir, nowMs, leg.chochPoints || 0, scorePts, tfKey, ticker);

            if (isMLActive() && mlPred) {
                if (!mlPred.approved) {
                    // 🆕 sep-2026 anti-spam: logear solo el primer rechazo del leg y los
                    // cambios grandes de prob (≥0.1). Antes logueaba en cada touch/tick —
                    // el mismo leg podía meter 30-90 líneas idénticas en vivo y saturar
                    // el canal RPC del worker en backtest.
                    const _mlk = `${ticker}|${leg.dir}|${leg.createdAt}`;
                    const _lastP = _mlLogCache.get(_mlk);
                    if (_lastP === undefined || Math.abs(mlPred.probability - _lastP) >= 0.1) {
                        console.log(`[ML] ⛔ ${ticker} ${leg.dir}: RECHAZADO por ML (prob=${mlPred.probability.toFixed(3)} < ${mlPred.threshold})`);
                        if (_mlLogCache.size > 2000) _mlLogCache.clear();
                        _mlLogCache.set(_mlk, mlPred.probability);
                    }
                    // 🆕 sep-2026: marcar el leg para clasificar su expiración como 'otraMl' y
                    // contar el veto (el backtest no modela este filtro → paridad).
                    leg.mlRejectedOnce = true;
                    telemetry.oteMlReject(ticker, ctx.currentSession, _oteKey);
                    return { updatedLeg: leg };
                }
                console.log(`[ML] ✅ ${ticker} ${leg.dir}: APROBADO por ML (prob=${mlPred.probability.toFixed(3)} >= ${mlPred.threshold}) [override heurística]`);
            } else {
                // Fallback: heurística legacy (solo si ML no está activo)

            if (sessionConfig && config.entryTrigger !== 'SMART' && config.entryTrigger !== 'BOTH') {
                if (!oteEnabled || totalPoints < oteMinScore) {
                    dbg(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: OTE deshabilitado o puntaje ${totalPoints} < requerido ${oteMinScore} para esta sesión`);
                    telemetry.oteDeath(ticker, ctx.currentSession, _oteKey, 'minScore');
                    return { updatedLeg: leg };
                }
            } else {
                const MIN_OTE_POINTS = oteMinScore;
                if (!leg.isValidated && (leg.chochPoints || 0) < MIN_OTE_POINTS) {
                    dbg(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: leg no validado y solo ${leg.chochPoints || 0} pts (< ${MIN_OTE_POINTS})`);
                    telemetry.oteDeath(ticker, ctx.currentSession, _oteKey, 'minScore');
                    return { updatedLeg: leg };
                }
                if (!oteEnabled || totalPoints < oteMinScore) {
                    dbg(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: OTE deshabilitado o puntaje ${totalPoints} < requerido ${oteMinScore} de base`);
                    telemetry.oteDeath(ticker, ctx.currentSession, _oteKey, 'minScore');
                    return { updatedLeg: leg };
                }
            }
            } // end ML fallback

            const entryFill = entryLevel; // fill limit en el 50% (supuesto estándar de backtest)
            const decimals = getDecimals(ticker);
            // 🆕 slBuff tuneado por gatillo (auto-tune) tiene prioridad sobre el de sesión/raíz
            const fixedBuffer = calculateDynamicSlBuffer(ticker, leg.origin, oteTriggerCfg?.slBuff ?? sessionConfig?.slBufferPercent ?? config.slBufferPercent);
            const slBuffer = Math.max(fixedBuffer, (state.atr14 ?? 0) * 0.5); // piso: 0.5×ATR real
            const adjustedSL = leg.dir === 'BUY' ? leg.origin - slBuffer : leg.origin + slBuffer;

            const risk = Math.abs(entryFill - adjustedSL);
            // TP2 del OTE: respeta el tp2 tuneado del gatillo (o config.fixedRR como fallback) sin truncar a la extensión -0.27
            const oteRR = oteTriggerCfg?.tp2 ?? config.fixedRR;
            const fixedTP2 = leg.dir === 'BUY'
                ? entryFill + (risk * oteRR)
                : entryFill - (risk * oteRR);
            const reward = Math.abs(fixedTP2 - entryFill); // Se evalúa el R:R contra el TP2 real de la orden
            const rrRatioOTE = risk > 0 ? reward / risk : 1.0;

            if (risk <= 0 || rrRatioOTE < 0.75) {
                dbg(`[FIBO] ❌ R:R invalid: risk=${risk}, reward=${reward}, ratio=${rrRatioOTE}`);
                dbg(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} descartado: R:R teórico ${rrRatioOTE.toFixed(2)} < 0.75 (rango impulso: ${(Math.abs(leg.extreme - leg.origin)).toFixed(4)})`);
                telemetry.oteDeath(ticker, ctx.currentSession, _oteKey, 'rr075');
                return { updatedLeg: leg };
            }

            const tfFormatted = triggerTf.toUpperCase() || '5M';
            const eventName = `🎯_OTE_Retracement_${tfFormatted}`;
            const eventTfKey = triggerTf === '15m' ? '15' : triggerTf === '3m' ? '3' : '5';
            
            if (addScoreEvent(activeScore, { id: eventName, pts: 4, tf: eventTfKey, ts: nowMs })) {
            leg.oteScored = true;
            // 🆕 Plan B ago-2026: ejecución OTE registrada en la telemetría
            telemetry.oteExec(ticker, ctx.currentSession, `ote${isChoch ? 'Choch' : 'Bos'}${triggerTf}`);
                
                const stopLoss = adjustedSL.toFixed(decimals);
                const riskDist = risk;
                const fixedTP1 = leg.dir === 'BUY' ? entryFill + riskDist : entryFill - riskDist;
                // TP1 estructural: usar el extremo del impulso si queda a >= tp1StructuralMinRR (default 1.2R);
                // si está más cerca, fallback al 1:1 fijo del riesgo.
                // F3-etapa3: leer por gatillo primero (oteTriggerCfg), fallback a nivel activo.
                const structuralMinRR = oteTriggerCfg?.tp1StructuralMinRR ?? config.tp1StructuralMinRR ?? 1.2;
                const structuralDist = Math.abs(leg.extreme - entryFill);
                const chosenTP1 = structuralDist >= riskDist * structuralMinRR ? leg.extreme : fixedTP1;
                const tp1 = chosenTP1.toFixed(decimals);
                const tp2 = fixedTP2.toFixed(decimals);

                // 🛡️ FIX (30-sep-2026): sanidad de niveles. Caso real NZDUSD 30-sep: SELL con
                // SL POR DEBAJO del entry (geometría invertida) → el broker rechaza SL/TP
                // (TRADING_BAD_STOPS). Abortar la señal OTE antes de emitirla evita journals
                // SKIP/ABORTED por niveles imposibles. Es un guardrail de sanidad, no un
                // cambio de estrategia: descarta señales que jamás llenarían en un broker real.
                const slSideOk = leg.dir === 'BUY' ? adjustedSL < entryFill : adjustedSL > entryFill;
                const tp1SideOk = leg.dir === 'BUY' ? chosenTP1 > entryFill : chosenTP1 < entryFill;
                const tp2SideOk = leg.dir === 'BUY' ? fixedTP2 > entryFill : fixedTP2 < entryFill;
                if (!slSideOk || !tp1SideOk || !tp2SideOk) {
                    dbg(`[FIBO] 🛡️ OTE ${ticker} ${leg.dir} descartado: niveles invertidos (entry=${entryFill}, SL=${adjustedSL}, TP1=${chosenTP1}, TP2=${fixedTP2}). slOk=${slSideOk} tp1Ok=${tp1SideOk} tp2Ok=${tp2SideOk}`);
                    telemetry.oteDeath(ticker, ctx.currentSession, _oteKey, 'badLevels');
                    return { updatedLeg: leg };
                }

                const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();

                dbg(`[FIBO] 🎯 RETROCESO 50% CONFIRMADO para ${ticker} ${leg.dir}. Despertando IA...`);

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
                    entryPrice: entryFill,
                    points: (leg.chochPoints || 0) + 4, 
                    events: [...(leg.chochEvents || []), eventName],
                    confluenceReport: leg.chochReport || fallbackReport,
                    bestZone: leg.bestZone || null,
                    marketBias: { ...state.marketBias },
                    tf: tfFormatted,
                    isChochEntry: false,
                    // 🆕 sep-2026: gatillo REAL que ejecutó esta OTE (para clasificación honesta
                    // en el backtest: los eventos del Pine mezclan TFs y ensucian el triggerType).
                    execTrigger: `ote${isChoch ? 'Choch' : 'Bos'}${triggerTf}`,
                    // 🆕 genes de gestión tuneados por el auto-tune para ESTE gatillo OTE
                    mgmtOverrides: extractMgmtOverrides(oteTriggerCfg)
                };

                const newTrade: ActiveTrade = {
                    tradeId, ticker, direction: leg.dir,
                    entryPrice: entryFill,
                    tp1Price: chosenTP1,
                    tp2Price: fixedTP2,
                    slPrice: adjustedSL,
                    tp1Hit: false,
                    tp2Hit: false,
                    score: oteData.points || 0,
                    timestamp: nowMs
                };
                // 🆕 Congelar genes de gestión del gatillo en el trade (solo si existen — Firestore-safe)
                if (oteData.mgmtOverrides) newTrade.mgmtOverrides = oteData.mgmtOverrides;

                // PURE Alpha Model: Return the decision instead of executing it.
                return { updatedLeg: leg, triggerOte: true, oteData, newTrade };
            }
        }
    }
    if (impulseInvalidated) return { updatedLeg: null }; 
    return { updatedLeg: leg };
}


export function evaluateMacroStretching(leg: ImpulseLeg | null | undefined, highPrice: number, lowPrice: number, nowMs: number): ImpulseLeg | null {
    if (!leg) return null;

    // 🧹 Expiración: legs macro duran hasta 24 horas en RAM
    const MAX_MACRO_LEG_AGE_MS = 24 * 60 * 60 * 1000;
    if (leg.createdAt && (nowMs - leg.createdAt) > MAX_MACRO_LEG_AGE_MS) {
        dbg(`[FIBO-MACRO] 🧹 Leg MACRO ${leg.dir} expirado por antigüedad.`);
        return null;
    }

    let macroInvalidated = false;
    
    // Invalida si el precio rompe el origen
    if (leg.dir === 'BUY' && lowPrice < leg.origin) macroInvalidated = true;
    else if (leg.dir === 'SELL' && highPrice > leg.origin) macroInvalidated = true;

    if (macroInvalidated) {
        dbg(`[FIBO-MACRO] 🚫 Leg MACRO ${leg.dir} invalidado por ruptura de origen.`);
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
