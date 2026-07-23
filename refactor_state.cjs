const fs = require('fs');
const stateStorePath = 'src/engine/StateStore.ts';
const tradingPath = 'src/db/trading.ts';

let stateStoreContent = `import { ActiveTrade, RadarState, AssetSessionConfig, GlobalPortfolioConfig } from './Types.js';

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

fs.writeFileSync(stateStorePath, stateStoreContent);
console.log('StateStore.ts updated.');

// Now refactor trading.ts
let tradingContent = fs.readFileSync(tradingPath, 'utf8');

// Fix shadowed const first so we don't mangle them
tradingContent = tradingContent.replace(/const consecutiveLosses = await countConsecutiveLosses/g, 'const localConsecutiveLosses = await countConsecutiveLosses');
tradingContent = tradingContent.replace(/consecutiveLosses >= sessionConfig/g, 'localConsecutiveLosses >= sessionConfig');
tradingContent = tradingContent.replace(/consecutiveLosses\/\$\{sessionConfig/g, 'localConsecutiveLosses/${sessionConfig');

// Fix the object shorthand BEFORE replacing the variable
tradingContent = tradingContent.replace(/consecutiveLosses,\s*\n/g, 'consecutiveLosses: globalState.consecutiveLosses,\n');

// Remove old imports
tradingContent = tradingContent.replace(/import\s*\{\s*activeTrades,\s*localRadarStates,\s*lastFirebaseSave\s*\}\s*from\s*'..\/engine\/StateStore.js';/g, '');
tradingContent = tradingContent.replace(/import\s*\{\s*assetSessionConfigs\s*\}\s*from\s*'..\/engine\/StateStore.js';/g, '');

// Also remove specific exports that we now bundle
const toRemoveFromImports = [
    'recentAlertCache', 'lastSyncTime', 'tickerLastSeen', 'tickerLocks'
];
toRemoveFromImports.forEach(i => {
    const reg = new RegExp(`\\b${i}\\b\\s*,?\\s*`, 'g');
    tradingContent = tradingContent.replace(reg, '');
});

// Import the factory
tradingContent = tradingContent.replace(/import\s*\{\s*RadarZone,\s*ImpulseLeg,\s*RadarState,\s*ActiveTrade,\s*AssetSessionConfigSchema\s*\}\s*from\s*'..\/engine\/Types.js';/, 
`import { RadarZone, ImpulseLeg, RadarState, ActiveTrade, AssetSessionConfigSchema } from '../engine/Types.js';
import { StateStore, createStateStore } from '../engine/StateStore.js';

export const globalState = createStateStore();
`);

// Remove local global declarations
const varsToRemove = [
    /let\s+lastPingTime\s*=\s*0;\n/g,
    /let\s+consecutiveLosses\s*=\s*0;\s*\n/g,
    /let\s+streakKillswitchUntil\s*=\s*0;\n/g,
    /let\s+vixKillswitchUntil\s*=\s*0;\n/g,
    /let\s+globalKillswitches:\s*Record<string,\s*boolean>\s*=\s*\{\};\n/g,
    /let\s+globalPortfolioKillswitchUntil\s*=\s*0;\n/g,
    /let\s+globalPortfolioConfig:\s*GlobalPortfolioConfig\s*=\s*\{[\s\S]*?\};\n/g,
    /let\s+dynamicBotConfig\s*=\s*\{[\s\S]*?\};\n/g
];

for (let regex of varsToRemove) {
    tradingContent = tradingContent.replace(regex, '');
}

// Replace references
const refs = [
    'activeTrades', 'localRadarStates', 'lastFirebaseSave', 'assetSessionConfigs',
    'lastPingTime', 'consecutiveLosses', 'streakKillswitchUntil', 'vixKillswitchUntil',
    'globalKillswitches', 'globalPortfolioConfig', 'globalPortfolioKillswitchUntil', 'dynamicBotConfig',
    'recentAlertCache', 'lastSyncTime', 'tickerLastSeen', 'tickerLocks'
];

for (let ref of refs) {
    // We allow dots AFTER the match but NOT before, to catch "...dynamicBotConfig" we must modify the negative lookbehind.
    // The issue was `(?<![a-zA-Z0-9_\.])`. A dot prevents it. So let's allow a dot if it's part of a spread operator.
    // Actually, just using `(?<![a-zA-Z0-9_])` is safer! We DO want to replace `...dynamicBotConfig`. But what if it's `foo.activeTrades`? We DON'T want to replace that!
    // So we use a regex that matches the word, checks the character before it, and if it's a dot, checks if it's a spread operator.
    
    // An easier way is a replacer function:
    const regex = new RegExp(`(^|[^a-zA-Z0-9_])(${ref})\\b`, 'g');
    tradingContent = tradingContent.replace(regex, (match, p1, p2) => {
        if (p1 === '.') {
            // Is it a property access?
            // Wait, what if it's `...dynamicBotConfig`? The `[^a-zA-Z0-9_]` matches the last dot! So p1 is `.`.
            return match; // Will fix spread operator manually below
        }
        return p1 + 'globalState.' + p2;
    });
}

// Fix spread operator usages manually
tradingContent = tradingContent.replace(/\.\.\.dynamicBotConfig/g, '...globalState.dynamicBotConfig');
tradingContent = tradingContent.replace(/\.\.\.assetSessionConfigs/g, '...globalState.assetSessionConfigs');

// Fix any double globalState.globalState
tradingContent = tradingContent.replace(/globalState\.globalState\./g, 'globalState.');

fs.writeFileSync(tradingPath, tradingContent);
console.log('trading.ts updated.');

