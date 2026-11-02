import type { OHLCV, Direction, DirectionalImpulseSnapshot } from '../types.js';
import { DIRECTIONAL_SIGNAL_THRESHOLDS as T } from '../signal_profiles.js';
import { resolveDirectionalImpulseConfig, type DirectionalImpulseConfig } from '../signal_profiles.js';
export type { DirectionalImpulseSnapshot } from '../types.js';
export type { DirectionalImpulseConfig } from '../signal_profiles.js';

/** Geometry only: missing/invalid volume is neutral, never an OHLC rejection. */
export function isValidImpulseCandle(candle: OHLCV): boolean {
    return !!candle && Number.isSafeInteger(candle.timestamp) && candle.timestamp >= 0
        && [candle.open, candle.high, candle.low, candle.close, candle.high - candle.low].every(Number.isFinite)
        && candle.high >= candle.low && candle.high >= Math.max(candle.open, candle.close)
        && candle.low <= Math.min(candle.open, candle.close);
}

export function isInstitutionalDisplacement(candle: OHLCV, atr: number, direction: Direction, snapshot: DirectionalImpulseSnapshot | null, displAtrMult = .5): boolean {
    if (!isValidImpulseCandle(candle) || !Number.isFinite(atr) || atr <= 0 || !Number.isFinite(displAtrMult) || displAtrMult < 0
        || (direction !== 'Bullish' && direction !== 'Bearish')) return false;
    if (snapshot !== null && (snapshot.timestamp !== candle.timestamp || snapshot.atr !== atr
        || ![snapshot.zUp, snapshot.zDn, snapshot.upSmooth, snapshot.dnSmooth, snapshot.atrNormalizedRange, snapshot.volumeRatio].every(Number.isFinite))) return false;
    const body = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    const correctColor = direction === 'Bullish' ? candle.close > candle.open : candle.close < candle.open;
    if (!correctColor || range <= 0 || body / range < T.bodyFraction) return false;
    const directionalZ = snapshot ? (direction === 'Bullish' ? snapshot.zUp : snapshot.zDn) : 0;
    return (!!snapshot?.ready && directionalZ >= T.displZ) || body / atr >= displAtrMult;
}

export class DirectionalImpulseCalculator {
    private readonly config: Required<DirectionalImpulseConfig>;
    private snapshot: DirectionalImpulseSnapshot | null = null;
    private upSmooth = 0;
    private dnSmooth = 0;
    private readonly upHistory: number[] = [];
    private readonly dnHistory: number[] = [];
    private readonly volumeHistory: number[] = [];
    private lastInput: readonly number[] | null = null;
    private static readonly EPSILON = 1e-8;

    constructor(config: DirectionalImpulseConfig = {}) { this.config = resolveDirectionalImpulseConfig(config); }
    public get last(): DirectionalImpulseSnapshot | null { return this.snapshot; }

    public nextValue(candle: OHLCV, currentAtr: number): DirectionalImpulseSnapshot | null {
        if (!isValidImpulseCandle(candle) || !Number.isFinite(currentAtr) || currentAtr <= 0) return null;
        const volume = Number.isFinite(candle.volume) && candle.volume > 0 ? candle.volume : 0;
        const input = [candle.timestamp,candle.open,candle.high,candle.low,candle.close,volume,currentAtr];
        if (this.lastInput) {
            if (candle.timestamp < this.lastInput[0]) throw new Error('Out-of-order impulse timestamp');
            if (candle.timestamp === this.lastInput[0]) {
                if (input.every((value,index)=>value === this.lastInput![index])) return this.snapshot;
                throw new Error('Conflicting duplicate impulse candle');
            }
        }
        const range = candle.high - candle.low;
        const mid = candle.low + range / 2;
        const denominator = Math.max(currentAtr,DirectionalImpulseCalculator.EPSILON);
        // Literal user equations: directional body plus close's push beyond midpoint.
        const upRaw = (Math.max(0,candle.close-candle.open) + this.config.wickWeight*Math.max(0,candle.close-mid))/denominator;
        const dnRaw = (Math.max(0,candle.open-candle.close) + this.config.wickWeight*Math.max(0,mid-candle.close))/denominator;
        const up = this.config.decay*this.upSmooth + (1-this.config.decay)*upRaw;
        const dn = this.config.decay*this.dnSmooth + (1-this.config.decay)*dnRaw;
        const normalizedRange = range/denominator;
        let priorVolumeMean: number | null = null;
        if (this.volumeHistory.length) {
            priorVolumeMean = 0;
            for (let i=0;i<this.volumeHistory.length;i++) priorVolumeMean += (this.volumeHistory[i]-priorVolumeMean)/(i+1);
        }
        const volumeRatio = volume>0 && priorVolumeMean!==null && priorVolumeMean>0 ? volume/priorVolumeMean : 1;
        if (![upRaw,dnRaw,up,dn,normalizedRange,volumeRatio].every(Number.isFinite)) return null;
        const upHistory = [...this.upHistory,up].slice(-this.config.window);
        const dnHistory = [...this.dnHistory,dn].slice(-this.config.window);
        const zUp = this.rollingZ(upHistory), zDn = this.rollingZ(dnHistory);
        if (![zUp,zDn].every(Number.isFinite)) return null;
        const next: DirectionalImpulseSnapshot = Object.freeze({timestamp:candle.timestamp,
            sampleCount:upHistory.length,ready:upHistory.length===this.config.window,
            zUp,zDn,upSmooth:up,dnSmooth:dn,atr:currentAtr,
            atrNormalizedRange:normalizedRange,volumeRatio,priorVolumeMean});
        // Commit only after every derived field has passed finiteness checks.
        this.upSmooth=up;this.dnSmooth=dn;
        this.upHistory.splice(0,this.upHistory.length,...upHistory);
        this.dnHistory.splice(0,this.dnHistory.length,...dnHistory);
        this.volumeHistory.push(volume);
        if (this.volumeHistory.length>this.config.volWindow) this.volumeHistory.shift();
        this.lastInput=Object.freeze(input);
        this.snapshot=next;
        return next;
    }

    private rollingZ(values: readonly number[]): number {
        // Scale first: equivalent population Z, without squaring large raw values.
        const scale=values.reduce((largest,value)=>Math.max(largest,Math.abs(value)),0);
        if (scale===0) return 0;
        let mean=0,m2=0;
        for (let i=0;i<values.length;i++) {
            const x=values[i]/scale,delta=x-mean;
            mean+=delta/(i+1);m2+=delta*(x-mean);
        }
        const sigma=Math.sqrt(Math.max(0,m2/values.length));
        return sigma>DirectionalImpulseCalculator.EPSILON/scale ? (values[values.length-1]/scale-mean)/sigma : 0;
    }

    public reset(): void {
        this.snapshot=null;this.lastInput=null;this.upSmooth=0;this.dnSmooth=0;
        this.upHistory.length=0;this.dnHistory.length=0;this.volumeHistory.length=0;
    }
}
