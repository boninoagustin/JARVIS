import type { LogEntry, RadarState } from './backtestTypes';

/** Plan from valid distinct pre-boundary observations; never read evaluation prices.
 * The floor is elapsed time, not a certification of complete exchange bars.
 * Insufficient history remains unready in runBacktest rather than being fabricated.
 */
export function planReplayWindow(
  entries: readonly LogEntry[], evaluationStartMs: number, evaluationEndMs: number,
  policy: { warmupDays?: number; minContextObservations?: Record<string, number> } = {},
): ReplayWindowOptions {
  const minContextObservations = { ...(policy.minContextObservations ?? { '5': 60, '15': 60, '60': 60, '240': 60, D: 60 }) };
  const warmupDays = policy.warmupDays ?? 14;
  if (!Number.isFinite(warmupDays) || warmupDays < 0 || !Number.isSafeInteger(warmupDays * 86_400_000)) {
    throw new RangeError('Invalid replay warmupDays');
  }
  const window: ReplayWindowOptions = {
    warmupStartMs: Math.max(0, evaluationStartMs - warmupDays * 86_400_000),
    evaluationStartMs, evaluationEndMs, statePolicy: 'context-only-reset-execution-v1', minContextObservations,
  };
  validateReplayWindow(window);
  const times = new Map<string, Set<number>>();
  for (const entry of entries) {
    if (entry.ts >= evaluationStartMs) continue;
    const tf = contextObservationTf(entry);
    if (!tf || !(tf in minContextObservations)) continue;
    const seen = times.get(tf) ?? new Set<number>();
    seen.add(entry.ts);
    times.set(tf, seen);
  }
  for (const [tf, required] of Object.entries(minContextObservations)) {
    if (!required) continue;
    const observed = [...(times.get(tf) ?? [])].sort((a, b) => b - a);
    const earliestNeeded = observed[Math.min(required, observed.length) - 1];
    if (earliestNeeded !== undefined) window.warmupStartMs = Math.min(window.warmupStartMs, earliestNeeded);
  }
  return window;
}

export interface ReplayWindowOptions {
  warmupStartMs: number;
  evaluationStartMs: number;
  evaluationEndMs: number;
  statePolicy: 'context-only-reset-execution-v1';
  /** Distinct valid PING_PRICE observations, not guaranteed OHLC bars. */
  minContextObservations: Record<string, number>;
}

export interface ReplayDiagnostics extends ReplayWindowOptions {
  version: 1;
  warmupEvents: number;
  evaluationEvents: number;
  readiness: { ready: boolean; observations: Record<string, number>; missing: string[] };
  /** Every fold starts flat; no warmup signal, execution or risk state is inherited. */
  portfolioPolicy: 'reset-per-fold';
  boundarySnapshot?: {
    state: RadarState;
    dailyStats: Record<string, unknown>;
    orders: number;
    activeTrades: number;
  };
}

const CONTEXT_TFS = new Set(['3', '5', '15', '60', '240', 'D', 'W']);
function timestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new RangeError(`Invalid replay ${name}: expected a nonnegative safe timestamp`);
  }
}
export function validateReplayWindow(window: ReplayWindowOptions): void {
  timestamp(window.warmupStartMs, 'warmupStartMs');
  timestamp(window.evaluationStartMs, 'evaluationStartMs');
  timestamp(window.evaluationEndMs, 'evaluationEndMs');
  if (window.warmupStartMs > window.evaluationStartMs || window.evaluationStartMs >= window.evaluationEndMs) {
    throw new RangeError('Invalid replay interval: warmupStart <= evaluationStart < evaluationEnd required');
  }
  if (window.statePolicy !== 'context-only-reset-execution-v1') throw new RangeError('Invalid replay statePolicy');
  if (!window.minContextObservations || typeof window.minContextObservations !== 'object' || Array.isArray(window.minContextObservations)) {
    throw new RangeError('Invalid replay minContextObservations');
  }
  for (const [tf, n] of Object.entries(window.minContextObservations)) {
    if (!CONTEXT_TFS.has(tf) || !Number.isSafeInteger(n) || n < 0) {
      throw new RangeError(`Invalid replay observation requirement: ${tf}`);
    }
  }
}

/** Same validity predicate for planning, counting and the replay hydration path. */
export function contextObservationTf(entry: any): string | undefined {
  const p = entry?.parsed;
  if (!Number.isSafeInteger(entry?.ts) || entry.ts < 0 || entry.ts > 8_640_000_000_000_000 ||
      p?.prefix !== 'PING_PRICE' || !CONTEXT_TFS.has(p.eventTf) ||
      !Number.isFinite(p.currentPrice) || p.currentPrice <= 0) return undefined;
  // The legacy parser is intentionally permissive (parseFloat and optional
  // fields). Explicit replay must not count malformed supplied prices as bars.
  for (const [label, value] of [['Precio', p.currentPrice], ['High', p.highPrice], ['Low', p.lowPrice]] as const) {
    const supplied = typeof entry.line === 'string' ? entry.line.match(new RegExp(`(?:^|[|,])\\s*${label}:\\s*([^|,]*)`, 'i')) : null;
    if (supplied && (!supplied[1].trim() || !Number.isFinite(Number(supplied[1].trim())) || Number(supplied[1].trim()) !== value)) return undefined;
  }
  const high = p.highPrice ?? p.currentPrice;
  const low = p.lowPrice ?? p.currentPrice;
  if (!Number.isFinite(high) || !Number.isFinite(low) || low <= 0 || high < p.currentPrice || low > p.currentPrice) return undefined;
  return p.eventTf;
}
