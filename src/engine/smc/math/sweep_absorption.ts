import type { OHLCV, Direction, DirectionalImpulseSnapshot } from '../types.js';
import { DIRECTIONAL_SIGNAL_THRESHOLDS as T } from '../signal_profiles.js';
import { isValidImpulseCandle } from './directional_impulse.js';

export interface SweepImpulseInput {
    candle: OHLCV;
    sweptLevel: number;
    direction: Direction;
    currentAtr: number;
    minWickPct: number;
    snapshot: DirectionalImpulseSnapshot | null;
}
export interface SweepImpulseResult {
    accepted: boolean;
    /** Heuristic morphology, not proof of institutional participation. */
    sweepType: 'CRT' | 'LIQ_GRAB';
    score: number;
    penetrationAtr: number;
    wickPct: number;
    closeLocation: number;
    directionalZ: number;
    reason?: string;
}
const clip = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n));

export function evaluateSweepImpulse(input: SweepImpulseInput): SweepImpulseResult {
    const { candle: c, sweptLevel, direction, currentAtr: atr, minWickPct, snapshot } = input;
    const rejected: SweepImpulseResult = { accepted: false, sweepType: 'CRT', score: 0, penetrationAtr: 0, wickPct: 0, closeLocation: 0, directionalZ: 0, reason: 'invalid_or_unavailable_input' };
    if (!isValidImpulseCandle(c) || c.high <= c.low || !Number.isFinite(atr) || atr <= 0
        || !Number.isFinite(sweptLevel) || !Number.isFinite(minWickPct) || minWickPct <= 0 || minWickPct > 1
        || (direction !== 'Bullish' && direction !== 'Bearish')
        || !snapshot || snapshot.ready !== true || snapshot.timestamp !== c.timestamp || snapshot.atr !== atr
        || ![snapshot.zUp, snapshot.zDn, snapshot.upSmooth, snapshot.dnSmooth, snapshot.atrNormalizedRange, snapshot.volumeRatio].every(Number.isFinite)
        || !Number.isInteger(snapshot.sampleCount) || snapshot.sampleCount < 1 || snapshot.volumeRatio <= 0) return rejected;
    const bullish = direction === 'Bullish';
    const range = c.high - c.low;
    const wickPct = (bullish ? Math.min(c.open, c.close) - c.low : c.high - Math.max(c.open, c.close)) / range;
    const closeLocation = (bullish ? c.close - c.low : c.high - c.close) / range;
    const penetrationAtr = (bullish ? sweptLevel - c.low : c.high - sweptLevel) / atr;
    const directionalZ = bullish ? snapshot!.zUp : snapshot!.zDn;
    const volumeFactor = Number.isFinite(c.volume) && c.volume > 0 ? clip(.85 + .15 * snapshot!.volumeRatio, .85, 1.25) : 1;
    const score = (.4 * Math.min(2, range / (T.sweepRangeScaleAtr * atr)) + .35 * (wickPct / minWickPct) + .25 * clip((directionalZ + .5) / 1.5, 0, 2)) * volumeFactor;
    const reclaimed = bullish ? c.low < sweptLevel && c.close > sweptLevel : c.high > sweptLevel && c.close < sweptLevel;
    const accepted = reclaimed && penetrationAtr >= T.sweepMinPenAtr && penetrationAtr <= T.sweepMaxPenAtr
        && ((wickPct >= minWickPct && closeLocation >= .5) || (closeLocation >= T.reclaimClose && directionalZ >= T.reclaimZ))
        && score >= T.sweepScore;
    return { accepted, sweepType: wickPct >= .6 && range >= .5 * atr ? 'LIQ_GRAB' : 'CRT', score, penetrationAtr, wickPct, closeLocation, directionalZ };
}
