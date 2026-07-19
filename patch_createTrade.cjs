const fs = require('fs');
const file = '/home/bon/Descargas/JARVIS/jarvis-os/src/services/backtestEngine.ts';
let code = fs.readFileSync(file, 'utf8');

const oldTradeCreation = `  const trade: BacktestTrade = {
    id: oteData.tradeId,
    timestamp: nowMs,
    direction: oteData.direction,
    entryPrice: oteData.entryPrice,
    tp1Price: parseFloat(oteData.tp1),
    tp2Price: parseFloat(oteData.tp2) || 0,
    slPrice: parseFloat(oteData.stopLoss),
    originalSlPrice: parseFloat(oteData.stopLoss),
    points: oteData.points,
    events: oteData.events || [],
    grade: oteData.points >= 8 ? 'A+' : 'B',
    oteEntryUsed: oteData.oteEntryUsed,
    tf: oteData.tf,
  };
  trades.push(trade);`;

const newTradeCreation = `  let trade: BacktestTrade = {
    id: oteData.tradeId || (oteData.id),
    timestamp: nowMs,
    direction: oteData.direction,
    entryPrice: oteData.entryPrice,
    tp1Price: parseFloat(oteData.tp1 || oteData.tp1Price),
    tp2Price: parseFloat(oteData.tp2 || oteData.tp2Price) || 0,
    slPrice: parseFloat(oteData.stopLoss || oteData.slPrice),
    originalSlPrice: parseFloat(oteData.stopLoss || oteData.slPrice),
    points: oteData.points,
    events: oteData.events || [],
    grade: oteData.points >= 8 ? 'A+' : 'B',
    oteEntryUsed: oteData.oteEntryUsed,
    tf: oteData.tf,
  };

  // --- FRICTION MODEL INTERCEPTION ---
  const frictionResult = evaluateNetTrade(trade as any, nowMs);
  if (!frictionResult.approved) {
    // Si la fricción lo rechaza (ej. spread mayor al 40% del SL, o RR Neto < 1.0)
    return;
  }
  
  // Re-asignamos los precios que pudieron ser alterados por el spread/slippage
  trade.entryPrice = frictionResult.netTrade.entryPrice;
  trade.tp1Price = frictionResult.netTrade.tp1Price;
  trade.tp2Price = frictionResult.netTrade.tp2Price;
  trade.slPrice = frictionResult.netTrade.slPrice;

  trades.push(trade);`;

code = code.replace(oldTradeCreation, newTradeCreation);

fs.writeFileSync(file, code);
