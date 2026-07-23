import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """async function evaluateGlobalKillswitch(nowMs: number): Promise<boolean> {
    const currentSession = getCurrentSession(nowMs);
    const res = await evaluateGlobalRisk(nowMs, globalState.globalPortfolioConfig, globalState.globalPortfolioKillswitchUntil, currentSession, db);

    if (res.isKilled) {
        if (res.killUntilMs && res.killUntilMs > globalState.globalPortfolioKillswitchUntil) {
            globalState.globalPortfolioKillswitchUntil = res.killUntilMs;"""

replacement = """async function evaluateGlobalKillswitch(nowMs: number, store: any, isBacktest: boolean = false): Promise<boolean> {
    if (isBacktest) return false;
    const currentSession = getCurrentSession(nowMs);
    const res = await evaluateGlobalRisk(nowMs, store.globalPortfolioConfig, store.globalPortfolioKillswitchUntil, currentSession, db);

    if (res.isKilled) {
        if (res.killUntilMs && res.killUntilMs > store.globalPortfolioKillswitchUntil) {
            store.globalPortfolioKillswitchUntil = res.killUntilMs;"""

content = content.replace(target, replacement)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
