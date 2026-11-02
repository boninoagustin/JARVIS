// src/engine/TickFlow.ts
// 🌊 TICK FLOW — Analítica de micro-estructura sobre ticks spot de cTrader
//
// Antes de la migración SMC nativa esto era físicamente imposible: TradingView
// solo entregaba velas cerradas. Ahora que los ticks llegan en proceso, este
// módulo mantiene por ticker:
//
//   - Ring buffer pre-asignado (Float64Array, cero alocación en estado
//     estacionario) con los últimos N ticks (ts, bid, ask).
//   - Tick Velocity: EWMA del tiempo entre llegadas + z-score normalizado por
//     hora del día (Welford en 24 buckets UTC) — 10 ticks/s es pánico en Asia
//     y ruido en NY, hay que medir contra la misma sesión.
//   - Spread: EWMA limpia (sin rollover/outliers) + cotización bilateral fresca
//     y detector de anomalía usado como kill-switch de micro-estructura.
//   - Clasificador de sweeps: dado un nivel barrido, mira hacia atrás en el
//     ring buffer y evalúa velocidad de ruptura, failure-to-progress
//     (absorción) y time-to-reclaim para distinguir barrido institucional
//     de retail ANTES de que cierre la vela.
//
// Todo es O(1) por tick y sin GC pressure: los buffers se asignan una vez por
// ticker y se reutilizan circularmente.

import { isRolloverBaselineWindow, isRolloverSpreadWithinLimit } from './RolloverSpreadGate.js';

const RING_CAPACITY = 8192;           // ~últimos minutos de ticks por ticker
const MAX_LOOKBACK_MS = 120_000;      // ventana máxima del clasificador de sweeps
const INTERARRIVAL_EWMA_ALPHA = 0.15; // suavizado de tick velocity
const SPREAD_EWMA_ALPHA = 0.05;       // spread estructural (lento)
const MIN_SPREAD_SAMPLES = 100;       // no disparar kill-switch sin historia
const MAX_QUOTE_AGE_MS = 10_000;      // no reutilizar cotizaciones obsoletas
const MAX_BASELINE_SPREAD_MULT = 1.65; // mismo límite de normalización que rollover gate

export interface BootstrapSpreadConfig {
    baseSpreadPrice: number;
    pipSize: number;
    /** Independent, previously clean reference; never the first live spread. */
    cleanBaseline?: number;
}

function defaultBootstrapLimit(ticker: string): number {
    // Pure FX fallback only, including suffixed test/broker aliases. Other asset
    // classes require explicit price-unit config from the service (no universal
    // raw-price cap, no DB/FrictionModel import into this pure module).
    const fx = /^(USD|EUR|GBP|JPY|AUD|NZD|CAD|CHF|CNH|CNY|SGD|HKD|NOK|SEK|MXN|ZAR|TRY|PLN){2}(?:$|[-._])/;
    if (!fx.test(ticker.toUpperCase())) return 0;
    const pip = ticker.slice(3, 6).toUpperCase() === 'JPY' ? 0.01 : 0.0001;
    return (0.1 + 0.8) * pip;
}

export interface TickVelocity {
    ticksPerSec: number;
    zScore: number;          // vs misma hora del día (UTC), Welford
    samples: number;
}

/** Observed tickflow/interarrival-ewma-z/utc-hour/v1 baseline, never legacy fallback. */
export interface TickVelocitySnapshot extends TickVelocity {
    observedAtMs: number;
    availableAtMs: number;
    baselineHourUtc: number;
    /** Population variance m2/n of real inter-arrivals in this UTC-hour bucket, ms^2.
     * Inherited samples is its actual interval count (>50), not a readiness default. */
    baselineVarianceMs2: number;
}

export interface SpreadSnapshot {
    bid: number;
    ask: number;
    ts: number;
    ageMs: number;
    samples: number;
    spread: number;
    baselineSpread: number | null;
}

export type SweepClass = 'INSTITUTIONAL' | 'RETAIL' | 'UNKNOWN';

export interface SweepAnalysis {
    classification: SweepClass;
    breachVelocityZ: number | null;  // z-score de velocidad alrededor de la ruptura
    maxProgressTicks: number | null; // cuánto progresó más allá del nivel (en spreads)
    reclaimMs: number | null;        // tiempo en reclamar el nivel
    impactPerTick: number | null;    // proxy de Kyle's lambda: |Δprecio| por tick
    reason: string;
}

interface WelfordBucket {
    n: number;
    mean: number;
    m2: number;
}

interface TickerFlow {
    ts: Float64Array;
    bid: Float64Array;
    ask: Float64Array;
    head: number;          // próxima posición de escritura
    count: number;         // ticks válidos (saturado en RING_CAPACITY)
    lastTs: number;
    lastEventTs: number;   // incluye parciales: no resucitar una quote invalidada
    interArrivalEwma: number;   // ms entre ticks (EWMA)
    spreadEwma: number;         // spread estructural (EWMA)
    spreadSamples: number;
    quote: { bid: number; ask: number; ts: number };
    quoteValid: boolean;
    hourly: WelfordBucket[];    // Welford de inter-arrival por hora UTC (24)
}

function createFlow(): TickerFlow {
    return {
        ts: new Float64Array(RING_CAPACITY),
        bid: new Float64Array(RING_CAPACITY),
        ask: new Float64Array(RING_CAPACITY),
        head: 0,
        count: 0,
        lastTs: 0,
        lastEventTs: 0,
        interArrivalEwma: 0,
        spreadEwma: 0,
        spreadSamples: 0,
        quote: { bid: NaN, ask: NaN, ts: 0 },
        quoteValid: false,
        hourly: Array.from({ length: 24 }, () => ({ n: 0, mean: 0, m2: 0 })),
    };
}

class TickFlowEngine {
    private flows = new Map<string, TickerFlow>();
    private bootstrapLimits = new Map<string, number>();
    private normalizationFloors = new Map<string, number>();

    /** Configure before quotes. All values are price units, normalized per asset. */
    public configureBootstrapSpread(ticker: string, config: BootstrapSpreadConfig): void {
        const { baseSpreadPrice, pipSize, cleanBaseline } = config;
        if (!Number.isFinite(baseSpreadPrice) || baseSpreadPrice < 0
            || !Number.isFinite(pipSize) || pipSize <= 0
            || (cleanBaseline !== undefined && (!Number.isFinite(cleanBaseline) || cleanBaseline <= 0))) {
            throw new Error('Invalid independent bootstrap spread reference');
        }
        const floor = baseSpreadPrice + 0.8 * pipSize;
        this.normalizationFloors.set(ticker, floor);
        this.bootstrapLimits.set(ticker, Math.max(floor, 1.65 * (cleanBaseline ?? 0)));
    }

    /**
     * Registra un tick spot. Llamar una sola vez por tick (no por temporalidad).
     * Un Bid válido sin Ask conserva analítica de ticks pero invalida la quote.
     * Eventos atrasados o timestamps inválidos se ignoran completamente.
     */
    public onTick(ticker: string, ts: number, bid: number, ask: number, options: { bidTick?: boolean; quoteTs?: number } = {}): void {
        if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(new Date(ts).getTime())) return;
        let f = this.flows.get(ticker);
        if (f && ts < f.lastEventTs) return;
        if (f) { f.quoteValid = false; f.lastEventTs = ts; }
        if (!Number.isFinite(bid) || bid <= 0) return;
        if (!f) { f = createFlow(); this.flows.set(ticker, f); }
        f.lastEventTs = ts;

        // Inter-arrival + velocidad (normalizada por hora del día)
        if (options.bidTick !== false && f.lastTs > 0) {
            const dt = ts - f.lastTs;
            if (dt > 0 && dt < 60_000) { // ignorar gaps de desconexión
                f.interArrivalEwma = f.interArrivalEwma === 0
                    ? dt
                    : f.interArrivalEwma + INTERARRIVAL_EWMA_ALPHA * (dt - f.interArrivalEwma);

                const bucket = f.hourly[new Date(ts).getUTCHours()];
                bucket.n += 1;
                const delta = dt - bucket.mean;
                bucket.mean += delta / bucket.n;
                bucket.m2 += delta * (dt - bucket.mean);
            }
        }
        if (options.bidTick !== false) f.lastTs = ts;

        // No aprender spreads extremos: un episodio prolongado no debe
        // convertirse en la referencia contra la cual se mide a sí mismo.
        const quoteTs = options.quoteTs ?? ts;
        if (Number.isFinite(ask) && ask > bid && Number.isFinite(quoteTs)
            && quoteTs > 0 && quoteTs <= ts && ts - quoteTs <= MAX_QUOTE_AGE_MS) {
            const spread = ask - bid;
            f.quote.bid = bid;
            f.quote.ask = ask;
            f.quote.ts = quoteTs;
            f.quoteValid = true;
            // Until 100 accepted samples, a provisional EWMA is not evidence.
            // Use only an independent bound so an anomalous first tick neither
            // seeds a wide baseline nor permanently locks out later clean ticks.
            const limit = f.spreadSamples < MIN_SPREAD_SAMPLES
                ? (this.bootstrapLimits.get(ticker) ?? defaultBootstrapLimit(ticker))
                : Math.max(MAX_BASELINE_SPREAD_MULT * f.spreadEwma,
                    this.normalizationFloors.get(ticker) ?? defaultBootstrapLimit(ticker));
            const clean = isRolloverSpreadWithinLimit(spread, limit, bid, ask);
            if (clean
                && !isRolloverBaselineWindow(ticker, ts)) {
                f.spreadEwma = f.spreadEwma === 0
                    ? spread
                    : f.spreadEwma + SPREAD_EWMA_ALPHA * (spread - f.spreadEwma);
                f.spreadSamples += 1;
            }
        }

        // Ask-only may complete a quote with a cached Bid, but is not a Bid
        // observation for velocity, ring history or new sweep breaches.
        if (options.bidTick === false) return;

        // Ring buffer
        f.ts[f.head] = ts;
        f.bid[f.head] = bid;
        // Preservar ticks Bid reales para sweeps/velocidad, sin inventar Ask.
        f.ask[f.head] = Number.isFinite(ask) && ask >= bid ? ask : NaN;
        f.head = (f.head + 1) % RING_CAPACITY;
        if (f.count < RING_CAPACITY) f.count += 1;
    }

    /** Unknown broker time invalidates execution evidence, not Bid/history clocks. */
    public invalidateQuote(ticker: string): void {
        const f = this.flows.get(ticker);
        if (f) f.quoteValid = false;
    }

    /** Inter-arrival z-score (fast ticks are negative), using the decision UTC hour. */
    public getTickVelocity(ticker: string, nowMs?: number): TickVelocity | null {
        const f = this.flows.get(ticker);
        if (!f || f.interArrivalEwma === 0) return null;
        const decisionMs = nowMs ?? Date.now();
        // An in-memory aggregate cannot reconstruct history after it has consumed
        // future observations. Keep the original one-argument contract unchanged.
        if (nowMs !== undefined && (!Number.isFinite(nowMs)
            || !Number.isFinite(new Date(decisionMs).getTime())
            || decisionMs < f.lastEventTs)) return null;
        const bucket = f.hourly[new Date(decisionMs).getUTCHours()];
        let z = 0;
        if (bucket.n > 50) {
            const sigma = Math.sqrt(bucket.m2 / bucket.n);
            if (sigma > 0) z = (f.interArrivalEwma - bucket.mean) / sigma;
        }
        return { ticksPerSec: 1000 / f.interArrivalEwma, zScore: z, samples: bucket.n };
    }

    /** Timestamped input for the opt-in regime extractor; missing/stale is unknown. */
    public getTickVelocitySnapshot(ticker: string, nowMs: number, maxAgeMs = MAX_QUOTE_AGE_MS):
        TickVelocitySnapshot | null {
        const f = this.flows.get(ticker);
        if (!f || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
            || !Number.isFinite(nowMs) || nowMs < f.lastEventTs
            || nowMs - f.lastTs > maxAgeMs) return null;
        const velocity = this.getTickVelocity(ticker, nowMs);
        if (!velocity) return null;
        const baselineHourUtc = new Date(nowMs).getUTCHours();
        const bucket = f.hourly[baselineHourUtc];
        const baselineVarianceMs2 = bucket.m2 / bucket.n;
        if (bucket.n <= 50 || !Number.isFinite(baselineVarianceMs2) || baselineVarianceMs2 <= 0) return null;
        return { ...velocity, observedAtMs: f.lastTs, availableAtMs: f.lastEventTs,
            baselineHourUtc, baselineVarianceMs2 };
    }

    /** Quote bilateral positiva <=10s; baseline null hasta 100 muestras limpias. */
    public getSpreadSnapshot(ticker: string, nowMs = Date.now()): SpreadSnapshot | null {
        const f = this.flows.get(ticker);
        if (!f || !f.quoteValid) return null;
        const ageMs = nowMs - f.quote.ts;
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_QUOTE_AGE_MS) return null;
        return {
            ...f.quote,
            ageMs,
            samples: f.spreadSamples,
            spread: f.quote.ask - f.quote.bid,
            baselineSpread: this.getStructuralSpread(ticker),
        };
    }

    /** Spread bilateral fresco, o null si no hay evidencia ejecutable. */
    public getSpread(ticker: string, nowMs = Date.now()): number | null {
        return this.getSpreadSnapshot(ticker, nowMs)?.spread ?? null;
    }

    /** EWMA limpia persistente. Null antes de 100 muestras aceptadas. */
    public getStructuralSpread(ticker: string): number | null {
        const f = this.flows.get(ticker);
        if (!f || f.spreadSamples < MIN_SPREAD_SAMPLES) return null;
        return f.spreadEwma;
    }

    /**
     * Kill-switch de micro-estructura: spread actual anormalmente ancho
     * (probable noticia o iliquidez). Requiere historia suficiente.
     */
    public isSpreadAnomalous(ticker: string, mult = 3, nowMs = Date.now()): boolean {
        const f = this.flows.get(ticker);
        if (!f || f.spreadSamples < MIN_SPREAD_SAMPLES || f.spreadEwma <= 0) return false;
        const current = this.getSpread(ticker, nowMs);
        if (current === null) return false;
        return current > mult * f.spreadEwma;
    }

    /**
     * Clasifica un barrido de liquidez mirando los ticks RECIENTES (máx 2 min).
     * Para Dir 'BUY' (grab de sell-side liquidity): el nivel se barrió hacia
     * abajo (bid < level) y se espera reclaim alcista. Para 'SELL', espejo.
     *
     * Institucional = ruptura veloz + el precio NO progresa más allá del nivel
     * (absorción) + reclaim rápido. Retail = ruptura que progresa y no reclama.
     */
    public analyzeSweep(ticker: string, level: number, direction: 'BUY' | 'SELL', nowMs = Date.now()): SweepAnalysis {
        const none = (reason: string): SweepAnalysis => ({
            classification: 'UNKNOWN', breachVelocityZ: null, maxProgressTicks: null,
            reclaimMs: null, impactPerTick: null, reason,
        });

        const f = this.flows.get(ticker);
        if (!f || f.count < 20) return none('sin ticks suficientes');
        if (!Number.isFinite(level) || level <= 0) return none('nivel inválido');

        const isBuy = direction === 'BUY';
        const breached = (px: number) => (isBuy ? px < level : px > level);
        const reclaimed = (px: number) => (isBuy ? px >= level : px <= level);
        const excursion = (px: number) => (isBuy ? level - px : px - level);

        // Recorrer hacia atrás hasta MAX_LOOKBACK_MS buscando la ruptura más reciente
        let breachIdx = -1;
        let checked = 0;
        for (let i = 1; i <= f.count; i++) {
            const idx = (f.head - i + RING_CAPACITY) % RING_CAPACITY;
            const ts = f.ts[idx];
            if (nowMs - ts > MAX_LOOKBACK_MS) break;
            checked++;
            if (breached(f.bid[idx])) { breachIdx = idx; break; }
        }
        if (breachIdx === -1) return none('ningún tick perforó el nivel en 2 min');

        const breachTs = f.ts[breachIdx];
        const spread = f.spreadEwma > 0 ? f.spreadEwma : level * 0.0001;

        // Velocidad alrededor de la ruptura: inter-arrival medio en ±10 ticks
        let dtSum = 0, dtN = 0;
        for (let i = Math.max(0, breachIdx - 10); i < Math.min(breachIdx + 10, RING_CAPACITY); i++) {
            const next = (i + 1) % RING_CAPACITY;
            const dt = f.ts[next] - f.ts[i];
            if (dt > 0 && dt < 60_000) { dtSum += dt; dtN++; }
        }
        let breachVelocityZ: number | null = null;
        if (dtN > 3) {
            const localMean = dtSum / dtN;
            const bucket = f.hourly[new Date(breachTs).getUTCHours()];
            if (bucket.n > 50) {
                const sigma = Math.sqrt(bucket.m2 / bucket.n);
                if (sigma > 0) breachVelocityZ = (localMean - bucket.mean) / sigma;
            }
        }

        // Failure-to-progress + time-to-reclaim desde la ruptura hacia adelante
        let maxExcursion = 0;
        let reclaimMs: number | null = null;
        let sumAbsDelta = 0, fwdTicks = 0;
        let prevBid = f.bid[breachIdx];
        for (let i = 1; i < f.count; i++) {
            const idx = (breachIdx + i) % RING_CAPACITY;
            if (idx === f.head) break;
            const ts = f.ts[idx];
            if (ts <= breachTs || ts > nowMs) continue;
            const px = f.bid[idx];
            sumAbsDelta += Math.abs(px - prevBid);
            prevBid = px;
            fwdTicks++;
            if (reclaimMs === null && reclaimed(px)) reclaimMs = ts - breachTs;
            if (breached(px)) {
                const exc = excursion(px);
                if (exc > maxExcursion) maxExcursion = exc;
            }
        }

        const maxProgressTicks = maxExcursion / spread; // en unidades de spread
        const impactPerTick = fwdTicks > 0 ? sumAbsDelta / fwdTicks : null;

        const failedToProgress = maxProgressTicks < 3;
        const reclaimedFast = reclaimMs !== null && reclaimMs < 60_000;
        const fastBreach = breachVelocityZ !== null && breachVelocityZ < -1.5; // inter-arrival bajo = ticks rápidos

        let classification: SweepClass = 'RETAIL';
        if (reclaimedFast && (failedToProgress || fastBreach)) classification = 'INSTITUTIONAL';

        return {
            classification,
            breachVelocityZ,
            maxProgressTicks,
            reclaimMs,
            impactPerTick,
            reason: `progress=${maxProgressTicks.toFixed(1)}sp reclaim=${reclaimMs ?? '∞'}ms velZ=${breachVelocityZ?.toFixed(2) ?? 'n/a'}`,
        };
    }
}

export const tickFlow = new TickFlowEngine();
