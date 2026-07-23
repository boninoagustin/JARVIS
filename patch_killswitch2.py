import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

def repl(m):
    return """async function evaluateGlobalKillswitch(nowMs: number, store: any, isBacktest: boolean = false): Promise<boolean> {
    if (isBacktest) return false;
    const currentSession = getCurrentSession(nowMs);
    const res = await evaluateGlobalRisk(nowMs, store.globalPortfolioConfig, store.globalPortfolioKillswitchUntil, currentSession, db);

    if (res.isKilled) {
        if (res.killUntilMs && res.killUntilMs > store.globalPortfolioKillswitchUntil) {
            store.globalPortfolioKillswitchUntil = res.killUntilMs;"""

pattern = r"async function evaluateGlobalKillswitch\(nowMs: number\): Promise<boolean> \{\s*const currentSession = getCurrentSession\(nowMs\);\s*const res = await evaluateGlobalRisk\(nowMs, globalState\.globalPortfolioConfig, globalState\.globalPortfolioKillswitchUntil, currentSession, db\);\s*if \(res\.isKilled\) \{\s*if \(res\.killUntilMs && res\.killUntilMs > globalState\.globalPortfolioKillswitchUntil\) \{\s*globalState\.globalPortfolioKillswitchUntil = res\.killUntilMs;"

content = re.sub(pattern, repl, content)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
