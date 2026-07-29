// src/engine/smc/SMCBridge.ts
// 🌉 FASE 1 — Bridge SMC Engine → JARVIS
//
// Traduce los eventos tipados del motor SMC nativo al mismo protocolo de texto
// que hoy consume processTradingAlert() (el parser de alertas de TradingView).
// De esta forma TODO el pipeline existente (impulse legs, OTE, R:R dinámico,
// killswitches, ejecución en cTrader) funciona sin cambios, pero la fuente de
// señales deja de ser TradingView: es el motor interno alimentado por cTrader.
//
// Qué emite y con qué cadencia:
//   - EVENTO_CHOCH / EVENTO_BOS   (al confirmarse la vela, con ORIGIN)
//   - EVENTO_SWEEP / LIQ_GRAB     (sweeps del liquidity engine)
//   - EVENTO_SMC_DIV              (divergencias RSI)
//   - ZONE_TOUCHED / ZONE_BROKEN  (toques y roturas de Order Blocks)
//   - SYNC_ZONES                  (por engine, respetando el throttle del bot)
//   - HEARTBEAT                   (por ticker, cada 60s → watchdog del bot)
//   - PING_PRICE                  (desde ticks spot de cTrader, máx 1/seg/ticker
//                                  → evaluación de OTE/gestión de trades casi en tiempo real)

import { smcManager } from './SMCManager.js';
import { OHLCV } from './types.js';

// Mapeo de periodos internos al formato que espera el bot (TF_WEIGHT: '5','15','60','240','D')
const TF_MAP: Record<string, string> = {
    M5: '5', M15: '15', M30: '30', H1: '60', H4: '240', D1: 'D', W1: 'W'
};

// Intervalos de SYNC alineados al SYNC_THROTTLE_MS del bot (trading.ts)
// para no generar mensajes que se descartan por throttle.
const SYNC_INTERVAL_MS: Record<string, number> = {
    M15: 120_000, H1: 300_000, H4: 600_000, D1: 900_000, W1: 900_000
};
const SYNC_TICK_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const PING_THROTTLE_MS = 1000;

// Medallas cortas (mismas que f_short_medal del Pine)
const MEDAL_MAP: Record<string, string> = {
    Platino: 'PLAT', Oro: 'ORO', Plata: 'PLATA', Bronce: 'BRONCE',
    CHoCH: 'CHoCH', GodZone: 'GOD', Breaker: 'BRK'
};

// Formato de precio seguro para el parser del bot (regex [0-9.,]+):
// toFixed nunca produce notación científica; Number() recorta ceros de más.
const fmt = (n: number) => Number(n.toFixed(8)).toString();

const dirToBot = (d: string) => (d === 'Bullish' ? 'BUY' : 'SELL');

let bridgeStarted = false;
const lastSyncSent = new Map<string, number>();
const lastPingSent = new Map<string, number>();

import { shadowComparator } from './ShadowComparator.js';
import { config } from '../../config.js';

type AlertFn = (alertText: string) => Promise<any>;

function dispatch(processAlert: AlertFn, alertText: string) {
    if (config.SHADOW_MODE_SMC) {
        // Send to comparator and do not trigger actual trades via processAlert
        shadowComparator.recordSMCAlert(alertText);
    } else {
        processAlert(alertText).catch((err: any) =>
            console.error(`[SMC-BRIDGE] Error procesando "${alertText.substring(0, 60)}...":`, err.message)
        );
    }
}

// ─── Traducción de eventos por vela ─────────────────────────────────────────

function handleEngineEvents(processAlert: AlertFn, key: string, candle: OHLCV, events: any[]) {
    const [ticker, period] = key.split(':');
    const tf = TF_MAP[period] ?? period;
    const ts = Date.now();

    const state = smcManager.getEngine(ticker, period).getState();
    const vwapTag = state.vwapStatus ? ` | VWAP: ${state.vwapStatus}` : '';

    for (const ev of events) {
        let alert: string | null = null;

        switch (ev.type) {
            case 'EVENT_CHOCH':
            case 'EVENT_BOS': {
                const prefix = ev.type === 'EVENT_CHOCH' ? 'EVENTO_CHOCH' : 'EVENTO_BOS';
                const dir = dirToBot(ev.direction);
                // Precio = cierre de la vela de ruptura (como el Pine), no el nivel roto
                const origin = ev.origin !== undefined ? ` | ORIGIN: ${fmt(ev.origin)}` : '';
                alert = `${prefix} | ${ticker} | TF: ${tf} | Dir: ${dir} | Precio: ${fmt(candle.close)}${vwapTag}${origin} | CONFIRMED | TS: ${ts}`;
                break;
            }
            case 'EVENT_SWEEP': {
                const dir = dirToBot(ev.direction);
                if (ev.sweepType === 'LIQ_GRAB') {
                    alert = `LIQ_GRAB | ${ticker} | TF: ${tf} | Dir: ${dir} | Nivel: ${fmt(ev.price)} | TS: ${ts}`;
                } else {
                    alert = `EVENTO_SWEEP | ${ticker} | TF: ${tf} | Dir: ${dir} | Nivel Reclamado | TS: ${ts}`;
                }
                break;
            }
            case 'EVENT_DIVERGENCE': {
                const dir = dirToBot(ev.direction);
                alert = `EVENTO_SMC_DIV | ${ticker} | TF: ${tf} | Dir: ${dir} | TS: ${ts}`;
                break;
            }
            case 'ZONE_TOUCHED':
            case 'ZONE_BROKEN': {
                const dir = dirToBot(ev.direction);
                const medal = MEDAL_MAP[ev.medal] ?? ev.medal;
                alert = `${ev.type} | ${ticker} | TF: ${tf} | Dir: ${dir} | Medal: ${medal} | Score: ${ev.score} | Top: ${fmt(ev.top)} | Btm: ${fmt(ev.bottom)} | TS: ${ts}`;
                break;
            }
            // EVENT_OB_CREATED / EVENT_IFVG_CREATED no se traducen:
            // las zonas llegan al radar del bot vía SYNC_ZONES (igual que en el Pine).
        }

        if (alert) dispatch(processAlert, alert);
    }
}

// ─── SYNC_ZONES periódico ───────────────────────────────────────────────────

function buildSyncAlert(ticker: string, period: string): string | null {
    const tf = TF_MAP[period] ?? period;
    const state = smcManager.getEngine(ticker, period).getState();

    const zones = [...(state.activeOBs ?? []), ...(state.activeBreakers ?? [])]
        .filter(ob => !ob.mitigated)
        .slice(0, 20)
        .map(ob => ({
            t: tf,
            d: ob.direction === 'Bullish' ? 'BUY' : 'SELL',
            p: ob.top,
            b: ob.bottom,
            lv: fmt(ob.direction === 'Bullish' ? ob.top : ob.bottom),
            md: MEDAL_MAP[ob.category] ?? ob.category,
            sc: ob.score,
            a: state.atr ?? 0
        }));

    if (zones.length === 0) return null;

    const trend = state.currentTrend === 'Bullish' ? 'BUY' : state.currentTrend === 'Bearish' ? 'SELL' : 'NEUTRAL';
    const engine = smcManager.getEngine(ticker, period);
    const wBiasStr = engine.weeklyBias === 'Bullish' ? 'BUY' : engine.weeklyBias === 'Bearish' ? 'SELL' : 'NEUTRAL';
    
    return `SYNC_ZONES | ${ticker} | TF: ${tf} | Trend: ${trend} | WBias: ${wBiasStr} | Payload: ${JSON.stringify(zones)} | TS: ${Date.now()}`;
}

function syncTick(processAlert: AlertFn) {
    const now = Date.now();
    for (const key of smcManager.getEngines().keys()) {
        const period = key.split(':')[1] ?? '';
        const interval = SYNC_INTERVAL_MS[period] ?? 300_000;
        if (now - (lastSyncSent.get(key) ?? 0) < interval) continue;

        const [ticker] = key.split(':');
        const alert = buildSyncAlert(ticker, period);
        if (alert) {
            lastSyncSent.set(key, now);
            dispatch(processAlert, alert);
        }
    }
}

// ─── HEARTBEAT periódico (watchdog del bot) ─────────────────────────────────

function heartbeatTick(processAlert: AlertFn) {
    const tickers = new Set<string>();
    for (const key of smcManager.getEngines().keys()) tickers.add(key.split(':')[0]);

    for (const ticker of tickers) {
        // Preferir el engine M15 para el reporte (el de mayor frecuencia operativa)
        const engines = smcManager.getEngines();
        const engine = engines.get(`${ticker}:M15`)
            ?? [...engines.entries()].find(([k]) => k.startsWith(`${ticker}:`))?.[1];
        if (!engine) continue;

        const s = engine.getState();
        const bias = s.currentTrend === 'Bullish' ? 'BUY' : s.currentTrend === 'Bearish' ? 'SELL' : 'NEUTRAL';
        const zoneCount = (s.activeOBs?.length ?? 0) + (s.activeFVGs?.length ?? 0);
        const vwapTag = s.vwapStatus ? ` | VWAP: ${s.vwapStatus}` : '';
        dispatch(processAlert, `HEARTBEAT | ${ticker} | TF: 15 | Bias: ${bias} | Zones: ${zoneCount}${vwapTag} | TS: ${Date.now()}`);
    }
}

// ─── PING_PRICE desde ticks spot ────────────────────────────────────────────

function handleSpotTick(processAlert: AlertFn, baseTicker: string, candle: OHLCV) {
    const now = Date.now();
    if (now - (lastPingSent.get(baseTicker) ?? 0) < PING_THROTTLE_MS) return;
    lastPingSent.set(baseTicker, now);

    const engine = smcManager.getEngines().get(`${baseTicker}:M15`);
    const vwapStatus = engine?.getState().vwapStatus;
    const vwapTag = vwapStatus ? ` | VWAP: ${vwapStatus}` : '';

    dispatch(processAlert, `PING_PRICE | ${baseTicker} | TF: 15 | Precio: ${fmt(candle.close)} | High: ${fmt(candle.high)} | Low: ${fmt(candle.low)}${vwapTag} | TS: ${now}`);
}

// ─── Inicialización ─────────────────────────────────────────────────────────

export async function initSMCBridge() {
    if (bridgeStarted) {
        console.warn('[SMC-BRIDGE] Ya estaba iniciado, se ignora la segunda llamada.');
        return;
    }
    bridgeStarted = true;

    // Imports dinámicos para evitar ciclos (trading.ts y ctrader.ts son pesados)
    const { processTradingAlert } = await import('../../db/trading.js');
    const { setSpotTickListener } = await import('../../services/ctrader.js');

    // 1. Eventos del motor (CHoCH/BOS, sweeps, divergencias, zonas)
    smcManager.addListener((key, candle, events) => handleEngineEvents(processTradingAlert, key, candle, events));

    // 2. SYNC_ZONES y HEARTBEAT periódicos
    setInterval(() => syncTick(processTradingAlert), SYNC_TICK_MS);
    setInterval(() => heartbeatTick(processTradingAlert), HEARTBEAT_INTERVAL_MS);

    // 3. PING de precio desde ticks spot (reemplaza al PING de cierre de vela de TradingView)
    setSpotTickListener((baseTicker, candle) => handleSpotTick(processTradingAlert, baseTicker, candle));

    if(false) console.log('[SMC-BRIDGE] 🌉 Bridge SMC → JARVIS activo (eventos + SYNC + HEARTBEAT + PING por ticks)');
}
