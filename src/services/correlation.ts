// src/services/correlation.ts
// 🧲 Filtro de correlación cross-asset (EWMA sobre retornos log M15) — ago-2026
//
// Implementa las reglas del documento "Filtros Correlación Trading Automatizado":
//  1. ρ ≥ +threshold y direcciones OPUESTAS  → BLOQUEAR (cobertura/hedge accidental)
//  2. ρ ≤ −threshold y MISMA dirección       → BLOQUEAR (apuesta contra la gravedad estadística)
//  3. Risk-parity liviano: misma dirección sobre pares positivamente correlacionados
//     → riskMult = 1/(1+0.5·n) para no duplicar exposición USD/riesgo de clúster.
//
// MODO SHADOW (default): el gate audita la decisión en JSONL pero NO bloquea
// (paridad exacta de trading, mismo patrón que TimesFM F2 dryRun). Para activar
// el bloqueo real: asset_configs/{ticker}.correlationFilter = {shadow:false}.
//
// Alimentación: velas M15 CERRADAS vía listener de SMCManager (incluye bootstrap
// histórico en el arranque) + seed inicial desde el buffer RAM de market_data.
// λ=0.992 → half-life ≈ 86 barras M15 ≈ 21.5 h (reacciona a cambios de régimen
// en días, no semanas). Sin dependencias externas ni llamadas de red.

import fs from 'fs';
import { smcManager } from '../engine/smc/SMCManager.js';
import { getCandles } from '../db/market_data.js';

export const CORR_TICKERS = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40'];

// 🆕 16-sep-2026: set DINÁMICO — el core fijo + los activos habilitados en vivo
// (asset_configs enabled ∪ optimization_config/active_tickers, sincronizado desde
// trading.ts vía syncCorrTickers). Sin esto, un activo promovido por el Asset Scout
// quedaba fuera de la matriz: ρ vs no-core = undefined → gate degradado (fail-open).
const corrTickers = new Set<string>(CORR_TICKERS);

/** Agrega tickers al set de correlación (idempotente; el core fijo nunca se quita). */
export function syncCorrTickers(tickers: string[]): void {
    for (const t of tickers) {
        const up = String(t || '').toUpperCase();
        if (up) corrTickers.add(up);
    }
}

/** Iterable del set dinámico (para loops de covarianza y logs). */
export function getCorrTickers(): string[] {
    return [...corrTickers];
}

export interface CorrelationFilterConfig {
    enabled: boolean;    // false = filtro apagado por completo (sin auditar)
    shadow: boolean;     // true = auditar sin bloquear (dryRun)
    threshold: number;   // umbral de acoplamiento |ρ| (documento: 0.70-0.75)
    doubleThreshold: number; // umbral de DOBLE EXPOSICIÓN (mismo subyacente, ej. XTIUSD|USOIL ρ≈0.99)
    lambda: number;      // decay EWMA (0.992: half-life ~21.5h en M15)
    riskParity: boolean; // reducir riskMult en misma dirección sobre pares positivos
    auditPath: string;
}

const DEFAULT_CORR_CONFIG: CorrelationFilterConfig = {
    enabled: true,
    shadow: true,
    threshold: 0.70,
    doubleThreshold: 0.85,
    lambda: 0.992,
    riskParity: true,
    auditPath: 'logs/correlation_audit.jsonl',
};

export function resolveCorrelationConfig(overrides?: Partial<CorrelationFilterConfig> | null): CorrelationFilterConfig {
    return { ...DEFAULT_CORR_CONFIG, ...(overrides || {}) };
}

// ─── Estado EWMA en memoria ──────────────────────────────────────────────────
const lastClose = new Map<string, number>();
const lastTs = new Map<string, number>();
// Retorno de cada ticker por barra de grilla (ts M15). Permite emparejar retornos
// CONTEMPORÁNEOS entre activos sin importar el orden de llegada de los trendbars:
// cuando A cierra antes que B, B actualiza el par al cerrar usando retMap[A][ts].
const retMap = new Map<string, Map<number, number>>();
const RETMAP_MAX = 2000; // ~20 días de M15 por ticker (memoria trivial)
const cov = new Map<string, number>();   // 'A|B' (ordenado) -> cov; 'A|A' -> var
const pairKey = (a: string, b: string) => [a.toUpperCase(), b.toUpperCase()].sort().join('|');
const LAMBDA = 0.992; // half-life ≈ 86 barras M15 ≈ 21.5 h
let seededBars = 0;
let listenerRegistered = false;

function updatePair(a: string, b: string, ra: number, rb: number): void {
    const k = pairKey(a, b);
    const prev = cov.get(k) ?? 0;
    cov.set(k, LAMBDA * prev + (1 - LAMBDA) * ra * rb);
}

/** Vela M15 cerrada (viva o histórica del bootstrap): actualiza retornos y covarianzas. */
function onClosedBar(ticker: string, ts: number, close: number): void {
    const t = ticker.toUpperCase();
    const prevTs = lastTs.get(t);
    if (prevTs !== undefined && ts <= prevTs) return; // dedupe (bootstrap + seed + vivo)
    const prevClose = lastClose.get(t);
    if (prevClose !== undefined && prevClose > 0 && close > 0) {
        const r = Math.log(close / prevClose);
        // Almacenar retorno de ESTA barra de grilla
        let rm = retMap.get(t);
        if (!rm) { rm = new Map(); retMap.set(t, rm); }
        rm.set(ts, r);
        if (rm.size > RETMAP_MAX) {
            const oldest = rm.keys().next().value!;
            rm.delete(oldest);
        }
        // Varianza propia: 1 update por barra
        updatePair(t, t, r, r);
        // Covarianzas: solo con retornos de la MISMA barra de grilla (contemporáneos).
        // Si el otro activo cerró antes, su handler ya habrá encontrado este retorno
        // cuando le toque; si cerró después, lo encuentra ahora. Nunca se mezclan
        // retornos de barras distintas (eso diluía ρ a la mitad).
        for (const other of getCorrTickers()) {
            if (other === t) continue;
            const ro = retMap.get(other)?.get(ts);
            if (ro !== undefined) updatePair(t, other, r, ro);
        }
    }
    lastClose.set(t, close);
    lastTs.set(t, ts);
    seededBars++;
}

/** Correlación EWMA actual entre dos tickers (undefined si no hay datos suficientes). */
export function getCorr(a: string, b: string): number | undefined {
    const vA = cov.get(pairKey(a, a));
    const vB = cov.get(pairKey(b, b));
    const cAB = cov.get(pairKey(a, b));
    if (!Number.isFinite(vA) || !Number.isFinite(vB) || !Number.isFinite(cAB)) return undefined;
    const den = Math.sqrt(vA * vB);
    if (den <= 0) return undefined;
    return cAB / den;
}

/** Hook de diagnóstico: ingesta manual de una vela (para tests/diags fuera del proceso vivo). */
export function __ingestBarForDiag(ticker: string, ts: number, close: number): void {
    onClosedBar(ticker, ts, close);
}

/** Seed desde el buffer RAM de market_data (todas las velas M15 salvo la última en formación). */
function seedFromBuffers(): void {
    for (const t of CORR_TICKERS) {
        const bars = getCandles(t, 'M15');
        if (!bars || bars.length < 2) continue;
        // La última vela del buffer puede estar en formación: se excluye del seed.
        for (const bar of bars.slice(0, -1)) onClosedBar(t, bar.timestamp, bar.close);
    }
}

/** Inicializa el filtro: seed de buffers + listener de velas M15 cerradas del SMCManager. */
export function initCorrelationFilter(): void {
    if (listenerRegistered) return;
    listenerRegistered = true;

    seedFromBuffers();
    console.log(`[CORRELATION] 🧲 Seed inicial: ${seededBars} barras M15 ingeridas (covs calculadas).`);

    smcManager.addListener((key, candle) => {
        try {
            if (!key.endsWith(':M15')) return;
            const ticker = key.split(':')[0];
            onClosedBar(ticker, candle.timestamp, candle.close);
        } catch { /* nunca romper el flujo por el filtro de correlación */ }
    });

    logTopPairs();

    // Verificación diferida post-bootstrap: el escáner inyecta el histórico DESPUÉS
    // de este init (vía listener). A los 3 min el EWMA ya debería estar convergido.
    setTimeout(logTopPairs, 180_000);
}

/** Log de verificación: pares más acoplados + barras ingeridas. */
function logTopPairs(): void {
    const top: Array<[string, number]> = [];
    for (let i = 0; i < CORR_TICKERS.length; i++) {
        for (let j = i + 1; j < CORR_TICKERS.length; j++) {
            const rho = getCorr(CORR_TICKERS[i], CORR_TICKERS[j]);
            if (rho !== undefined && Math.abs(rho) >= 0.3) top.push([pairKey(CORR_TICKERS[i], CORR_TICKERS[j]), rho]);
        }
    }
    top.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
    console.log(`[CORRELATION] 🧲 ${seededBars} barras M15 ingeridas. Pares acoplados (|ρ|≥0.3): ${top.slice(0, 8).map(([p, r]) => `${p}=${r.toFixed(3)}`).join(' | ') || '(ninguno — aún convergiendo)'}`);
}

// ─── Gate de decisión ────────────────────────────────────────────────────────

export interface CorrelationViolation {
    otherTicker: string;
    otherDir: string;
    rho: number;
    rule: 'OPPOSITE_ON_POSITIVE' | 'SAME_ON_NEGATIVE' | 'SAME_ON_POSITIVE';
}

export interface CorrelationVerdict {
    applied: boolean;
    wouldBlock: boolean;
    blockedBy: CorrelationViolation[];
    riskMult: number;   // < 1 si hay clúster positivo en la misma dirección (risk parity)
    degraded: boolean;  // algún par sin datos → fail-open, se loguea
}

/**
 * Evalúa la señal entrante contra las posiciones abiertas de OTROS activos.
 * `openTrades`: lista {ticker, direction} de trades vivos (excluyendo el propio ticker).
 */
export function evaluateCorrelationGate(
    ticker: string,
    direction: 'BUY' | 'SELL',
    openTrades: Array<{ ticker: string; direction: string }>,
    cfg?: Partial<CorrelationFilterConfig> | null,
): CorrelationVerdict {
    const c = resolveCorrelationConfig(cfg);
    if (!c.enabled) return { applied: false, wouldBlock: false, blockedBy: [], riskMult: 1, degraded: false };

    const blockedBy: CorrelationViolation[] = [];
    let nSameDirPositive = 0;
    let degraded = false;

    for (const t of openTrades) {
        const other = String(t.ticker || '').toUpperCase();
        if (!other || other === ticker.toUpperCase()) continue;
        const rho = getCorr(ticker, other);
        if (rho === undefined) { degraded = true; continue; }

        // Regla 1: positiva fuerte + direcciones opuestas → cobertura accidental
        if (rho >= c.threshold && t.direction !== direction) {
            blockedBy.push({ otherTicker: other, otherDir: t.direction, rho, rule: 'OPPOSITE_ON_POSITIVE' });
        }
        // Regla 2: negativa fuerte + misma dirección → suma cero garantizada
        else if (rho <= -c.threshold && t.direction === direction) {
            blockedBy.push({ otherTicker: other, otherDir: t.direction, rho, rule: 'SAME_ON_NEGATIVE' });
        }
        // Regla 3 (risk parity): misma dirección sobre par positivo → clúster
        else if (rho >= c.threshold && t.direction === direction) {
            nSameDirPositive++;
            // Regla 4 (ago-2026): par casi idéntico = DOBLE EXPOSICIÓN sobre el mismo subyacente
            // (ej. XTIUSD|USOIL ρ≈0.99, ambos BUY = 2× riesgo en la misma idea). Umbral aparte
            // más estricto (doubleThreshold) para no frenar momentum normal tipo EURUSD|GBPUSD.
            if (rho >= c.doubleThreshold) {
                blockedBy.push({ otherTicker: other, otherDir: t.direction, rho, rule: 'SAME_ON_POSITIVE' });
            }
        }
    }

    const riskMult = (c.riskParity && nSameDirPositive > 0) ? 1 / (1 + 0.5 * nSameDirPositive) : 1;
    return { applied: true, wouldBlock: blockedBy.length > 0, blockedBy, riskMult, degraded };
}

/** Escribe una línea de auditoría JSONL (el formato lo decide el reporte). */
export function appendCorrelationAudit(
    auditPath: string,
    entry: Record<string, unknown>,
): void {
    try {
        fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n');
    } catch (e: any) {
        console.error('[CORRELATION] Error escribiendo audit:', e.message);
    }
}
