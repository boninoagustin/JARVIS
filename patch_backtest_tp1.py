import re

with open('jarvis-os/src/services/backtestEngine.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """        // TP1
        if (!trade.tp1Hit) {
          const tp1Hit = trade.direction === 'BUY' ? highPrice >= trade.tp1Price : lowPrice <= trade.tp1Price;
          if (tp1Hit) {
            trade.tp1Hit = true;
            const slLossPct = Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100;
            // Tras TP1: mitad de posición cerrada en TP1, SL de la mitad restante a BE
            trade.slPrice = trade.entryPrice;
            trade.slHalfwayHit = true;

            trade.resultTp1 = 'WIN';
            trade.pnlTp1 = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
            trade.rMultipleTp1 = (slLossPct > 0 ? (trade.pnlTp1 / slLossPct) * 0.5 : 0.5) * (trade.riskMult || 1.0);
          }
        }"""

replacement = """        // TP1
        if (!trade.tp1Hit) {
          const tp1Hit = trade.direction === 'BUY' ? highPrice >= trade.tp1Price : lowPrice <= trade.tp1Price;
          if (tp1Hit) {
            trade.tp1Hit = true;
            const originalSl = trade.originalSlPrice ?? trade.slPrice;
            const slLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
            // Tras TP1: SL de la mitad restante se ajusta al 50% del riesgo (simulando live)
            trade.slPrice = originalSl + (trade.entryPrice - originalSl) * 0.5;
            trade.slHalfwayHit = true;

            trade.resultTp1 = 'WIN';
            trade.pnlTp1 = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
            trade.rMultipleTp1 = (slLossPct > 0 ? (trade.pnlTp1 / slLossPct) * 0.5 : 0.5) * (trade.riskMult || 1.0);
          }
        }

        // TP1.5 (Trailing a BE diferido)
        if (trade.tp1Hit && !trade.tp1_5Hit) {
          const tp1_5Price = trade.direction === 'BUY' 
            ? trade.tp1Price + Math.abs(trade.tp1Price - trade.entryPrice) * 0.5
            : trade.tp1Price - Math.abs(trade.tp1Price - trade.entryPrice) * 0.5;
          const tp1_5Hit = trade.direction === 'BUY' ? highPrice >= tp1_5Price : lowPrice <= tp1_5Price;
          if (tp1_5Hit) {
            trade.tp1_5Hit = true;
            trade.slPrice = trade.entryPrice;
          }
        }"""

content = content.replace(target, replacement)

with open('jarvis-os/src/services/backtestEngine.ts', 'w', encoding='utf-8') as f:
    f.write(content)
