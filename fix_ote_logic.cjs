const fs = require('fs');
const file = 'src/engine/AlphaModel.ts';
let code = fs.readFileSync(file, 'utf8');

const targetBlock = `            const riskDistanceOTE = Math.abs(leg.extreme - leg.origin) * 0.21;
            const rewardDistanceOTE = Math.abs(leg.extreme - leg.origin) * 0.50;
            const rrRatioOTE = riskDistanceOTE > 0 ? rewardDistanceOTE / riskDistanceOTE : 1.0;
            if (riskDistanceOTE === 0 || rrRatioOTE < 1.2) {
                dbg(\`[FIBO] ❌ R:R invalid: risk=\${riskDistanceOTE}, reward=\${rewardDistanceOTE}, ratio=\${rrRatioOTE}\`);
                dbg(\`[FIBO] ⚠️ OTE \${ticker} \${leg.dir} descartado: R:R teórico \${rrRatioOTE.toFixed(2)} < 1.2 (rango impulso: \${(Math.abs(leg.extreme - leg.origin)).toFixed(4)})\`);
                return { updatedLeg: leg };
            }

            const activeScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
            const tfFormatted = triggerTf.toUpperCase() || '5M';
            const eventName = \`🎯_OTE_Retracement_\${tfFormatted}\`;
            
            if (!activeScore.events.includes(eventName)) {
                activeScore.events.push(eventName);
                activeScore.points += 4;
                activeScore.lastUpdate = nowMs;
                leg.oteScored = true;
                
                const decimals = getDecimals(ticker);
                const slBuffer = calculateDynamicSlBuffer(ticker, leg.origin, sessionConfig?.slBufferPercent ?? config.slBufferPercent);
                const adjustedSL = leg.dir === 'BUY' ? leg.origin - slBuffer : leg.origin + slBuffer;
                const stopLoss = adjustedSL.toFixed(decimals);
                const tp1 = leg.extreme.toFixed(decimals);
                const riskDist = Math.abs(currentPrice - adjustedSL);
                const oteTP2Limit = leg.dir === 'BUY'
                    ? leg.extreme + (range * 0.27)
                    : leg.extreme - (range * 0.27);
                const fixedTP2 = leg.dir === 'BUY'
                    ? Math.max(oteTP2Limit, currentPrice + (riskDist * config.fixedRR))
                    : Math.min(oteTP2Limit, currentPrice - (riskDist * config.fixedRR));
                const tp2 = fixedTP2.toFixed(decimals);

                const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();

                dbg(\`[FIBO] 🎯 RETROCESO 50% CONFIRMADO para \${ticker} \${leg.dir}. Despertando IA...\`);

                const bias240 = state.marketBias["240"] || 'NEUTRAL';
                const bias60 = state.marketBias["60"] || 'NEUTRAL';
                const bias15 = state.marketBias["15"] || 'NEUTRAL';
                const getIconStr = (bias: string) => bias === 'BUY' ? '🟢' : bias === 'SELL' ? '🔴' : '⚪';
                const fallbackReport = \`🗺️ <b>Contexto Macro:</b>\\n\` +
                    \`\${getIconStr(bias240)} 4H: \${bias240}\\n\` +
                    \`\${getIconStr(bias60)} 1H: \${bias60}\\n\` +
                    \`\${getIconStr(bias15)} 15M: \${bias15}\\n\\n\` +
                    \`🎯 <b>Confluencia de Entrada:</b> Retroceso OTE 5M en nivel del 50% Fibo (Puntaje base: \${leg.chochPoints || 0} pts + OTE: +4 pts).\`;

                const oteData = {
                    tradeId, 
                    direction: leg.dir,
                    dirText: leg.dir === 'BUY' ? 'COMPRA' : 'VENTA',
                    stopLoss, tp1, tp2,
                    entryPrice: currentPrice,
                    points: (leg.chochPoints || 0) + 4, 
                    events: [...(leg.chochEvents || []), eventName],
                    confluenceReport: leg.chochReport || fallbackReport,
                    bestZone: leg.bestZone || null,
                    marketBias: { ...state.marketBias },
                    tf: eventName.split('_').pop(),
                    isChochEntry: false
                };

                const newTrade: ActiveTrade = {
                    tradeId, ticker, direction: leg.dir,
                    entryPrice: currentPrice,`;


const replacementBlock = `            const entryFill = entryLevel; // fill limit en el 50% (supuesto estándar de backtest)
            const decimals = getDecimals(ticker);
            const slBuffer = calculateDynamicSlBuffer(ticker, leg.origin, sessionConfig?.slBufferPercent ?? config.slBufferPercent);
            const adjustedSL = leg.dir === 'BUY' ? leg.origin - slBuffer : leg.origin + slBuffer;

            const risk = Math.abs(entryFill - adjustedSL);
            const reward = Math.abs(leg.extreme - entryFill); // TP1 = extreme
            const rrRatioOTE = risk > 0 ? reward / risk : 1.0;

            if (risk <= 0 || rrRatioOTE < 1.2) {
                dbg(\`[FIBO] ❌ R:R invalid: risk=\${risk}, reward=\${reward}, ratio=\${rrRatioOTE}\`);
                dbg(\`[FIBO] ⚠️ OTE \${ticker} \${leg.dir} descartado: R:R teórico \${rrRatioOTE.toFixed(2)} < 1.2 (rango impulso: \${(Math.abs(leg.extreme - leg.origin)).toFixed(4)})\`);
                return { updatedLeg: leg };
            }

            const activeScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
            const tfFormatted = triggerTf.toUpperCase() || '5M';
            const eventName = \`🎯_OTE_Retracement_\${tfFormatted}\`;
            
            if (!activeScore.events.includes(eventName)) {
                activeScore.events.push(eventName);
                activeScore.points += 4;
                activeScore.lastUpdate = nowMs;
                leg.oteScored = true;
                
                const stopLoss = adjustedSL.toFixed(decimals);
                const tp1 = leg.extreme.toFixed(decimals);
                const riskDist = risk;
                const oteTP2Limit = leg.dir === 'BUY'
                    ? leg.extreme + (range * 0.27)
                    : leg.extreme - (range * 0.27);
                const fixedTP2 = leg.dir === 'BUY'
                    ? Math.min(oteTP2Limit, entryFill + (riskDist * config.fixedRR))
                    : Math.max(oteTP2Limit, entryFill - (riskDist * config.fixedRR));
                const tp2 = fixedTP2.toFixed(decimals);

                const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();

                dbg(\`[FIBO] 🎯 RETROCESO 50% CONFIRMADO para \${ticker} \${leg.dir}. Despertando IA...\`);

                const bias240 = state.marketBias["240"] || 'NEUTRAL';
                const bias60 = state.marketBias["60"] || 'NEUTRAL';
                const bias15 = state.marketBias["15"] || 'NEUTRAL';
                const getIconStr = (bias: string) => bias === 'BUY' ? '🟢' : bias === 'SELL' ? '🔴' : '⚪';
                const fallbackReport = \`🗺️ <b>Contexto Macro:</b>\\n\` +
                    \`\${getIconStr(bias240)} 4H: \${bias240}\\n\` +
                    \`\${getIconStr(bias60)} 1H: \${bias60}\\n\` +
                    \`\${getIconStr(bias15)} 15M: \${bias15}\\n\\n\` +
                    \`🎯 <b>Confluencia de Entrada:</b> Retroceso OTE 5M en nivel del 50% Fibo (Puntaje base: \${leg.chochPoints || 0} pts + OTE: +4 pts).\`;

                const oteData = {
                    tradeId, 
                    direction: leg.dir,
                    dirText: leg.dir === 'BUY' ? 'COMPRA' : 'VENTA',
                    stopLoss, tp1, tp2,
                    entryPrice: entryFill,
                    points: (leg.chochPoints || 0) + 4, 
                    events: [...(leg.chochEvents || []), eventName],
                    confluenceReport: leg.chochReport || fallbackReport,
                    bestZone: leg.bestZone || null,
                    marketBias: { ...state.marketBias },
                    tf: eventName.split('_').pop(),
                    isChochEntry: false
                };

                const newTrade: ActiveTrade = {
                    tradeId, ticker, direction: leg.dir,
                    entryPrice: entryFill,`;

if (code.includes(targetBlock)) {
  code = code.replace(targetBlock, replacementBlock);
  fs.writeFileSync(file, code);
  console.log('OTE logic successfully replaced');
} else {
  console.log('Target block not found. Checking exactly why...');
  console.log('Substring check 1: ', code.includes(`const riskDistanceOTE = Math.abs(leg.extreme - leg.origin) * 0.21;`));
  console.log('Substring check 2: ', code.includes(`const fixedTP2 = leg.dir === 'BUY'`));
}
