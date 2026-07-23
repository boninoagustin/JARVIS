import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update imports in trading.ts
import_target = "import { RadarZone, ImpulseLeg, RadarState, ActiveTrade, AssetSessionConfigSchema } from '../engine/Types.js';"
import_replacement = """import { z } from 'zod';
import { RadarZone, ImpulseLeg, RadarState, ActiveTrade, AssetSessionConfigSchema, GlobalPortfolioConfig, SessionSchema } from '../engine/Types.js';

type SessionConfig = z.infer<typeof SessionSchema>;"""
content = content.replace(import_target, import_replacement)

# 2. Remove inline GlobalPortfolioConfig
inline_config = """interface GlobalPortfolioConfig {
    maxDailyLossR: number;       // MDL: R máxima pérdida diaria (ej. 3R)
    dailyProfitTargetR: number;  // DPT: R máximo profit diario (ej. 5R)
    maxTradesPerDay: number;     // MTD: Máximo de operaciones diarias
    maxConsecutiveLosses: number;// MCL: Máximo de pérdidas consecutivas diarias
    trailingDrawdownR: number;   // TDD: Drawdown dinámico máximo diario en R
    enabled: boolean;
    disabledSessions?: string[]; // 🚫 Killswitch global de sesión
}"""
content = content.replace(inline_config, "")

# 3. Update getConfigForTicker signature
get_config_target = """function getConfigForTicker(ticker: string, nowMs?: number): typeof globalState.dynamicBotConfig & {
    sessionEnabled: boolean;
    maxSellsPerDay: number;
    sellScorePenalty: number;
    maxBuysPerDay: number;
    buyScorePenalty: number;
    sessions?: Record<string, {
      choch5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
      choch15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
      bos5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
      bos15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
      oteChoch5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
      oteChoch15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
      oteBos5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
      oteBos15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
      // Legacy fallback keys
      choch?: { enabled: boolean; minScore: number };
      bos?: { enabled: boolean; minScore: number };
      oteChoch?: { enabled: boolean; minScore: number; entryPercent?: number };
      oteBos?: { enabled: boolean; minScore: number; entryPercent?: number };
      maxSellLosses?: number;
      maxBuyLosses?: number;
      slBufferPercent?: number;
      fixedRR?: number;
    }>;
} {"""

get_config_replacement = """function getConfigForTicker(ticker: string, nowMs?: number): typeof globalState.dynamicBotConfig & {
    sessionEnabled: boolean;
    maxSellsPerDay: number;
    sellScorePenalty: number;
    maxBuysPerDay: number;
    buyScorePenalty: number;
    sessions?: Record<string, SessionConfig>;
} {"""
content = content.replace(get_config_target, get_config_replacement)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
