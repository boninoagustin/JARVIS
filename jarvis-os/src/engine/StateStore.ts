import type { ActiveTrade, RadarState, AssetSessionConfig, GlobalPortfolioConfig } from './Types.js';

export const activeTrades = new Map<string, ActiveTrade>();
export const localRadarStates = new Map<string, RadarState>();
export const lastFirebaseSave = new Map<string, number>();

export let lastPingTime = 0;
export const setLastPingTime = (time: number) => { lastPingTime = time; };

export let consecutiveLosses = 0;
export const setConsecutiveLosses = (val: number) => { consecutiveLosses = val; };

export let streakKillswitchUntil = 0;
export const setStreakKillswitchUntil = (val: number) => { streakKillswitchUntil = val; };

export let vixKillswitchUntil = 0;
export const setVixKillswitchUntil = (val: number) => { vixKillswitchUntil = val; };

export let globalKillswitches: Record<string, boolean> = {};
export const setGlobalKillswitches = (val: Record<string, boolean>) => { globalKillswitches = val; };

export let globalPortfolioConfig: GlobalPortfolioConfig = {
    maxDailyLossR: 0,
    dailyProfitTargetR: 0,
    maxTradesPerDay: 0,
    maxConsecutiveLosses: 0,
    trailingDrawdownR: 0,
    enabled: false,
    disabledSessions: []
};
export const setGlobalPortfolioConfig = (val: GlobalPortfolioConfig) => { globalPortfolioConfig = val; };

export let globalPortfolioKillswitchUntil = 0;
export const setGlobalPortfolioKillswitchUntil = (val: number) => { globalPortfolioKillswitchUntil = val; };

export let dynamicBotConfig = {
    sniperCooldownMs: 180000,
    minPointsForBuy: 5,
    minPointsForSell: 5,
    baseRiskPercentage: 1.0,
    slBufferPercent: 0.1,
    fixedRR: 2.0,
    oteEntryPercent: 50,
    entryTrigger: 'OTE' as 'CHOCH' | 'OTE' | 'BOTH' | 'SMART',
    autoTrading: false,
    maxSmartRiskPercent: 0.15
};
export const setDynamicBotConfig = (val: typeof dynamicBotConfig) => { dynamicBotConfig = val; };

export const assetSessionConfigs = new Map<string, AssetSessionConfig>();

// Webhook throttling & deduping maps
export const recentAlertCache = new Map<string, number>();
export const lastSyncTime = new Map<string, number>();
export const tickerLastSeen = new Map<string, number>();
export const tickerLocks = new Map<string, Promise<void>>();
