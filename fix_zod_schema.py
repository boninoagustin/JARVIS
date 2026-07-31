import re

file_path = '/home/bon/Descargas/JARVIS/src/engine/Types.ts'
with open(file_path, 'r') as f:
    text = f.read()

trigger_fields = """enabled: z.boolean().optional(),
    minScore: z.number().optional(),
    minScoreBuy: z.number().optional(),
    minScoreSell: z.number().optional(),
    entryPercent: z.number().optional(),
    slBuff: z.number().optional(),
    tp2: z.number().optional(),
    partialClosePct: z.number().optional(),
    slAfterTp1: z.enum(['midpoint', 'breakeven', 'none']).optional(),
    tp15BeEnabled: z.boolean().optional(),
    atrTrailEnabled: z.boolean().optional(),
    structuralTrailEnabled: z.boolean().optional(),
    tp1StructuralMinRR: z.number().optional()"""

new_trigger_schema = f"const TriggerSchema = z.object({{\n    {trigger_fields}\n}});"

old_session_schema = """export const SessionSchema = z.object({
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
});"""

new_session_schema = f"""{new_trigger_schema}

export const SessionSchema = z.object({{
    choch5m: TriggerSchema.optional(),
    choch15m: TriggerSchema.optional(),
    bos5m: TriggerSchema.optional(),
    bos15m: TriggerSchema.optional(),
    oteChoch5m: TriggerSchema.optional(),
    oteChoch15m: TriggerSchema.optional(),
    oteBos5m: TriggerSchema.optional(),
    oteBos15m: TriggerSchema.optional(),
    maxSellLosses: z.number().optional(),
    maxBuyLosses: z.number().optional(),
    slBufferPercent: z.number().optional(),
    fixedRR: z.number().optional(),
    maxSmartRiskPercent: z.number().optional()
}});"""

text = text.replace(old_session_schema, new_session_schema)

with open(file_path, 'w') as f:
    f.write(text)
print("done")
