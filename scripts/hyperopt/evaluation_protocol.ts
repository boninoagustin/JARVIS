/** Temporal evaluation protocol. All bounds are UTC milliseconds, half-open. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface EvaluationManifest {
  version: 1;
  ticker: string;
  from_ms: number;
  train_end_ms: number;
  validation_end_ms: number;
  test_end_ms: number;
  test_independence: 'unverified' | 'prospective';
}
export type Partition = 'train' | 'validation' | 'test';
const fields = ['version','ticker','from_ms','train_end_ms','validation_end_ms','test_end_ms','test_independence'];

export function loadEvaluationManifest(input: string | unknown, ticker: string): EvaluationManifest {
  const m = typeof input === 'string' ? JSON.parse(readFileSync(input, 'utf8')) : input;
  if (!m || typeof m !== 'object' || Array.isArray(m) ||
      Object.keys(m).sort().join(',') !== [...fields].sort().join(','))
    throw new Error('evaluation manifest must contain exactly the version 1 fields');
  const v = m as EvaluationManifest;
  if (v.version !== 1) throw new Error('unsupported evaluation manifest version');
  if (!ticker || v.ticker !== ticker) throw new Error('evaluation manifest ticker mismatch');
  const b = [v.from_ms,v.train_end_ms,v.validation_end_ms,v.test_end_ms];
  if (b.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('bounds must be nonnegative safe integer milliseconds');
  if (!(b[0] < b[1] && b[1] < b[2] && b[2] <= b[3])) throw new Error('required from < train_end < validation_end <= test_end');
  if (!['unverified','prospective'].includes(v.test_independence)) throw new Error('invalid test_independence');
  return {...v};
}

export function generateManifest(ticker: string, fromMs: number, endMs: number): EvaluationManifest {
  return loadEvaluationManifest({version:1, ticker, from_ms:fromMs,
    train_end_ms:fromMs + Math.floor((endMs-fromMs)*0.7), validation_end_ms:endMs,
    test_end_ms:endMs, test_independence:'unverified'}, ticker);
}

export function windowBounds(m: EvaluationManifest, partition: Partition): [number,number] {
  if (partition === 'train') return [m.from_ms,m.train_end_ms];
  if (partition === 'validation') return [m.train_end_ms,m.validation_end_ms];
  if (partition === 'test') return [m.validation_end_ms,m.test_end_ms];
  throw new Error(`invalid partition: ${partition}`);
}

export function filterWindow<T extends {ts: number}>(entries: readonly T[], manifest: EvaluationManifest, partition: Partition): T[] {
  const [start,end] = windowBounds(loadEvaluationManifest(manifest, manifest.ticker), partition);
  return entries.filter(e => {
    if (!Number.isSafeInteger(e.ts) || e.ts < 0) throw new Error('invalid event timestamp');
    return e.ts >= start && e.ts < end;
  });
}

export function stableCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(stableCanonical).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableCanonical((value as any)[k])).join(',') + '}';
  }
  throw new Error('config must contain JSON values only');
}

/** Pure guard: sanitize BEFORE fingerprinting or any replay/model side effects.
 * Collection is a separate pipeline, never a fallback for a missing replay cache. */
export function readOnlyReplayConfig<T extends object>(input: T): T {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('config must be an object');
  stableCanonical(input);
  const config = JSON.parse(JSON.stringify(input));
  const tfm = config.timesfm;
  if (tfm != null) {
    if (typeof tfm !== 'object' || Array.isArray(tfm) ||
        (tfm.enabled !== undefined && typeof tfm.enabled !== 'boolean') ||
        (tfm.collectOnly !== undefined && typeof tfm.collectOnly !== 'boolean'))
      throw new Error('invalid timesfm');
    delete tfm.auditPath;
    delete tfm.collectPath;
    delete tfm.collectOnly;
    if (tfm.enabled === true && (typeof tfm.cachePath !== 'string' || !tfm.cachePath.trim()))
      throw new Error('enabled timesfm requires cachePath for read-only replay');
  }
  return config;
}

export function modelAvailability(model: any): {status: 'verified' | 'unknown'; train_end_ms?: number; available_at_ms?: number} {
  const meta = model?.meta ?? model?.metadata ?? {};
  const train = meta.train_end_ms;
  let available = meta.available_at_ms;
  if (available === undefined && typeof meta.trained_at === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(meta.trained_at)) {
    available = Date.parse(meta.trained_at);
  }
  if (!Number.isSafeInteger(train) || train < 0 || !Number.isSafeInteger(available) || available < train)
    return {status:'unknown'};
  return {status:'verified', train_end_ms:train, available_at_ms:available};
}

/** Engine forcibly labels remaining positions at its last event. Without changing
 * the engine, conservatively censor every terminal-event close (even genuine ones).
 * No fabricated labels, no future closes, no numeric zero for unknown outcomes. */
export function partitionTrades(trades: readonly any[], manifest: EvaluationManifest, partition: Partition, lastEventTs: number): any[] {
  const [start,end] = windowBounds(manifest, partition);
  return trades.filter(t => Number.isSafeInteger(t.timestamp) && t.timestamp >= start && t.timestamp < end)
    .map(t => {
      const close = t.closeTimestamp ?? t.closedAt ?? t.closeTs;
      const completed = Number.isSafeInteger(close) && close >= t.timestamp && close < end && close < lastEventTs &&
        typeof t.rMultiple === 'number' && Number.isFinite(t.rMultiple) &&
        ['WIN','LOSS','BE','TIMEOUT','REVERSAL'].includes(t.result);
      return {...t, result:completed ? t.result : null, rMultiple:completed ? t.rMultiple : null,
        closeTimestamp:completed ? close : null, closedAt:completed ? close : null, closeTs:completed ? close : null,
        label_status:completed ? 'closed' : 'censored',
        ...(completed ? {} : {resultTp1:null, resultTp2:null, pnl:null, pnlTp1:null, pnlTp2:null,
          rMultipleTp1:null, rMultipleTp2:null, durationMin:null})};
    });
}

export function configFingerprint(config: unknown): string {
  return createHash('sha256').update(stableCanonical(config)).digest('hex');
}
