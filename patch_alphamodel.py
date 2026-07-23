import re

with open('src/engine/AlphaModel.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Remove mg and kz from normalizeZone
content = content.replace("    if (r.mg !== undefined) r.mg = r.mg;\n    if (r.kz !== undefined) r.kz = r.kz;\n", "")

# Define resolveOteGate
resolve_ote = """
export function resolveOteGate(isChoch: boolean, isBos: boolean, triggerTf: string, dir: 'BUY'|'SELL', config: any, sessionConfig: any) {
    if (!sessionConfig) return { entryPercent: config.oteEntryPercent || 50, enabled: ['OTE','BOTH','SMART'].includes(config.entryTrigger), minScore: 8 };
    const prefix = isChoch ? 'oteChoch' : isBos ? 'oteBos' : null;
    const tfConfig = prefix ? (sessionConfig[`${prefix}${triggerTf}`] ?? sessionConfig[prefix]) : null;
    if (!tfConfig) return { entryPercent: config.oteEntryPercent ?? 50, enabled: false, minScore: 8 };
    return {
        entryPercent: tfConfig.entryPercent ?? config.oteEntryPercent ?? 50,
        enabled: tfConfig.enabled ?? false,
        minScore: dir === 'BUY' ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? 8) : (tfConfig.minScoreSell ?? tfConfig.minScore ?? 8)
    };
}

"""

content = content.replace("export const getDecimals", resolve_ote + "export const getDecimals")

target_block = """        let activeOteEntryPercent = config.oteEntryPercent || 50;
        if (sessionConfig) {
            if (isChoch) {
                const tfKey = `oteChoch${triggerTf}` as keyof typeof sessionConfig;
                const tfConfig = sessionConfig[tfKey] as any;
                if (tfConfig) {
                    activeOteEntryPercent = tfConfig.entryPercent ?? config.oteEntryPercent ?? 50;
                } else if ((sessionConfig as any).oteChoch) {
                    activeOteEntryPercent = (sessionConfig as any).oteChoch.entryPercent ?? config.oteEntryPercent ?? 50;
                }
            } else if (isBos) {
                const tfKey = `oteBos${triggerTf}` as keyof typeof sessionConfig;
                const tfConfig = sessionConfig[tfKey] as any;
                if (tfConfig) {
                    activeOteEntryPercent = tfConfig.entryPercent ?? config.oteEntryPercent ?? 50;
                } else if ((sessionConfig as any).oteBos) {
                    activeOteEntryPercent = (sessionConfig as any).oteBos.entryPercent ?? config.oteEntryPercent ?? 50;
                }
            } else {
                activeOteEntryPercent = config.oteEntryPercent ?? 50;
            }
        }

        const fibRatio = activeOteEntryPercent / 100;
        const entryLevel = leg.dir === 'BUY' ? leg.extreme - (range * fibRatio) : leg.extreme + (range * fibRatio);

        const isEntryHit = leg.dir === 'BUY' ? lowPrice <= entryLevel : highPrice >= entryLevel;

        if (isEntryHit && !leg.oteScored) {

            let oteEnabled = false;
            let oteMinScore = 8;

            if (sessionConfig) {
                if (isChoch) {
                    const tfKey = `oteChoch${triggerTf}` as keyof typeof sessionConfig;
                    const tfConfig = sessionConfig[tfKey] as any;
                    if (tfConfig) {
                        oteEnabled = tfConfig.enabled ?? false;
                        oteMinScore = leg.dir === 'BUY'
                            ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? 8)
                            : (tfConfig.minScoreSell ?? tfConfig.minScore ?? 8);
                    } else if ((sessionConfig as any).oteChoch) {
                        oteEnabled = (sessionConfig as any).oteChoch.enabled ?? false;
                        oteMinScore = (sessionConfig as any).oteChoch.minScore ?? 8;
                    }
                } else if (isBos) {
                    const tfKey = `oteBos${triggerTf}` as keyof typeof sessionConfig;
                    const tfConfig = sessionConfig[tfKey] as any;
                    if (tfConfig) {
                        oteEnabled = tfConfig.enabled ?? false;
                        oteMinScore = leg.dir === 'BUY'
                            ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? 8)
                            : (tfConfig.minScoreSell ?? tfConfig.minScore ?? 8);
                    } else if ((sessionConfig as any).oteBos) {
                        oteEnabled = (sessionConfig as any).oteBos.enabled ?? false;
                        oteMinScore = (sessionConfig as any).oteBos.minScore ?? 8;
                    }
                } else {
                    oteEnabled = false;
                    oteMinScore = 8;
                }
            } else {
                oteEnabled = (config.entryTrigger === 'OTE' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
                oteMinScore = 8;
            }"""

replacement_block = """        const oteGate = resolveOteGate(isChoch, isBos, triggerTf, leg.dir, config, sessionConfig);
        const activeOteEntryPercent = oteGate.entryPercent;

        const fibRatio = activeOteEntryPercent / 100;
        const entryLevel = leg.dir === 'BUY' ? leg.extreme - (range * fibRatio) : leg.extreme + (range * fibRatio);

        const isEntryHit = leg.dir === 'BUY' ? lowPrice <= entryLevel : highPrice >= entryLevel;

        if (isEntryHit && !leg.oteScored) {

            const oteEnabled = oteGate.enabled;
            const oteMinScore = oteGate.minScore;"""

content = content.replace(target_block, replacement_block)

with open('src/engine/AlphaModel.ts', 'w', encoding='utf-8') as f:
    f.write(content)
