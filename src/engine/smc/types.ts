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
}

export interface SMCEvents {
    EVENT_BOS: { direction: Direction; price: number; timestamp: number };
    EVENT_CHOCH: { direction: Direction; price: number; timestamp: number };
    EVENT_OB_CREATED: { ob: OrderBlock };
    EVENT_SWEEP: { direction: Direction; price: number; type: 'CRT' | 'TL' | 'LIQ_GRAB' | 'RANGE'; timestamp: number };
    EVENT_IFVG_CREATED: { fvg: Imbalance };
    EVENT_DIVERGENCE: { direction: Direction; type: 'Regular' | 'Hidden'; timestamp: number };
}

export interface Pivot {
    index: number;
    timestamp: number;
    price: number;
    type: 'High' | 'Low';
    isBroken: boolean;
}

export interface OrderBlock {
    id: string;
    timestamp: number;
    direction: Direction;
    top: number;
    bottom: number;
    mitigated: boolean;
    score: number;
    category: 'Platino' | 'Oro' | 'Plata' | 'Bronce' | 'CHoCH' | 'GodZone' | 'Breaker';
    merged: boolean;
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
    pivotsHigh: Pivot[];
    pivotsLow: Pivot[];
    activeOBs: OrderBlock[];
    activeFVGs: Imbalance[];
    
    // Market Structure
    currentTrend: Direction | 'Neutral';
    lastBOS?: Pivot;
    lastCHoCH?: Pivot;
    lastDivergence?: { direction: Direction; type: 'Regular' | 'Hidden'; timestamp: number };
    lastSweep?: { direction: Direction; type: string; timestamp: number };
    
    // VWAP & Liquidity
    dailyHigh?: number;
    dailyLow?: number;
    asianHigh?: number;
    asianLow?: number;
}
