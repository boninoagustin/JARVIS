const fs = require('fs');
const file = 'jarvis-os/src/services/backtestEngine.ts';
let code = fs.readFileSync(file, 'utf8');

const target1 = `      // SL
      const slHit = trade.direction === 'BUY' ? lowPrice <= trade.slPrice : highPrice >= trade.slPrice;
      if (slHit) {
        const isPartialClose = trade.tp1Hit;
        const currentSlLossPct = Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100; // should be 0 if moved to BE
        const pnlTp1Pct = trade.tp1Hit ? Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100 : 0;
        const finalPnlPct = isPartialClose ? (pnlTp1Pct * 0.5 - currentSlLossPct * 0.5) : -currentSlLossPct;
        const finalResult = finalPnlPct > 0 ? 'WIN' : finalPnlPct === 0 ? 'BE' : 'LOSS';

        trade.result = finalResult;
        trade.pnl = finalPnlPct;
        trade.resultTp2 = finalResult;
        trade.pnlTp2 = finalPnlPct;
        
        const originalSl = trade.originalSlPrice ?? trade.slPrice;
        const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
        
        // 🆕 COSTOS DE TRANSACCIÓN (Mejora 6)
        const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
        const transactionCostR = riskPips > 0 ? (config.commissionPerLot || 0) / (riskPips * 10) : 0;
        
        const grossR = initialSlLossPct > 0 ? finalPnlPct / initialSlLossPct : 0;
        trade.rMultiple = grossR - transactionCostR;
        
        if (!isPartialClose) {
          trade.resultTp1 = 'LOSS';
          trade.pnlTp1 = -initialSlLossPct;
          trade.rMultipleTp1 = undefined; // Don't show confusing -50 in TP1
          trade.rMultipleTp2 = undefined; // Don't show confusing -50 in TP2
        } else {
          trade.rMultipleTp2 = 0.0;
        }

        trade.closeTimestamp = nowMs;
        trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
        activeTrades.delete(tradeId);
        updateDailyStatsFromClose(trade, dailyStats, config);
        continue;
      }`;

const target2 = `      // 🆕 GATILLO DE BREAKEVEN DIFERIDO (TP 1.5)
      if (trade.tp1Hit && !trade.slHalfwayHit) {`;

const repl2 = `      // 1) SL con niveles de apertura de barra (path desconocido => peor caso)
      const slAtBarOpen = trade.slPrice;
      const slHitFirst = trade.direction === 'BUY' ? lowPrice <= slAtBarOpen : highPrice >= slAtBarOpen;
      if (slHitFirst) {
        const isPartialClose = trade.tp1Hit;
        const currentSlLossPct = Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100; // should be 0 if moved to BE
        const pnlTp1Pct = trade.tp1Hit ? Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100 : 0;
        const finalPnlPct = isPartialClose ? (pnlTp1Pct * 0.5 - currentSlLossPct * 0.5) : -currentSlLossPct;
        const finalResult = finalPnlPct > 0 ? 'WIN' : finalPnlPct === 0 ? 'BE' : 'LOSS';

        trade.result = finalResult;
        trade.pnl = finalPnlPct;
        trade.resultTp2 = finalResult;
        trade.pnlTp2 = finalPnlPct;
        
        const originalSl = trade.originalSlPrice ?? trade.slPrice;
        const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
        
        // 🆕 COSTOS DE TRANSACCIÓN (Mejora 6)
        const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
        const transactionCostR = riskPips > 0 ? (config.commissionPerLot || 0) / (riskPips * 10) : 0;
        
        const grossR = initialSlLossPct > 0 ? finalPnlPct / initialSlLossPct : 0;
        trade.rMultiple = grossR - transactionCostR;
        
        if (!isPartialClose) {
          trade.resultTp1 = 'LOSS';
          trade.pnlTp1 = -initialSlLossPct;
          trade.rMultipleTp1 = undefined; // Don't show confusing -50 in TP1
          trade.rMultipleTp2 = undefined; // Don't show confusing -50 in TP2
        } else {
          trade.rMultipleTp2 = 0.0;
        }

        trade.closeTimestamp = nowMs;
        trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
        activeTrades.delete(tradeId);
        updateDailyStatsFromClose(trade, dailyStats, config);
        continue;
      }

      // 2) solo si no hubo SL: TP1, trailing BE, TP2

      // 🆕 GATILLO DE BREAKEVEN DIFERIDO (TP 1.5)
      if (trade.tp1Hit && !trade.slHalfwayHit) {`;

code = code.replace(target1, '');
code = code.replace(target2, repl2);

fs.writeFileSync(file, code);
console.log('Fixed SL logic');
