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
//   - Spread: EWMA + detector de anomalía (spread actual > k × EWMA) usado
//     como kill-switch de micro-estructura (probable noticia).
//   - Clasificador de sweeps: dado un nivel barrido, mira hacia atrás en el
//     ring buffer y evalúa velocidad de ruptura, failure-to-progress
//     (absorción) y time-to-reclaim para distinguir barrido institucional
//     de retail ANTES de que cierre la vela.
//
// Todo es O(1) por tick y sin GC pressure: los buffers se asignan una vez por
// ticker y se reutilizan circularmente.

const RING_CAPACITY = 8192;           // ~últimos minutos de ticks por ticker
const MAX_LOOKBACK_MS = 120_000;      // ventana máxima del clasificador de sweeps
const INTERARRIVAL_EWMA_ALPHA = 0.15; // suavizado de tick velocity
const SPREAD_EWMA_ALPHA = 0.05;       // spread estructural (lento)
const MIN_SPREAD_SAMPLES = 100;       // no disparar kill-switch sin historia

export interface TickVelocity {
    ticksPerSec: number;
    zScore: number;          // vs misma hora del día (UTC), Welford
    samples: number;
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
    interArrivalEwma: number;   // ms entre ticks (EWMA)
    spreadEwma: number;         // spread estructural (EWMA)
    spreadSamples: number;
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
        interArrivalEwma: 0,
        spreadEwma: 0,
        spreadSamples: 0,
        hourly: Array.from({ length: 24 }, () => ({ n: 0, mean: 0, m2: 0 })),
    };
}

class TickFlowEngine {
    private flows = new Map<string, TickerFlow>();

    /**
     * Registra un tick spot. Llamar una sola vez por tick (no por temporalidad).
     * `ask` puede ser NaN si el broker no lo incluye en el SpotEvent.
     */
    public onTick(ticker: string, ts: number, bid: number, ask: number): void {
        if (!Number.isFinite(bid) || bid <= 0) return;
        let f = this.flows.get(ticker);
        if (!f) { f = createFlow(); this.flows.set(ticker, f); }

        // Inter-arrival + velocidad (normalizada por hora del día)
        if (f.lastTs > 0) {
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
        f.lastTs = ts;

        // Spread estructural
        if (Number.isFinite(ask) && ask > bid) {
            const spread = ask - bid;
            f.spreadEwma = f.spreadEwma === 0
                ? spread
                : f.spreadEwma + SPREAD_EWMA_ALPHA * (spread - f.spreadEwma);
            f.spreadSamples += 1;
        }

        // Ring buffer
        f.ts[f.head] = ts;
        f.bid[f.head] = bid;
        f.ask[f.head] = ask;
        f.head = (f.head + 1) % RING_CAPACITY;
        if (f.count < RING_CAPACITY) f.count += 1;
    }

    /** Velocidad actual de ticks y su z-score contra la misma hora UTC. */
    public getTickVelocity(ticker: string): TickVelocity | null {
        const f = this.flows.get(ticker);
        if (!f || f.interArrivalEwma === 0) return null;
        const bucket = f.hourly[new Date().getUTCHours()];
        let z = 0;
        if (bucket.n > 50) {
            const sigma = Math.sqrt(bucket.m2 / bucket.n);
            if (sigma > 0) z = (f.interArrivalEwma - bucket.mean) / sigma;
        }
        return { ticksPerSec: 1000 / f.interArrivalEwma, zScore: z, samples: bucket.n };
    }

    /** Spread instantáneo (último tick con ask válido), o null si no hay datos. */
    public getSpread(ticker: string): number | null {
        const f = this.flows.get(ticker);
        if (!f || f.count === 0) return null;
        for (let i = 1; i <= Math.min(f.count, 50); i++) {
            const idx = (f.head - i + RING_CAPACITY) % RING_CAPACITY;
            const ask = f.ask[idx];
            if (Number.isFinite(ask) && ask > f.bid[idx]) return ask - f.bid[idx];
        }
        return null;
    }

    /** Spread estructural (EWMA lento). Null si aún no hay historia. */
    public getStructuralSpread(ticker: string): number | null {
        const f = this.flows.get(ticker);
        if (!f || f.spreadSamples < MIN_SPREAD_SAMPLES) return null;
        return f.spreadEwma;
    }

    /**
     * Kill-switch de micro-estructura: spread actual anormalmente ancho
     * (probable noticia o iliquidez). Requiere historia suficiente.
     */
    public isSpreadAnomalous(ticker: string, mult = 3): boolean {
        const f = this.flows.get(ticker);
        if (!f || f.spreadSamples < MIN_SPREAD_SAMPLES || f.spreadEwma <= 0) return false;
        const current = this.getSpread(ticker);
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
