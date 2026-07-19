const fs = require('fs');
const file = '/home/bon/Descargas/JARVIS/jarvis-os/src/services/backtestEngine.ts';
let code = fs.readFileSync(file, 'utf8');

const replacement = `
    const currentSession = getSessionForTimestamp(nowMs);
    const sessionConfig = config.sessions?.[currentSession] || config.sessions?.['OFF'];
    const ctx = { config, currentSession, sessionConfig };

    const buyRes = evaluateImpulseCore(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, ticker, state, nowMs, null, ctx);
    state.activeImpulseBuy = buyRes.updatedLeg;
    if (buyRes.newTrade) createTrade(buyRes.newTrade, nowMs, trades, activeTrades, dailyStats, config);

    const sellRes = evaluateImpulseCore(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs, null, ctx);
    state.activeImpulseSell = sellRes.updatedLeg;
    if (sellRes.newTrade) createTrade(sellRes.newTrade, nowMs, trades, activeTrades, dailyStats, config);
`;

const oldCode = `    const buyRes = evaluateImpulse(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, ticker, state, nowMs, config);
    state.activeImpulseBuy = buyRes.updatedLeg;
    if (buyRes.triggerOte && buyRes.oteData) createTrade(buyRes.oteData, nowMs, trades, activeTrades, dailyStats, config);

    const sellRes = evaluateImpulse(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs, config);
    state.activeImpulseSell = sellRes.updatedLeg;
    if (sellRes.triggerOte && sellRes.oteData) createTrade(sellRes.oteData, nowMs, trades, activeTrades, dailyStats, config);`;

code = code.replace(oldCode, replacement);

fs.writeFileSync(file, code);
