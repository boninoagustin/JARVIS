// src/engine/smc/types.ts

// Usamos el OHLCV de market_data o lo re-exportamos
import { OHLCV } from '../../db/market_data.js';
export { OHLCV };

import type { SignalProfile, SignalAblation, DirectionalImpulseConfig, SignalFvgConfig } from './signal_profiles.js';

export type Direction = 'Bullish' | 'Bearish';

/** Immutable per-bar diagnostics; never substituted for legacy Z-VWAP/ML. */
export interface DirectionalImpulseSnapshot {
    readonly timestamp: number;
    readonly sampleCount: number;
    readonly ready: boolean;
    readonly zUp: number;
    readonly zDn: number;
    readonly upSmooth: number;
    readonly dnSmooth: number;
    readonly atr: number;
    readonly atrNormalizedRange: number;
    readonly volumeRatio: number;
    readonly priorVolumeMean: number | null;
}

export interface StructuralSignalMetadata {
    breakTimestamp?: number;
    availableAt?: number;
    signalProfile?: SignalProfile;
}

export interface SMCPreset {
    signal_profile?: SignalProfile;
    signal_ablation?: Partial<SignalAblation>;
    signal_impulse?: DirectionalImpulseConfig;
    signal_fvg?: SignalFvgConfig;
    name: string;
    risk_level: number; // 1 (Ultra Cons) to 5 (Ultra Agre)
    asset_type: 'forex' | 'indices' | 'crypto';
    // Tolerances y configuraciones dinámicas
    override_choch: boolean;
    require_displacement: boolean;
    require_fvg_after_ob: boolean;
    strict_breaker: boolean;
    strict_sweep: boolean;
    confirm_close: boolean;
    min_score: number;
    merge_tolerance_atr?: number;
    min_ob_body_pct?: number;
    use_body_for_ob?: boolean;
    fvg_min_atr_factor?: number;
    fvg_min_atr?: number;
    wick_invalidates_ob?: boolean;
    valid_bos_displacement?: boolean;
    choch_require_sweep?: boolean;
    choch_require_momentum?: boolean;
    choch_require_bos_prior?: boolean;  // 🆕 E6: exige al menos un BOS antes de validar un CHoCH
    displ_atr_mult?: number;            // 🆕 paridad Pine: tamaño mínimo de vela de desplazamiento (x ATR)
    displ_vol_mult?: number;            // 🆕 sep-2026 (opción 4 de Bon): la vela de desplazamiento debe
                                        // tener volumen ≥ displ_vol_mult × promedio (SMA 20). 0 = off.
    
    // Engine Optimization Parameters
    max_ob_age?: number;
    pivot_len?: number;
    div_pivot_len?: number;
    rsi_len?: number;
    min_sweep_wick_pct?: number;
    crt_3candle_model?: boolean;
    crt_close_inside?: boolean;
    z_score_window?: number;
    max_active_obs?: number;
    max_ob_touches?: number;
}

export interface SMCEvents {
    EVENT_BOS: { direction: Direction; price: number; timestamp: number; crtOrigin?: boolean; isCoiled?: boolean } & StructuralSignalMetadata;
    EVENT_CHOCH: { direction: Direction; price: number; timestamp: number; crtOrigin?: boolean; isCoiled?: boolean } & StructuralSignalMetadata;
    EVENT_OB_CREATED: { ob: OrderBlock };
    EVENT_BREAKER_CREATED: { ob: OrderBlock };
    EVENT_SWEEP: { direction: Direction; price: number; sweepType: 'CRT' | 'TL' | 'LIQ_GRAB' | 'RANGE'; timestamp: number; availableAt?: number; originTimestamp?: number; signalProfile?: SignalProfile };
    EVENT_IFVG_CREATED: { fvg: Imbalance };
    EVENT_DIVERGENCE: { direction: Direction; divergenceType: 'Regular' | 'Hidden'; timestamp: number; pivotTimestamp: number; divergence?: any };
    ZONE_TOUCHED: { direction: Direction; category: string; score: number; top: number; bottom: number };
    ZONE_BROKEN: { direction: Direction; category: string; score: number; top: number; bottom: number };
}

export type SMCEvent = { [K in keyof SMCEvents]: { type: K } & SMCEvents[K] }[keyof SMCEvents];

export interface Pivot {
    availableAt?: number;
    index: number;
    timestamp: number;
    price: number;
    type: 'High' | 'Low';
    isBroken: boolean;
    bodyMin?: number;
    bodyMax?: number;
    high?: number;
    low?: number;
}

export interface OrderBlock {
    id: string;
    timestamp: number;
    direction: Direction;
    top: number;
    bottom: number;
    mitigated: boolean;
    score: number;
    category: string;
    merged: boolean;
    merge_count?: number;
    hidden?: boolean;
    ageBars?: number;
    touchCount?: number;
    alertedTouch?: boolean;
    partialMitigated?: boolean;
}

export interface Imbalance {
    availableAt?: number;
    id: string;
    timestamp: number;
    direction: Direction;
    top: number;
    bottom: number;
    originalTop?: number;
    originalBottom?: number;
    mitigated: boolean;
    is_ifvg: boolean;
}

export interface SMCState {
    directionalImpulse?: DirectionalImpulseSnapshot | null;
    currentTrend: 'Bullish' | 'Bearish' | 'Neutral';
    simpleTrend?: 'Bullish' | 'Bearish' | 'Neutral';
    pivotsHigh: Pivot[];
    pivotsLow: Pivot[];
    activeOBs: OrderBlock[];
    activeBreakers: OrderBlock[];
    activeFVGs: Imbalance[];
    
    // Market Structure
    lastBOS?: Pivot;
    lastCHoCH?: Pivot;
    lastDivergence?: { direction: Direction; type: 'Regular' | 'Hidden'; timestamp: number; pivotTimestamp: number; price: number; top?: number; bottom?: number; score?: number; rsiDiff?: number; };
    lastSweep?: { direction: Direction; type: string; timestamp: number };
    
    // VWAP & Liquidity
    dailyHigh?: number;
    dailyLow?: number;
    asianHigh?: number;
    asianLow?: number;
    atr?: number;
    vwapStatus?: 'OVER' | 'UNDER' | 'NEUTRAL';
}

export interface OBContext {
    vwapStatus?: 'OVER' | 'UNDER';
    currentTrend?: 'Bullish' | 'Bearish' | 'Neutral';
    simpleTrend?: 'Bullish' | 'Bearish' | 'Neutral';
    hasIFVGOverlap?: (top: number, bottom: number, isBull: boolean) => boolean;
    hasLiqSweep?: boolean;
    zScore?: { zUp: number; zDn: number } | null;
    htfTrend?: 'Bullish' | 'Bearish' | 'Neutral';
    weeklyBias?: 'Bullish' | 'Bearish' | 'Neutral';
    htfAligned?: (isBull: boolean) => boolean;
    isLegacy?: boolean;
    hasFvgNear?: boolean;
}
