import re

with open('jarvis-os/src/services/backtestEngine.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = """          const currentSlLossPct = Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100; // should be 0 if moved to BE
          const pnlTp1Pct = trade.tp1Hit ? Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100 : 0;
          const finalPnlPct = isPartialClose ? (pnlTp1Pct * 0.5 - currentSlLossPct * 0.5) : -currentSlLossPct;
          const finalResult = finalPnlPct > 0 ? 'WIN' : finalPnlPct === 0 ? 'BE' : 'LOSS';"""

replacement1 = """          const slPnlPct = trade.direction === 'BUY' 
            ? (trade.slPrice - trade.entryPrice) / trade.entryPrice * 100 
            : (trade.entryPrice - trade.slPrice) / trade.entryPrice * 100;
          const pnlTp1Pct = trade.tp1Hit ? Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100 : 0;
          const finalPnlPct = isPartialClose ? (pnlTp1Pct * 0.5 + slPnlPct * 0.5) : slPnlPct;
          const finalResult = finalPnlPct > 0 ? 'WIN' : finalPnlPct === 0 ? 'BE' : 'LOSS';"""

content = content.replace(target1, replacement1)

target2 = """          } else {
            trade.rMultipleTp2 = 0.0;
          }"""

replacement2 = """          } else {
            trade.rMultipleTp2 = initialSlLossPct > 0 ? slPnlPct / initialSlLossPct : 0.0;
          }"""

content = content.replace(target2, replacement2)

with open('jarvis-os/src/services/backtestEngine.ts', 'w', encoding='utf-8') as f:
    f.write(content)
