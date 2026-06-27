// Admin Panel Types & Constants

export interface SessionTriggerConfig {
  enabled: boolean;
  minScore: number;
  entryPercent?: number;
}

export interface SessionConfig {
  choch5m?: SessionTriggerConfig;
  choch15m?: SessionTriggerConfig;
  bos5m?: SessionTriggerConfig;
  bos15m?: SessionTriggerConfig;
  oteChoch5m?: SessionTriggerConfig;
  oteChoch15m?: SessionTriggerConfig;
  oteBos5m?: SessionTriggerConfig;
  oteBos15m?: SessionTriggerConfig;
  maxSellLosses?: number;
  maxBuyLosses?: number;
  slBufferPercent?: number;
  fixedRR?: number;
}

export interface AssetConfig {
  minPointsForBuy: number;
  minPointsForSell: number;
  slBufferPercent: number;
  fixedRR: number;
  oteEntryPercent: number;
  entryTrigger: 'CHOCH' | 'OTE' | 'BOTH' | 'SMART';
  enabled: boolean;
  maxSellsPerDay: number;
  sellScorePenalty: number;
  maxBuysPerDay: number;
  buyScorePenalty: number;
  maxTradesPerDay?: number;
  maxConsecutiveLosses?: number;
  maxDailyLossR?: number;
  dailyProfitTargetR?: number;
  trailingDrawdownR?: number;
  sessions?: Record<string, SessionConfig>;
  updatedAt?: string;
}

export interface GlobalPortfolioConfig {
  maxDailyLossR: number;
  dailyProfitTargetR: number;
  maxTradesPerDay: number;
  maxConsecutiveLosses: number;
  trailingDrawdownR: number;
  enabled: boolean;
}

export interface BotConfig {
  sniperCooldownMs: number;
  minPointsForBuy: number;
  minPointsForSell: number;
  baseRiskPercentage: number;
  slBufferPercent: number;
  fixedRR: number;
  oteEntryPercent: number;
  entryTrigger: 'CHOCH' | 'OTE' | 'BOTH' | 'SMART';
}

export const TICKERS = ['NAS100', 'BTCUSD', 'EURUSD', 'XAUUSD', 'GBPUSD'] as const;
export const SESSIONS = ['ALL', 'ASIA', 'LONDON', 'NY'] as const;
export type SessionKey = typeof SESSIONS[number];

export const SESSION_LABELS: Record<SessionKey, { label: string; emoji: string; color: string }> = {
  ALL:    { label: 'Global',  emoji: '🌍', color: '#ffaa00' },
  ASIA:   { label: 'Asia',    emoji: '🌏', color: '#7c4dff' },
  LONDON: { label: 'London',  emoji: '🇬🇧', color: '#0088ff' },
  NY:     { label: 'New York', emoji: '🇺🇸', color: '#00e676' },
};

export const DEFAULT_ASSET_CONFIG: AssetConfig = {
  minPointsForBuy: 5,
  minPointsForSell: 5,
  slBufferPercent: 0.1,
  fixedRR: 2.0,
  oteEntryPercent: 50,
  entryTrigger: 'BOTH',
  enabled: true,
  maxSellsPerDay: 0,
  sellScorePenalty: 0,
  maxBuysPerDay: 0,
  buyScorePenalty: 0,
};

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  choch5m: { enabled: true, minScore: 12 },
  choch15m: { enabled: true, minScore: 12 },
  bos5m:   { enabled: true, minScore: 12 },
  bos15m:   { enabled: true, minScore: 12 },
  oteChoch5m: { enabled: true, minScore: 8 },
  oteChoch15m: { enabled: true, minScore: 8 },
  oteBos5m:   { enabled: true, minScore: 8 },
  oteBos15m:   { enabled: true, minScore: 8 },
  maxSellLosses: 0,
  maxBuyLosses: 0,
};

export const DEFAULT_GLOBAL_PORTFOLIO: GlobalPortfolioConfig = {
  maxDailyLossR: 0,
  dailyProfitTargetR: 0,
  maxTradesPerDay: 0,
  maxConsecutiveLosses: 0,
  trailingDrawdownR: 0,
  enabled: false,
};

export const DEFAULT_BOT_CONFIG: BotConfig = {
  sniperCooldownMs: 180000,
  minPointsForBuy: 5,
  minPointsForSell: 5,
  baseRiskPercentage: 1.0,
  slBufferPercent: 0.1,
  fixedRR: 2.0,
  oteEntryPercent: 50,
  entryTrigger: 'OTE',
};
