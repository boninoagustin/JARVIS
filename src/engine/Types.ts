import { z } from 'zod';

export interface RadarZoneWire {
    d?: 'BUY'|'SELL';
    p?: number;
    b?: number;
    lv?: string;
    md?: string;
    sc?: number;
    mi?: number;
    a?: number;
    t?: string;
    mg?: number;
    kz?: boolean;
}

export interface RadarZone {
    tf?: string;
    dir: 'BUY'|'SELL';
    top: number;
    btm: number;
    lvl?: string;
    medal?: string;
    score?: number;
    mid?: number;
    atr?: number;
    tp?: number;
    sl?: number;
    createdAt?: number;
    mg?: number;
    kz?: boolean;
}

export function normalizeRadarZone(raw: any): RadarZone {
    return {
        dir: raw.d ?? raw.dir,
        top: raw.p ?? raw.top,
        btm: raw.b ?? raw.btm,
        lvl: raw.lv ?? raw.lvl,
        medal: raw.md ?? raw.medal,
        score: raw.sc ?? raw.score,
        mid: raw.mi ?? raw.mid,
        atr: raw.a ?? raw.atr,
        tf: raw.t ?? raw.tf,
        tp: raw.tp,
        sl: raw.sl,
        createdAt: raw.createdAt,
        mg: raw.mg,
        kz: raw.kz
    };
}

// Evento de scoring: los puntos YA ponderados (pts) con su timeframe (tf) y timestamp (ts).
// `id` mantiene la semántica de dedupe histórica (un id único por dirección).
export interface ScoreEvent {
    id: string;
    pts: number;
    tf: string;
    ts: number;
}

export interface ScoreState {
    // Caché derivado de los eventos vivos (se recalcula tras cada mutación);
    // los lectores externos (RadarHeatmap, snapshots) siguen leyendo este campo.
    points: number;
    lastUpdate: number;
    events: ScoreEvent[];
}

export interface ImpulseLeg {
    dir: 'BUY' | 'SELL';
    origin: number;
    extreme: number;
    createdAt: number;
    tp2?: number | null;       
    oteScored?: boolean;       
    isValidated?: boolean;     
    chochPoints?: number;
    chochEvents?: string[];
    chochReport?: string;
    bestZone?: RadarZone | null;
}

export interface RadarState {
  vwapTs?: Record<string, number>;
  biasTs?: Record<string, number>;
  tickTimes?: number[];
  densityMedian?: number;
  atr14?: number;
  atrSeed?: number;
  atrSamples?: number;
    lastSyncDate: string | null;
    zones: RadarZone[];
    zoneConfluence?: Map<RadarZone, string[]>;
    activeLocks: string[];
    lastPrice: number | null;
    previousPrice?: number | null;
    scoreBuy: ScoreState;
    scoreSell: ScoreState;
    marketBias: Record<string, string>;
    vwapStatus?: Record<string, string>;
    lastApproachAlert?: number;
    lastSniperAlert?: number;
    nextZones?: RadarZone[];     
    lastHeartbeat?: number;       
    zUp?: number;
    zDn?: number;
    activeImpulseBuy?: ImpulseLeg | null;  
    activeImpulseSell?: ImpulseLeg | null; 
    activeMacroImpulseBuy?: ImpulseLeg | null;  
    activeMacroImpulseSell?: ImpulseLeg | null; 
    lastGatillo?: { dir: 'BUY' | 'SELL'; price: number; time: number; type: string; status: string; tf?: string; };
    version?: number;
    lastModified?: number;
}

/** 🆕 Overrides de gestión por gatillo (auto-tune): se congelan en el trade al entrar */
export interface TradeMgmtOverrides {
    partialClosePct?: number;
    slAfterTp1?: 'midpoint' | 'breakeven' | 'none';
    tp15BeEnabled?: boolean;
    atrTrailEnabled?: boolean;
    structuralTrailEnabled?: boolean;
    tp1StructuralMinRR?: number;
    minimal_roi?: Record<string, number>;
}

/** Extrae los genes de gestión tuneados de un trigger config (sin undefined, Firestore-safe) */
export function extractMgmtOverrides(tfConfig: any): TradeMgmtOverrides | undefined {
    if (!tfConfig) return undefined;
    const o: any = {};
    for (const k of ['partialClosePct', 'slAfterTp1', 'tp15BeEnabled', 'atrTrailEnabled', 'structuralTrailEnabled', 'tp1StructuralMinRR', 'minimal_roi'] as const) {
        if (tfConfig[k] !== undefined) o[k] = tfConfig[k];
    }
    return Object.keys(o).length > 0 ? o : undefined;
}

export interface ActiveTrade {
    tradeId: string;
    journalId?: string;       
    ticker: string;
    direction: 'BUY' | 'SELL';
    entryPrice: number;
    tp1Price: number;         
    tp2Price: number;         
    slPrice: number;
    originalSlPrice?: number;
    targetSlPrice?: number;
    targetSlPending?: boolean;
    targetSlRetries?: number;
    tp1Hit: boolean;          
    tp2Hit: boolean;          
    slHalfwayHit?: boolean;
    timestamp: number;
    ctraderPositionId?: string;
    score: number;
    isBacktest?: boolean;
    /** 🆕 ROI time-decay: qué umbral del minimal_roi se aplicó ("30m_0.5%" o "breakeven") */
    roiDecayApplied?: string;
    /** 🏇 RIDER mode (EA31337): tras TP1+breakeven, el trade se gestiona por HTF estructural */
    managementMode?: 'SCALP' | 'RIDER';
    /** Temporalidad del Rider (ej 'H1', 'H4') — el motor HTF que decide la salida */
    riderTf?: string;
    /** 🆕 Genes de gestión tuneados por gatillo (auto-tune), congelados al entrar */
    mgmtOverrides?: TradeMgmtOverrides;
}

export interface GlobalPortfolioConfig {
    maxDailyLossR: number;
    dailyProfitTargetR: number;
    maxTradesPerDay: number;
    maxConsecutiveLosses: number;
    trailingDrawdownR: number;
    enabled: boolean;
    disabledSessions?: string[];
    assumedWinR?: number;
}

const TriggerSchema = z.object({
    enabled: z.boolean().optional(),
    minScore: z.number().optional(),
    minScoreBuy: z.number().optional(),
    minScoreSell: z.number().optional(),
    entryPercent: z.number().optional(),
    slBuff: z.number().optional(),
    tp2: z.number().optional(),
    partialClosePct: z.number().optional(),
    slAfterTp1: z.enum(['midpoint', 'breakeven', 'none']).optional(),
    tp15BeEnabled: z.boolean().optional(),
    atrTrailEnabled: z.boolean().optional(),
    structuralTrailEnabled: z.boolean().optional(),
    tp1StructuralMinRR: z.number().optional(),
    /** 🆕 ROI time-decay: {"0":0.015,"30":0.005,"60":0} → min% → at 0m/30m/60m */
    minimal_roi: z.record(z.string(), z.number()).optional(),
    /** 🏇 RIDER mode: si true, tras TP1+breakeven se transfiere gestión a HTF estructural */
    riderEnabled: z.boolean().optional(),
    /** Temporalidad del Rider (default: 'H1') */
    riderTf: z.enum(['H1', 'H4', 'D1']).optional(),
}).passthrough();

export const SessionSchema = z.object({
    choch5m: TriggerSchema.optional(),
    choch15m: TriggerSchema.optional(),
    bos5m: TriggerSchema.optional(),
    bos15m: TriggerSchema.optional(),
    oteChoch5m: TriggerSchema.optional(),
    oteChoch15m: TriggerSchema.optional(),
    oteBos5m: TriggerSchema.optional(),
    oteBos15m: TriggerSchema.optional(),
    maxSellLosses: z.number().optional(),
    maxBuyLosses: z.number().optional(),
    slBufferPercent: z.number().optional(),
    fixedRR: z.number().optional(),
    maxSmartRiskPercent: z.number().optional()
}).passthrough();

const nonNegativeNumber = z.coerce.number().refine(n => Number.isFinite(n), { message: 'Debe ser un número finito' });

export const AssetSessionConfigSchema = z.object({
    minPointsForBuy: nonNegativeNumber.optional(),
    minPointsForSell: nonNegativeNumber.optional(),
    slBufferPercent: nonNegativeNumber.optional(),
    fixedRR: nonNegativeNumber.optional(),
    oteEntryPercent: nonNegativeNumber.optional(),
    entryTrigger: z.enum(['CHOCH', 'OTE', 'BOTH', 'SMART']).optional(),
    autoTrading: z.boolean().optional(),
    maxSmartRiskPercent: nonNegativeNumber.optional(),
    enabled: z.boolean().optional(),
    maxSellsPerDay: nonNegativeNumber.optional(),
    sellScorePenalty: nonNegativeNumber.optional(),
    maxBuysPerDay: nonNegativeNumber.optional(),
    buyScorePenalty: nonNegativeNumber.optional(),
    // ⚙️ Gestión de trades por activo (parcial TP1, SL post-TP1, trailing)
    partialClosePct: nonNegativeNumber.optional(),
    slAfterTp1: z.enum(['midpoint', 'breakeven', 'none']).optional(),
    tp15BeEnabled: z.boolean().optional(),
    atrTrailEnabled: z.boolean().optional(),
    structuralTrailEnabled: z.boolean().optional(),
    tp1StructuralMinRR: nonNegativeNumber.optional(),
    /** 🆕 ROI time-decay global del activo (ej: {"0":0.015,"30":0.005,"60":0}) */
    minimal_roi: z.record(z.string(), z.number()).optional(),
    sessions: z.record(z.string(), SessionSchema).optional(),
    // 📊 Campos de portfolio por activo (guardados por AdminPanel)
    maxDailyLossR: nonNegativeNumber.optional(),
    maxConsecutiveLosses: nonNegativeNumber.optional(),
    trailingDrawdownR: nonNegativeNumber.optional(),
    dailyProfitTargetR: nonNegativeNumber.optional(),
    maxTradesPerDay: nonNegativeNumber.optional(),
    updatedAt: z.any().optional()
}).passthrough();

export type AssetSessionConfig = z.infer<typeof AssetSessionConfigSchema>;
