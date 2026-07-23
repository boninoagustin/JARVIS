const fs = require('fs');

const stateStoreContent = `import { ActiveTrade, RadarState, AssetSessionConfig, GlobalPortfolioConfig } from './Types.js';

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
`;
fs.writeFileSync('src/engine/StateStore.ts', stateStoreContent);

let tradingContent = fs.readFileSync('src/db/trading.ts', 'utf8');

// 1. Remove old imports of state vars from StateStore
tradingContent = tradingContent.replace(/import\s*\{\s*activeTrades,\s*localRadarStates,\s*lastFirebaseSave\s*\}\s*from\s*'..\/engine\/StateStore.js';/, '');
tradingContent = tradingContent.replace(/import\s*\{\s*assetSessionConfigs\s*\}\s*from\s*'..\/engine\/StateStore.js';/, '');

// Remove the import of recentAlertCache etc. from StateStore. Wait, they might be in a multiline import!
tradingContent = tradingContent.replace(/import\s*\{[^}]*recentAlertCache[^}]*\}\s*from\s*'..\/engine\/StateStore.js';/, '');

// 2. Add factory import
tradingContent = tradingContent.replace(/import\s*\{\s*RadarZone,\s*ImpulseLeg,\s*RadarState,\s*ActiveTrade,\s*AssetSessionConfigSchema\s*\}\s*from\s*'..\/engine\/Types.js';/, 
`import { RadarZone, ImpulseLeg, RadarState, ActiveTrade, AssetSessionConfigSchema } from '../engine/Types.js';
import { StateStore, createStateStore } from '../engine/StateStore.js';

export const globalState = createStateStore();`);

// 3. Remove local global declarations completely
const toRemove = [
    /let\s+lastPingTime\s*=\s*0;\n/g,
    /let\s+consecutiveLosses\s*=\s*0;\s*\n/g,
    /let\s+streakKillswitchUntil\s*=\s*0;\n/g,
    /let\s+vixKillswitchUntil\s*=\s*0;\n/g,
    /let\s+globalKillswitches:\s*Record<string,\s*boolean>\s*=\s*\{\};\n/g,
    /let\s+globalPortfolioKillswitchUntil\s*=\s*0;\n/g,
    /let\s+globalPortfolioConfig:\s*GlobalPortfolioConfig\s*=\s*\{[\s\S]*?\};\n/g,
    /let\s+dynamicBotConfig\s*=\s*\{[\s\S]*?\};\n/g
];
toRemove.forEach(regex => {
    tradingContent = tradingContent.replace(regex, '');
});

// 4. Safely rename the shadowed variables first so they aren't mangled by global rename
tradingContent = tradingContent.replace(/const\s+consecutiveLosses\s*=\s*await\s+countConsecutiveLosses/g, 'const currentConsecutiveLosses = await countConsecutiveLosses');
tradingContent = tradingContent.replace(/consecutiveLosses\s*>=\s*sessionConfig.maxSellLosses/g, 'currentConsecutiveLosses >= sessionConfig.maxSellLosses');
tradingContent = tradingContent.replace(/consecutiveLosses\/\$\{sessionConfig\.maxSellLosses/g, 'currentConsecutiveLosses/${sessionConfig.maxSellLosses');
tradingContent = tradingContent.replace(/consecutiveLosses\s*>=\s*sessionConfig.maxBuyLosses/g, 'currentConsecutiveLosses >= sessionConfig.maxBuyLosses');
tradingContent = tradingContent.replace(/consecutiveLosses\/\$\{sessionConfig\.maxBuyLosses/g, 'currentConsecutiveLosses/${sessionConfig.maxBuyLosses');

// Also handle the object shorthand explicitly for consecutiveLosses
tradingContent = tradingContent.replace(/marketBias: oteData.marketBias \|\| \{\},\n\s*consecutiveLosses,\n\s*winRate: 0,/g, 'marketBias: oteData.marketBias || {},\n                                    consecutiveLosses: globalState.consecutiveLosses,\n                                    winRate: 0,');


// 5. Replace references. ONLY replace if they aren't preceded by a dot OR part of an object definition like `consecutiveLosses:` 
const refs = [
    'activeTrades', 'localRadarStates', 'lastFirebaseSave', 'assetSessionConfigs',
    'lastPingTime', 'consecutiveLosses', 'streakKillswitchUntil', 'vixKillswitchUntil',
    'globalKillswitches', 'globalPortfolioConfig', 'globalPortfolioKillswitchUntil', 'dynamicBotConfig',
    'recentAlertCache', 'lastSyncTime', 'tickerLastSeen', 'tickerLocks'
];

for (let ref of refs) {
    const regex = new RegExp(`(^|[^a-zA-Z0-9_])(${ref})\\b`, 'g');
    tradingContent = tradingContent.replace(regex, (match, before, word) => {
        // If it's preceded by a dot, check if it's `...word` (spread)
        if (before === '.') {
            // we have `.` before it. Let's see if the full match in text actually has `...`
            return match; // keep as is, we'll fix spread separately
        }
        return before + 'globalState.' + word;
    });
}

// 6. Fix spread usages specifically
tradingContent = tradingContent.replace(/\.\.\.dynamicBotConfig/g, '...globalState.dynamicBotConfig');
tradingContent = tradingContent.replace(/\.\.\.assetSessionConfigs/g, '...globalState.assetSessionConfigs');

// 7. Fix type references if any got caught (like typeof globalState.dynamicBotConfig)
// actually `typeof globalState.dynamicBotConfig` is perfectly valid typescript!

// 8. Fix properties of object literals if they got mangled (e.g. { activeTrades: foo } -> { globalState.activeTrades: foo })
// In our regex we only check for preceding dot. If it was `({ activeTrades: ... })` it would be replaced to `({ globalState.activeTrades: ... })` which is invalid.
// Let's use typescript to tell us if there are syntax errors, but hopefully there aren't many.

fs.writeFileSync('src/db/trading.ts', tradingContent);
