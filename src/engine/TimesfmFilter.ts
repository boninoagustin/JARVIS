/**
 * TimesfmFilter.ts — Filtro de confluencia direccional TimesFM (F1)
 *
 * Módulo COMPARTIDO entre el vivo (src/db/trading.ts) y el backtest
 * (jarvis-os/src/services/backtestEngine.ts vía shim jarvis-os/src/engine/TimesfmFilter.ts).
 * MISMO patrón que AlphaModel: una sola fuente de verdad → backtest parity garantizada.
 *
 * Lógica (soft gate, todo configurable):
 *   - Dirección del forecast: media del path q50 vs precio actual (eps = dirEpsAtr × ATR).
 *   - Convicción: spread medio (q90−q10)/ATR — spread angosto = incertidumbre baja = convicción alta.
 *
 *   señal + forecast alineado  + convicción alta → APPROVE riskMult = alignedMult (1.0)
 *   señal + forecast en contra + convicción alta → REDUCE counterMult (0.25), o REJECT si
 *                                                  score SMC < minScoreToOverrideReject (y rejectEnabled)
 *   convicción baja (cualquier dirección)        → REDUCE lowConvictionMult (0.6), nunca rechaza
 *   forecast plano (|delta| < eps)               → REDUCE flatMult (0.6)
 *
 * Degradación (vivo): puente caído / timeout / forecast stale → APPROVE 1.0 (skip filtro,
 * NUNCA frenar el trading). Toda degradación se audita con timestamp.
 *
 * Auditoría: appendTimesfmAudit() escribe JSONL (mismo formato vivo y backtest).
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface TimesfmForecast {
    /** ts (ms) de la vela cuyo cierre originó el forecast (contexto = cierres ≤ ts) */
    ts: number;
    horizon: number;
    point?: number[];   // media por paso; older caches may contain only quantiles
    q10: number[];
    q50: number[];
    q90: number[];
    model_version?: string;
    ticker?: string;
    tf?: number;
    schema_version?: number;
    timestamp_convention?: string;
    contextCloseTimeMs?: number;
    computedAt?: number;
    availableAt?: number;
}

export interface TimesfmFilterConfig {
    enabled: boolean;
    /** pasos de vela del forecast a evaluar (default 12). Se clampa al largo del forecast. */
    horizon: number;
    alignedMult: number;          // default 1.0
    counterMult: number;          // default 0.25
    lowConvictionMult: number;    // default 0.6
    flatMult: number;             // default 0.6
    /** spread(q90−q10)/ATR ≤ esto → convicción alta (default 1.2) */
    spreadAtrHighConv: number;
    /** |media(q50) − precio| < dirEpsAtr×ATR → forecast plano (default 0.05) */
    dirEpsAtr: number;
    rejectEnabled: boolean;       // default true
    /** si score SMC ≥ esto, un contra-forecast de alta convicción NO rechaza: reduce a counterMult */
    minScoreToOverrideReject: number; // default 15
    /** vivo: edad máxima del forecast cacheado (default 35min) */
    maxForecastAgeMs: number;
    /** vivo: timeout HTTP al puente (default 500ms) */
    latencyBudgetMs: number;
    bridgeUrl: string;            // default http://127.0.0.1:8788
    /** backtest: JSONL de forecasts precomputados */
    cachePath?: string;
    /** JSONL de auditoría (vivo y backtest) */
    auditPath?: string;
    /** backtest: modo colecta — registra los candle-ts de cada trigger sin filtrar */
    collectOnly?: boolean;
    collectPath?: string;
    /** F2 shadow mode: audita la decisión (con dryRun:true) pero NO la aplica —
     *  el trade sigue con riskMult intacto y REJECT no bloquea. Default false. */
    dryRun?: boolean;
    /** Fase C: TP2 dinámico por q90 del forecast (reemplaza el RR fijo tp2).
     *  'off' = tp2 fijo actual (default). 'q90' = target = q90[step]. Solo aplica
     *  si la decisión no fue degradada y el q90 queda adelante de la entrada. */
    tp2Dynamic?: 'off' | 'q90';
    /** Paso (index en el forecast) del q90 usado como TP2. Default 2 (30min en M15). */
    tp2Q90Step?: number;
    /** Opt-in only: absent preserves legacy HTTP decisions. */
    liveTransport?: 'legacy_http' | 'ram_shadow' | 'ram';
    liveModelVersion?: string;
    liveSchemaVersion?: number;
    liveRetryMs?: number;
    liveMaxAttempts?: number;
}

export const DEFAULT_TIMESFM_CONFIG: TimesfmFilterConfig = {
    enabled: false,
    horizon: 12,
    alignedMult: 1.0,
    counterMult: 0.25,
    lowConvictionMult: 0.6,
    flatMult: 0.6,
    // Medido F1 (A/B ago-2026): spread/ATR en FX majors M15 H=12 → min 2.8, mediana ≈5.3.
    // 1.2 descalibrado (nada calificaba como alta convicción). Default calibrado a la
    // mediana medida; override por ticker vía strat.params.timesfm.spreadAtrHighConv.
    spreadAtrHighConv: 5.3,
    dirEpsAtr: 0.05,
    rejectEnabled: true,
    minScoreToOverrideReject: 15,
    maxForecastAgeMs: 35 * 60 * 1000,
    latencyBudgetMs: 500,
    bridgeUrl: 'http://127.0.0.1:8788',
    dryRun: false,
    tp2Dynamic: 'off',
    tp2Q90Step: 2,
};

export type TimesfmAction = 'APPROVE' | 'REDUCE' | 'REJECT';

export interface TimesfmDecision {
    action: TimesfmAction;
    riskMult: number;
    /** 'BULL' | 'BEAR' | 'FLAT' */
    forecastDir: 'BULL' | 'BEAR' | 'FLAT';
    highConviction: boolean;
    spreadAtr: number;
    forecastMedian: number;
    reason: string;
    /** true si el filtro se saltó por degradación (puente caído / stale / sin cache) */
    degraded: boolean;
    /** Forecast completo (con q90) para Fase C (TP2 dinámico). Undefined si degradado. */
    forecast?: TimesfmForecast;
}

// ─── Núcleo puro ─────────────────────────────────────────────────────────────

export function evaluateTimesfmFilter(
    forecast: TimesfmForecast,
    signalDir: 'BUY' | 'SELL',
    currentPrice: number,
    atr14: number,
    smcPoints: number,
    cfg: TimesfmFilterConfig,
): TimesfmDecision {
    const H = Math.max(1, Math.min(cfg.horizon, forecast.q50.length, forecast.q10.length, forecast.q90.length));
    const atr = Math.max(atr14, 1e-12);

    let medianSum = 0, spreadSum = 0;
    for (let i = 0; i < H; i++) {
        medianSum += forecast.q50[i];
        spreadSum += (forecast.q90[i] - forecast.q10[i]);
    }
    const median = medianSum / H;
    const spreadAtr = (spreadSum / H) / atr;

    const delta = median - currentPrice;
    if (!Number.isFinite(median) || !Number.isFinite(spreadAtr) || !Number.isFinite(delta)) return degradedTimesfmDecision('cálculo no finito');
    const eps = cfg.dirEpsAtr * atr;
    const forecastDir: 'BULL' | 'BEAR' | 'FLAT' = delta > eps ? 'BULL' : delta < -eps ? 'BEAR' : 'FLAT';
    const highConviction = spreadAtr <= cfg.spreadAtrHighConv;

    const base = { forecastDir, highConviction, spreadAtr, forecastMedian: median, degraded: false, forecast };

    if (forecastDir === 'FLAT') {
        return { ...base, action: 'REDUCE', riskMult: cfg.flatMult, reason: `forecast plano (Δ=${delta.toFixed(5)})` };
    }
    if (!highConviction) {
        return { ...base, action: 'REDUCE', riskMult: cfg.lowConvictionMult, reason: `convicción baja (spread=${spreadAtr.toFixed(2)} ATR)` };
    }
    const aligned = (signalDir === 'BUY' && forecastDir === 'BULL') || (signalDir === 'SELL' && forecastDir === 'BEAR');
    if (aligned) {
        return { ...base, action: 'APPROVE', riskMult: cfg.alignedMult, reason: `alineado ${forecastDir} + convicción alta` };
    }
    // Contra-tendencia + alta convicción
    if (cfg.rejectEnabled && smcPoints < cfg.minScoreToOverrideReject) {
        return { ...base, action: 'REJECT', riskMult: 0, reason: `contra ${forecastDir} + convicción alta + score ${smcPoints} < ${cfg.minScoreToOverrideReject}` };
    }
    return { ...base, action: 'REDUCE', riskMult: cfg.counterMult, reason: `contra ${forecastDir} pero score fuerte (${smcPoints})` };
}

// ─── Helpers de cache (backtest) ─────────────────────────────────────────────

/**
 * Clave de lookup: ts de cierre de la ÚLTIMA vela cerrada en nowMs.
 * floor(nowMs / candleMs) * candleMs — los PING TS del CSV son ts de CIERRE de vela,
 * que coinciden con el boundary. (ceil introduciría look-ahead: NO usar.)
 */
export function timesfmCandleKey(nowMs: number, tfMinutes: number): number {
    const candleMs = tfMinutes * 60000;
    return Math.floor(nowMs / candleMs) * candleMs;
}

export function loadTimesfmCache(cachePath: string): Map<number, TimesfmForecast> {
    const map = new Map<number, TimesfmForecast>();
    if (!fs.existsSync(cachePath)) return map;
    const lines = fs.readFileSync(cachePath, 'utf8').split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const o = JSON.parse(line);
            map.set(o.ts, o as TimesfmForecast);
        } catch { /* línea corrupta: skip */ }
    }
    return map;
}

// ─── Auditoría ───────────────────────────────────────────────────────────────

export function appendTimesfmAudit(auditPath: string | undefined, rec: Record<string, unknown>): void {
    if (!auditPath) return;
    try {
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.appendFileSync(auditPath, JSON.stringify({ ...rec, auditTs: Date.now() }) + '\n');
    } catch { /* best-effort, nunca romper el flujo */ }
}

/** Real period map; never strip digits from H1/D1 or guess an unknown TF. */
export function normalizeTimesfmTf(tf: string | number): number | null {
    const map: Record<string, number> = { M1:1,M5:5,M15:15,M30:30,H1:60,H4:240,D1:1440,D:1440,W1:10080,W:10080 };
    const token = String(tf).toUpperCase();
    if (map[token]) return map[token];
    if (!/^[1-9]\d*$/.test(token)) return null;
    const n = Number(token);
    return [1,5,15,30,60,240,1440,10080].includes(n) ? n : null;
}

/** Live transport guard; optional identity keeps old valid HTTP payloads compatible.
 * Strict RAM consumers additionally require the explicit v2 close/availability envelope.
 * Historical cache loaders deliberately do not apply this live identity contract. */
export function validateTimesfmForecast(value: unknown, expected: {
    ticker: string; tfMinutes: number; nowMs: number; maxAgeMs: number;
    strict?: boolean; modelVersion?: string; schemaVersion?: number;
}): string | null {
    const f = value as TimesfmForecast & {computed_at?: number};
    if (!Number.isSafeInteger(expected.nowMs) || normalizeTimesfmTf(expected.tfMinutes)!==expected.tfMinutes || !Number.isFinite(expected.maxAgeMs) || expected.maxAgeMs<0) return 'reloj/TF/edad inválido';
    if (!f || typeof f !== 'object') return 'forecast ausente';
    // Validate the legacy field without guessing or relabelling its ts convention.
    if (f.computed_at !== undefined && (!Number.isSafeInteger(f.computed_at) || f.computed_at < f.ts || f.computed_at > expected.nowMs)) return 'computed_at inválido/futuro';
    if (!Number.isSafeInteger(f.ts) || f.ts <= 0 || f.ts > expected.nowMs) return 'timestamp inválido/futuro';
    if (expected.nowMs - f.ts > expected.maxAgeMs) return 'forecast stale';
    if (!Number.isInteger(f.horizon) || f.horizon < 1 || f.horizon > 256) return 'horizon inválido';
    const arrays = [f.q10, f.q50, f.q90];
    if (arrays.some(a => !Array.isArray(a) || a.length !== f.horizon || !a.every(x => typeof x === 'number' && Number.isFinite(x)))) return 'cuantiles inválidos';
    if (f.point !== undefined && (!Array.isArray(f.point) || f.point.length !== f.horizon || !f.point.every(Number.isFinite))) return 'point inválido';
    for (let i=0;i<f.horizon;i++) if (f.q10[i]>f.q50[i] || f.q50[i]>f.q90[i]) return 'cuantiles cruzados';
    if ((f.ticker !== undefined || expected.strict) && (typeof f.ticker !== 'string' || f.ticker.toLowerCase() !== expected.ticker.toLowerCase())) return 'ticker incorrecto';
    if ((f.tf !== undefined || expected.strict) && normalizeTimesfmTf(f.tf!) !== expected.tfMinutes) return 'TF incorrecto';
    if (expected.modelVersion !== undefined && f.model_version !== expected.modelVersion) return 'modelo incorrecto';
    if (expected.strict || f.schema_version !== undefined) {
        if (f.schema_version !== (expected.schemaVersion ?? 2) || f.timestamp_convention !== 'context_close_ms_v2') return 'schema/convenio incorrecto';
        if (f.contextCloseTimeMs !== f.ts || f.ts % (expected.tfMinutes * 60000) !== 0 || !Number.isSafeInteger(f.computedAt) || !Number.isSafeInteger(f.availableAt) || f.computedAt! < f.ts || f.availableAt! < f.computedAt! || f.availableAt! > expected.nowMs) return 'disponibilidad inválida/futura';
    }
    return null;
}

export function degradedTimesfmDecision(reason: string): TimesfmDecision {
    return { action:'APPROVE',riskMult:1,forecastDir:'FLAT',highConviction:false,spreadAtr:0,forecastMedian:0,reason:`DEGRADADO: ${reason} → filtro salteado`,degraded:true };
}

// ─── Cliente vivo ────────────────────────────────────────────────────────────

/**
 * Consulta el puente TimesFM residente y evalúa el filtro.
 * CUALQUIER falla → APPROVE 1.0 degradado (skip filtro, nunca frenar el trading).
 */
export async function fetchLiveTimesfmDecision(args: {
    ticker: string;
    tfMinutes: number;
    signalDir: 'BUY' | 'SELL';
    currentPrice: number;
    atr14: number;
    smcPoints: number;
    cfg: TimesfmFilterConfig;
}): Promise<TimesfmDecision> {
    const { ticker, tfMinutes, signalDir, currentPrice, atr14, smcPoints, cfg } = args;
    const degrade = (reason: string): TimesfmDecision => ({
        action: 'APPROVE', riskMult: 1.0, forecastDir: 'FLAT', highConviction: false,
        spreadAtr: 0, forecastMedian: 0, reason: `DEGRADADO: ${reason} → filtro salteado`, degraded: true,
    });

    let forecast: TimesfmForecast;
    try {
        const url = `${cfg.bridgeUrl}/forecast/latest?ticker=${encodeURIComponent(ticker)}&tf=${tfMinutes}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(cfg.latencyBudgetMs) });
        if (!res.ok) return degrade(`bridge HTTP ${res.status}`);
        forecast = (await res.json()) as TimesfmForecast;
    } catch (e: any) {
        return degrade(`bridge inalcanzable (${e?.name === 'TimeoutError' ? `timeout ${cfg.latencyBudgetMs}ms` : e?.message})`);
    }

    const invalid = validateTimesfmForecast(forecast, {ticker,tfMinutes,nowMs:Date.now(),maxAgeMs:cfg.maxForecastAgeMs});
    if (invalid) return degrade(invalid);
    if (!Number.isFinite(currentPrice) || !Number.isFinite(atr14) || atr14 <= 0 || !Number.isFinite(smcPoints)) return degrade('inputs inválidos');

    return evaluateTimesfmFilter(forecast, signalDir, currentPrice, atr14, smcPoints, cfg);
}

/** Merge de defaults + overrides del asset config (Firestore) o BacktestConfig. */
export function resolveTimesfmConfig(overrides?: Partial<TimesfmFilterConfig> | null): TimesfmFilterConfig {
    return { ...DEFAULT_TIMESFM_CONFIG, ...(overrides || {}) };
}

// ─── Fase C: TP2 dinámico por cuantil ─────────────────────────────────────────

/**
 * TP2 dinámico = q90[step] del forecast (target data-driven en vez de RR fijo).
 * El SL queda ESTRUCTURAL (slBuff) — por diseño acordado, el q10 NO se usa como SL.
 * Devuelve null si el target no queda adelante de la entrada (→ fallback a tp2 fijo).
 */
export function resolveTp2FromForecast(
    forecast: TimesfmForecast,
    direction: 'BUY' | 'SELL',
    entry: number,
    step: number,
): number | null {
    const arr = forecast.q90;
    if (!arr || !arr.length) return null;
    const k = Math.min(Math.max(0, Math.floor(step)), arr.length - 1);
    const target = arr[k];
    if (!Number.isFinite(target)) return null;
    if (direction === 'BUY' && target > entry) return target;
    if (direction === 'SELL' && target < entry) return target;
    return null; // q90 detrás de la entrada → el forecast no valida un TP en esta dirección
}
