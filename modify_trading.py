import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. signature and usage of store
target1 = """async function evaluateGlobalKillswitch(nowMs: number): Promise<boolean> {
    const currentSession = getCurrentSession(nowMs);
    const res = await evaluateGlobalRisk(nowMs, globalState.globalPortfolioConfig, globalState.globalPortfolioKillswitchUntil, currentSession, db);

    if (res.isKilled) {
        if (res.killUntilMs && res.killUntilMs > globalState.globalPortfolioKillswitchUntil) {
            globalState.globalPortfolioKillswitchUntil = res.killUntilMs;"""

replacement1 = """async function evaluateGlobalKillswitch(nowMs: number, store: StateStore, isBacktest: boolean = false): Promise<boolean> {
    const currentSession = getCurrentSession(nowMs);
    const res = await evaluateGlobalRisk(nowMs, store.globalPortfolioConfig, store.globalPortfolioKillswitchUntil, currentSession, db, isBacktest, store.activeSessionId);

    if (res.isKilled) {
        if (res.killUntilMs && res.killUntilMs > store.globalPortfolioKillswitchUntil) {
            store.globalPortfolioKillswitchUntil = res.killUntilMs;"""
content = content.replace(target1, replacement1)

# 2. caller 1
target2 = """            const isGlobalKilled = await evaluateGlobalKillswitch(nowMs);"""
replacement2 = """            const isGlobalKilled = await evaluateGlobalKillswitch(nowMs, store, isBacktest);"""
content = content.replace(target2, replacement2)

# 3. caller 2
target3 = """                                if (await evaluateGlobalKillswitch(nowLive)) return 'BLOCKED_GLOBAL';"""
replacement3 = """                                if (await evaluateGlobalKillswitch(nowLive, store, isBacktest)) return 'BLOCKED_GLOBAL';"""
content = content.replace(target3, replacement3)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
