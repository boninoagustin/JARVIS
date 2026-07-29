import * as fs from 'fs';

let content = fs.readFileSync('src/engine/smc/types.ts', 'utf8');

// OBContext
content = content.replace(
    /export interface OBContext {[^}]+}/,
`export interface OBContext {
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
}`
);

// OrderBlock category
content = content.replace(
    `category: 'Platino' | 'Oro' | 'Plata' | 'Bronce' | 'CHoCH' | 'GodZone' | 'Breaker';`,
    `category: string;`
);

// Pivot bodyMin
content = content.replace(
    `isBroken: boolean;`,
    `isBroken: boolean;
    bodyMin?: number;`
);

// SMCPreset
content = content.replace(
    `fvg_min_volume?: number;`,
    `fvg_min_volume?: number;
    fvg_min_atr?: number;
    use_body_for_ob?: boolean;
    min_ob_body_pct?: number;
    merge_tolerance_atr?: number;`
);

fs.writeFileSync('src/engine/smc/types.ts', content);
