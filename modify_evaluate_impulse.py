import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Modify function signature
content = content.replace(
    'function evaluateImpulse(leg: ImpulseLeg | null | undefined, currentPrice: number, highPrice: number, lowPrice: number, ticker: string, state: RadarState, nowMs: number) {',
    'function evaluateImpulse(leg: ImpulseLeg | null | undefined, currentPrice: number, highPrice: number, lowPrice: number, ticker: string, state: RadarState, nowMs: number, store: StateStore = globalState, isBacktest: boolean = false) {'
)

# 2. Modify globalState -> store inside evaluateImpulse
# And netTrade.isBacktest = isBacktest
# In evaluateImpulse: globalState.activeTrades.set(netTrade.tradeId, netTrade);
replacement = """            (netTrade as any).isBacktest = isBacktest;
            store.activeTrades.set(netTrade.tradeId, netTrade);"""
content = content.replace("globalState.activeTrades.set(netTrade.tradeId, netTrade);", replacement)

# 3. Update the calls to evaluateImpulse inside processTradingAlert
content = content.replace(
    'const buyRes = evaluateImpulse(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, ticker, state, nowMs);',
    'const buyRes = evaluateImpulse(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, ticker, state, nowMs, store, isBacktest);'
)
content = content.replace(
    'const sellRes = evaluateImpulse(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs);',
    'const sellRes = evaluateImpulse(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs, store, isBacktest);'
)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)

