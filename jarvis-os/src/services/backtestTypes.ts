// Tipos para el motor de backtesting standalone
import type { RadarZone, RadarState, ImpulseLeg, ScoreState } from '../../../src/engine/Types';
export type { RadarZone, RadarState, ImpulseLeg, ScoreState };

export interface BacktestTrade {
  id: string; timestamp: number; direction: 'BUY' | 'SELL';
  entryPrice: number; tp1Price: number; tp2Price: number; slPrice: number;
  originalSlPrice?: number;
  points: number; events: string[]; grade: string;
  triggerType?: 'choch15m' | 'bos15m' | 'oteChoch15m' | 'oteBos15m';
  result?: 'WIN' | 'LOSS' | 'BE' | 'TIMEOUT' | 'REVERSAL'; pnl?: number;
  resultTp1?: 'WIN' | 'LOSS' | 'TIMEOUT' | 'REVERSAL'; pnlTp1?: number;
  resultTp2?: 'WIN' | 'LOSS' | 'BE' | 'TIMEOUT' | 'REVERSAL'; pnlTp2?: number;
  tp1Hit?: boolean; tp1_5Hit?: boolean; slHalfwayHit?: boolean; closeTimestamp?: number; durationMin?: number;
  rMultiple?: number; rMultipleTp1?: number; rMultipleTp2?: number; riskMult?: number;
  oteEntryUsed?: number;
  tf?: string;
  marketBias?: Record<string, string>;
  vwapStatus?: Record<string, string>;
}

export interface BaseTriggerConfig {
  enabled: boolean;
  minScore: number;
  slBuff: number;
  tp2: number;
  partialClosePct: number;
  slAfterTp1: 'midpoint' | 'breakeven' | 'none';
  tp15BeEnabled: boolean;
  atrTrailEnabled: boolean;
  structuralTrailEnabled: boolean;
  tp1StructuralMinRR: number;
}

export interface TriggerConfig extends BaseTriggerConfig {}

export interface OteConfig extends BaseTriggerConfig {}

export interface SessionConfig {
  choch15m: TriggerConfig;
  bos15m: TriggerConfig;
  oteChoch15m?: OteConfig;
  oteBos15m?: OteConfig;
  maxSellLosses?: number;
  maxBuyLosses?: number;
}

export interface BacktestConfig {
  ticker: string;
  minBuyPoints: number;
  minSellPoints: number;
  minRR?: number; // Minimum RR required to take a trade
  oteEntryPercent: number;
  entryTrigger: 'CHOCH' | 'OTE' | 'BOTH' | 'SMART';
  
  // Session-specific triggers and scores
  sessions?: Record<string, SessionConfig>;
  sessionFilter?: string[]; // Array of allowed sessions (e.g. ['LONDON', 'NY'])
  
  // Killswitches
  maxDailyLossR?: number;
  dailyProfitTargetR?: number;
  maxConsecutiveLosses?: number;
  maxTradesPerDay?: number;
  maxTradesPerSession?: number;
  trailingDrawdownR?: number;
  
  // Realism (Spread & Commissions)
  spreadPips?: number;
  commissionPerLot?: number;
  maxHoldMin?: number;
  latencyMs?: number;
}

export interface BacktestResult {
  trades: BacktestTrade[]; totalEvents: number; processedEvents: number;
  startDate: string; endDate: string;
}

export interface ParsedAlert {
  prefix: string;
  eventTf: string;
  readableTf: string;
  currentDirection: 'BUY' | 'SELL' | null;
  trendMatch?: string | null;
  rawZones?: Record<string, unknown>[];
  currentPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  origin?: number;
  vwapUnder?: boolean;
  vwapOver?: boolean;
}

export interface LogEntry {
  ts: number; line: string; tf: string; parsed?: ParsedAlert;
}

export function emptyState(): RadarState {
  return {
    zones: [], lastPrice: null, previousPrice: null,
    scoreBuy: { points: 0, lastUpdate: 0, events: [] },
    scoreSell: { points: 0, lastUpdate: 0, events: [] },
    marketBias: { 'D': 'NEUTRAL', '240': 'NEUTRAL', '60': 'NEUTRAL', '15': 'NEUTRAL', '5': 'NEUTRAL' },
    vwapStatus: {},
    lastSyncDate: null, lastSniperAlert: 0, lastHeartbeat: 0,
    activeImpulseBuy: null, activeImpulseSell: null,
    activeMacroImpulseBuy: null, activeMacroImpulseSell: null,
    activeLocks: [],
  };
}

export function normalizeZone(raw: Record<string, unknown>): RadarZone {
  const r = { ...raw } as Record<string, unknown>;
  if (r.t !== undefined && r.tf === undefined) r.tf = r.t;
  if (r.d !== undefined && r.dir === undefined) r.dir = r.d;
  if (r.p !== undefined && r.top === undefined) r.top = r.p;
  if (r.b !== undefined && r.btm === undefined) r.btm = r.b;
  if (r.lv !== undefined && r.lvl === undefined) r.lvl = r.lv;
  if (r.md !== undefined && r.medal === undefined) r.medal = r.md;
  if (r.sc !== undefined && r.score === undefined) r.score = r.sc;
  if (r.mi !== undefined && r.mid === undefined) r.mid = r.mi;
  if (r.a !== undefined && r.atr === undefined) r.atr = r.a;
  return r as unknown as RadarZone;
}

export const parseTF = (tf: string) => {
  if (tf === 'D') return 'D';
  if (tf === '240') return '4H';
  if (tf === '60') return '1H';
  if (tf === '15') return '15M';
  if (tf === '5') return '5M';
  return `${tf}M`;
};

export const getBuffer = (ticker: string, price: number) =>
  (ticker.includes('BTC') || ticker.includes('ETH')) ? price * 0.001 : price * 0.0002;

export const getDecimals = (ticker: string) =>
  (ticker.includes('BTC') || ticker.includes('ETH') || ticker.includes('US30') || ticker.includes('NAS') || ticker.includes('XAU') || ticker.includes('GOLD')) ? 2 : (ticker.includes('JPY') ? 3 : 5);
