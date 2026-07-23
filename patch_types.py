import re

with open('src/engine/Types.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """export const AssetSessionConfigSchema = z.object({
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
}).passthrough();"""

replacement = """const nonNegativeNumber = z.coerce.number().refine(n => Number.isFinite(n), { message: 'Debe ser un número finito' });

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
    sessions: z.record(z.string(), SessionSchema).optional()
}).strict();"""

content = content.replace(target, replacement)

with open('src/engine/Types.ts', 'w', encoding='utf-8') as f:
    f.write(content)
