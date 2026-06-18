// Tipos para el motor de backtesting standalone
export interface RadarZone {
  tf?: string; dir: 'BUY' | 'SELL'; top: number; btm: number;
  lvl?: string; medal?: string; score?: number; tp?: number; sl?: number;
  mid?: number; atr?: number; createdAt?: number;
}

export interface ScoreState {
  points: number; lastUpdate: number; events: string[];
}

export interface ImpulseLeg {
  dir: 'BUY' | 'SELL'; origin: number; extreme: number; createdAt: number;
  tp2?: number | null; oteScored?: boolean; isValidated?: boolean;
  chochPoints?: number; chochEvents?: string[]; chochReport?: string;
  bestZone?: RadarZone | null;
}

export interface RadarState {
  zones: RadarZone[]; lastPrice: number | null; previousPrice?: number | null;
  scoreBuy: ScoreState; scoreSell: ScoreState;
  marketBias: Record<string, string>;
  lastSyncDate: string | null; lastSniperAlert?: number; lastHeartbeat?: number;
  activeImpulseBuy?: ImpulseLeg | null; activeImpulseSell?: ImpulseLeg | null;
}

export interface BacktestTrade {
  id: string; timestamp: number; direction: 'BUY' | 'SELL';
  entryPrice: number; tp1Price: number; tp2Price: number; slPrice: number;
  originalSlPrice?: number;
  points: number; events: string[]; grade: string;
  result?: 'WIN' | 'LOSS' | 'BE' | 'TIMEOUT'; pnl?: number;
  resultTp1?: 'WIN' | 'LOSS' | 'TIMEOUT'; pnlTp1?: number;
  resultTp2?: 'WIN' | 'LOSS' | 'BE' | 'TIMEOUT'; pnlTp2?: number;
  tp1Hit?: boolean; closeTimestamp?: number; durationMin?: number;
  rMultiple?: number; rMultipleTp1?: number; rMultipleTp2?: number;
  oteEntryUsed?: number;
}

export interface TriggerConfig {
  enabled: boolean;
  minScore: number;
  entryPercent: number;
}

export interface OteConfig {
  enabled: boolean;
  minScore: number;
  entryPercent: number;
}

export interface SessionConfig {
  choch: TriggerConfig;
  bos: TriggerConfig;
  oteChoch?: OteConfig;
  oteBos?: OteConfig;
  slBufferPercent: number;
  fixedRR: number;
  maxSellLosses?: number;
  maxBuyLosses?: number;
}

export interface BacktestConfig {
  ticker: string;
  minBuyPoints: number;
  minSellPoints: number;
  slBufferPercent: number;
  fixedRR: number;
  oteEntryPercent: number;
  entryTrigger: 'CHOCH' | 'OTE' | 'BOTH' | 'SMART';
  
  // Session-specific triggers and scores
  sessions?: Record<string, SessionConfig>;
  
  // Killswitches
  maxDailyLossR?: number;
  dailyProfitTargetR?: number;
  maxConsecutiveLosses?: number;
  maxTradesPerDay?: number;
  trailingDrawdownR?: number;
}

export interface BacktestResult {
  trades: BacktestTrade[]; totalEvents: number; processedEvents: number;
  startDate: string; endDate: string;
}

export interface LogEntry {
  ts: number; line: string; tf: string;
}

export function emptyState(): RadarState {
  return {
    zones: [], lastPrice: null, previousPrice: null,
    scoreBuy: { points: 0, lastUpdate: 0, events: [] },
    scoreSell: { points: 0, lastUpdate: 0, events: [] },
    marketBias: { '240': 'NEUTRAL', '60': 'NEUTRAL', '15': 'NEUTRAL', '3': 'NEUTRAL' },
    lastSyncDate: null, lastSniperAlert: 0, lastHeartbeat: 0,
    activeImpulseBuy: null, activeImpulseSell: null,
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
  if (tf === '240') return '4H';
  if (tf === '60') return '1H';
  if (tf === '15') return '15M';
  if (tf === '3') return '3M';
  return `${tf}M`;
};

export const getBuffer = (ticker: string, price: number) =>
  (ticker.includes('BTC') || ticker.includes('ETH')) ? price * 0.001 : price * 0.0002;

export const getDecimals = (ticker: string) =>
  (ticker.includes('BTC') || ticker.includes('ETH') || ticker.includes('US30') || ticker.includes('NAS')) ? 2 : (ticker.includes('JPY') ? 3 : 5);
