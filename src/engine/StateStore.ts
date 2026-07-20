import { ActiveTrade, RadarState, AssetSessionConfig, GlobalPortfolioConfig } from './Types.js';

export class StateStore {
    activeTrades = new Map<string, ActiveTrade>();
    localRadarStates = new Map<string, RadarState>();
    lastFirebaseSave = new Map<string, number>();
    assetSessionConfigs = new Map<string, AssetSessionConfig>();

    lastPingTime = 0;
    consecutiveLosses = 0;
    streakKillswitchUntil = 0;
    vixKillswitchUntil = 0;
    globalKillswitches: Record<string, boolean> = {};
    
    globalPortfolioConfig: GlobalPortfolioConfig = {
        maxDailyLossR: 0,
        dailyProfitTargetR: 0,
        maxTradesPerDay: 0,
        maxConsecutiveLosses: 0,
        trailingDrawdownR: 0,
        enabled: false,
        disabledSessions: []
    };
    
    globalPortfolioKillswitchUntil = 0;
    
    dynamicBotConfig = {
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
    
    recentAlertCache = new Map<string, number>();
    lastSyncTime = new Map<string, number>();
    tickerLastSeen = new Map<string, number>();
    tickerLocks = new Map<string, Promise<void>>();
}

export function createStateStore(): StateStore {
    return new StateStore();
}
