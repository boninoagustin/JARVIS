// src/engine/smc/types.ts

// Usamos el OHLCV de market_data o lo re-exportamos
import { OHLCV } from '../../db/market_data.js';
export { OHLCV };

export type Direction = 'Bullish' | 'Bearish';

export interface SMCPreset {
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
    
    // Engine Optimization Parameters
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
    EVENT_BOS: { direction: Direction; price: number; timestamp: number };
    EVENT_CHOCH: { direction: Direction; price: number; timestamp: number };
    EVENT_OB_CREATED: { ob: OrderBlock };
    EVENT_SWEEP: { direction: Direction; price: number; type: 'CRT' | 'TL' | 'LIQ_GRAB' | 'RANGE'; timestamp: number };
    EVENT_IFVG_CREATED: { fvg: Imbalance };
    EVENT_DIVERGENCE: { direction: Direction; divergenceType: 'Regular' | 'Hidden'; timestamp: number; divergence?: any };
    ZONE_TOUCHED: { direction: Direction; category: string; score: number; top: number; bottom: number };
    ZONE_BROKEN: { direction: Direction; category: string; score: number; top: number; bottom: number };
}

export interface Pivot {
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
    id: string;
    timestamp: number;
    direction: Direction;
    top: number;
    bottom: number;
    mitigated: boolean;
    is_ifvg: boolean;
}

export interface SMCState {
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
    lastDivergence?: { direction: Direction; type: 'Regular' | 'Hidden'; timestamp: number; price: number; top?: number; bottom?: number; score?: number; rsiDiff?: number; };
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
