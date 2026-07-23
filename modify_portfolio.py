import re

with open('src/engine/PortfolioModel.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update evaluateGlobalRisk
target_evaluate = """export async function evaluateGlobalRisk(
    nowMs: number,
    globalPortfolioConfig: GlobalPortfolioConfig,
    currentKillswitchUntil: number,
    currentSession: string,
    db: firestore.Firestore
): Promise<KillswitchResult> {"""

replacement_evaluate = """export async function evaluateGlobalRisk(
    nowMs: number,
    globalPortfolioConfig: GlobalPortfolioConfig,
    currentKillswitchUntil: number,
    currentSession: string,
    db: firestore.Firestore,
    isBacktest: boolean = false,
    backtestSessionId?: string
): Promise<KillswitchResult> {"""
content = content.replace(target_evaluate, replacement_evaluate)

target_cache_global = """    return withCache('global', nowMs, async () => {"""
replacement_cache_global = """    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`global_${namespace}`, nowMs, async () => {"""
content = content.replace(target_cache_global, replacement_cache_global)

target_filter_global = """            .filter(t => t.mode !== 'backtesting' && t.result)"""
replacement_filter_global = """            .filter(t => {
                const modeMatch = isBacktest ? t.mode === 'backtesting' : t.mode !== 'backtesting';
                const sessionMatch = isBacktest ? (backtestSessionId ? t.sessionId === backtestSessionId : true) : true;
                return modeMatch && sessionMatch && t.result;
            })"""
content = content.replace(target_filter_global, replacement_filter_global)


# 2. Update countDailySellsForTicker
target_sells_cache = """    return withCache(`sells_${ticker}`, nowMs, async () => {"""
replacement_sells_cache = """    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`sells_${namespace}_${ticker}`, nowMs, async () => {"""
content = content.replace(target_sells_cache, replacement_sells_cache)

# 3. Update countDailyBuysForTicker
target_buys_cache = """    return withCache(`buys_${ticker}`, nowMs, async () => {"""
replacement_buys_cache = """    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`buys_${namespace}_${ticker}`, nowMs, async () => {"""
content = content.replace(target_buys_cache, replacement_buys_cache)

# 4. Update countConsecutiveLossesForAsset
target_streak_cache = """    return withCache(`streak_${ticker}_${session}_${direction}`, nowMs, async () => {"""
replacement_streak_cache = """    const namespace = isBacktest ? `bt_${backtestSessionId ?? 'all'}` : 'live';
    return withCache(`streak_${namespace}_${ticker}_${session}_${direction}`, nowMs, async () => {"""
content = content.replace(target_streak_cache, replacement_streak_cache)

with open('src/engine/PortfolioModel.ts', 'w', encoding='utf-8') as f:
    f.write(content)

