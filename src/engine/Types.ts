import { z } from 'zod';

export interface RadarZone {
    tf?: string;
    dir: 'BUY' | 'SELL';
    top: number;
    btm: number;
    lvl?: string;
    medal?: string;
    score?: number;
    tp?: number;
    sl?: number;
    mid?: number;
    atr?: number;
    t?: string;      
    d?: 'BUY' | 'SELL';  
    p?: number;      
    b?: number;      
    lv?: string;     
    md?: string;     
    sc?: number;     
    mi?: number;     
    a?: number;      
    createdAt?: number;
    mg?: number;
    kz?: boolean;
}

export interface ScoreState {
    points: number;
    lastUpdate: number;
    events: string[];
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
    lastSyncDate: string | null;
    zones: RadarZone[];
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
}

export interface GlobalPortfolioConfig {
    maxDailyLossR: number;
    dailyProfitTargetR: number;
    maxTradesPerDay: number;
    maxConsecutiveLosses: number;
    trailingDrawdownR: number;
    enabled: boolean;
    disabledSessions?: string[];
}

export const SessionSchema = z.object({
    choch5m: z.object({ enabled: z.boolean(), minScore: z.number().optional(), minScoreBuy: z.number().optional(), minScoreSell: z.number().optional() }).optional(),
    choch15m: z.object({ enabled: z.boolean(), minScore: z.number().optional(), minScoreBuy: z.number().optional(), minScoreSell: z.number().optional() }).optional(),
    bos5m: z.object({ enabled: z.boolean(), minScore: z.number().optional(), minScoreBuy: z.number().optional(), minScoreSell: z.number().optional() }).optional(),
    bos15m: z.object({ enabled: z.boolean(), minScore: z.number().optional(), minScoreBuy: z.number().optional(), minScoreSell: z.number().optional() }).optional(),
    oteChoch5m: z.object({ enabled: z.boolean(), minScore: z.number().optional(), minScoreBuy: z.number().optional(), minScoreSell: z.number().optional(), entryPercent: z.number().optional() }).optional(),
    oteChoch15m: z.object({ enabled: z.boolean(), minScore: z.number().optional(), minScoreBuy: z.number().optional(), minScoreSell: z.number().optional(), entryPercent: z.number().optional() }).optional(),
    oteBos5m: z.object({ enabled: z.boolean(), minScore: z.number().optional(), minScoreBuy: z.number().optional(), minScoreSell: z.number().optional(), entryPercent: z.number().optional() }).optional(),
    oteBos15m: z.object({ enabled: z.boolean(), minScore: z.number().optional(), minScoreBuy: z.number().optional(), minScoreSell: z.number().optional(), entryPercent: z.number().optional() }).optional(),
    maxSellLosses: z.number().optional(),
    maxBuyLosses: z.number().optional(),
    slBufferPercent: z.number().optional(),
    fixedRR: z.number().optional(),
    maxSmartRiskPercent: z.number().optional()
});

export const AssetSessionConfigSchema = z.object({
    minPointsForBuy: z.coerce.number().optional(),
    minPointsForSell: z.coerce.number().optional(),
    slBufferPercent: z.coerce.number().optional(),
    fixedRR: z.coerce.number().optional(),
    oteEntryPercent: z.coerce.number().optional(),
    entryTrigger: z.enum(['CHOCH', 'OTE', 'BOTH', 'SMART']).optional(),
    autoTrading: z.boolean().optional(),
    maxSmartRiskPercent: z.coerce.number().optional(),
    enabled: z.boolean().optional(),
    maxSellsPerDay: z.coerce.number().optional(),
    sellScorePenalty: z.coerce.number().optional(),
    maxBuysPerDay: z.coerce.number().optional(),
    buyScorePenalty: z.coerce.number().optional(),
    sessions: z.record(z.string(), SessionSchema).optional()
}).passthrough();

export type AssetSessionConfig = z.infer<typeof AssetSessionConfigSchema>;
