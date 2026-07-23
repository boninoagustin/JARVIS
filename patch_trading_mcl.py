import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = """                    const currentConsecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'SELL', nowMs, isBacktest, activeSessionId);
                    if (currentConsecutiveLosses >= sessionConfig.maxSellLosses) {
                        console.log(`[MCL LIMIT] ⛔ Setup ${ticker} SELL BLOQUEADO: ${store.consecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas en sesión ${currentSession}.`);"""
replacement1 = """                    const currentConsecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'SELL', nowMs, isBacktest, activeSessionId);
                    if (currentConsecutiveLosses >= sessionConfig.maxSellLosses) {
                        console.log(`[MCL LIMIT] ⛔ Setup ${ticker} SELL BLOQUEADO: ${currentConsecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas en sesión ${currentSession}.`);"""
content = content.replace(target1, replacement1)

target2 = """                            `📊 Se alcanzaron <b>${store.consecutiveLosses}/${sessionConfig.maxSellLosses}</b> pérdidas consecutivas de tipo SELL hoy en la sesión <b>${currentSession}</b>.\\n` +"""
replacement2 = """                            `📊 Se alcanzaron <b>${currentConsecutiveLosses}/${sessionConfig.maxSellLosses}</b> pérdidas consecutivas de tipo SELL hoy en la sesión <b>${currentSession}</b>.\\n` +"""
content = content.replace(target2, replacement2)

target3 = """                    console.log(`[MCL LIMIT] ✅ ${ticker} SELL permitido: ${store.consecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas de tipo SELL.`);"""
replacement3 = """                    console.log(`[MCL LIMIT] ✅ ${ticker} SELL permitido: ${currentConsecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas de tipo SELL.`);"""
content = content.replace(target3, replacement3)


target4 = """                    const currentConsecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'BUY', nowMs, isBacktest, activeSessionId);
                    if (currentConsecutiveLosses >= sessionConfig.maxBuyLosses) {
                        console.log(`[MCL LIMIT] ⛔ Setup ${ticker} BUY BLOQUEADO: ${store.consecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas en sesión ${currentSession}.`);"""
replacement4 = """                    const currentConsecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'BUY', nowMs, isBacktest, activeSessionId);
                    if (currentConsecutiveLosses >= sessionConfig.maxBuyLosses) {
                        console.log(`[MCL LIMIT] ⛔ Setup ${ticker} BUY BLOQUEADO: ${currentConsecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas en sesión ${currentSession}.`);"""
content = content.replace(target4, replacement4)

target5 = """                            `📊 Se alcanzaron <b>${store.consecutiveLosses}/${sessionConfig.maxBuyLosses}</b> pérdidas consecutivas de tipo BUY hoy en la sesión <b>${currentSession}</b>.\\n` +"""
replacement5 = """                            `📊 Se alcanzaron <b>${currentConsecutiveLosses}/${sessionConfig.maxBuyLosses}</b> pérdidas consecutivas de tipo BUY hoy en la sesión <b>${currentSession}</b>.\\n` +"""
content = content.replace(target5, replacement5)

target6 = """                    console.log(`[MCL LIMIT] ✅ ${ticker} BUY permitido: ${store.consecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas de tipo BUY.`);"""
replacement6 = """                    console.log(`[MCL LIMIT] ✅ ${ticker} BUY permitido: ${currentConsecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas de tipo BUY.`);"""
content = content.replace(target6, replacement6)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
