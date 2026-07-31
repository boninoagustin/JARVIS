import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    text = f.read()

# 1. Insert State
state_line = "const [tradeFilter, setTradeFilter] = useState<'ALL' | 'WIN' | 'LOSS' | 'BE'>('ALL');"
if "const [optimizingTrigger" not in text:
    text = text.replace(state_line, state_line + "\n  const [optimizingTrigger, setOptimizingTrigger] = useState<string | null>(null);")

# 2. Insert handleOptimizeTrigger
handle_opt_func = """
  const handleOptimizeTrigger = (sessionKey: string, triggerKey: string) => {
    if (optimizingTrigger) return;
    setOptimizingTrigger(`${sessionKey}-${triggerKey}`);
    
    // Values to test
    const slBuffVals = [0, 0.05, 0.1, 0.2];
    const tp2Vals = [1.5, 2.0, 3.0, 4.0];
    const partialClosePctVals = [0, 0.5, 0.8];
    const slAfterTp1Vals: ('midpoint' | 'breakeven' | 'none')[] = ['none', 'midpoint', 'breakeven'];
    const tp15BeEnabledVals = [true, false];
    const atrTrailEnabledVals = [true, false];
    const structuralTrailEnabledVals = [true, false];

    const combinations: any[] = [];
    for (const sb of slBuffVals) {
      for (const t2 of tp2Vals) {
        for (const pcp of partialClosePctVals) {
          for (const sATp1 of slAfterTp1Vals) {
            for (const t15 of tp15BeEnabledVals) {
              for (const atr of atrTrailEnabledVals) {
                for (const str of structuralTrailEnabledVals) {
                  combinations.push({
                    slBuff: sb, tp2: t2, partialClosePct: pcp, slAfterTp1: sATp1,
                    tp15BeEnabled: t15, atrTrailEnabled: atr, structuralTrailEnabled: str
                  });
                }
              }
            }
          }
        }
      }
    }

    let bestConfig = combinations[0];
    let bestScore = -Infinity;
    let bestWinRate = -1;

    const baseConfig = JSON.parse(JSON.stringify(sessionTriggers));
    
    Object.keys(baseConfig).forEach(sk => {
      Object.keys(baseConfig[sk]).forEach(tk => {
        if (typeof baseConfig[sk][tk] === 'object' && baseConfig[sk][tk] !== null) {
           baseConfig[sk][tk].enabled = false;
        }
      });
    });

    if (!baseConfig[sessionKey]) baseConfig[sessionKey] = {};
    if (!baseConfig[sessionKey][triggerKey]) baseConfig[sessionKey][triggerKey] = { enabled: true, minScore: 4 };
    
    baseConfig[sessionKey][triggerKey].enabled = true;
    
    const CHUNK_SIZE = 50;
    let i = 0;

    const processChunk = () => {
      const end = Math.min(i + CHUNK_SIZE, combinations.length);
      for (; i < end; i++) {
        const testMgmt = combinations[i];
        
        const testSessionTriggers = JSON.parse(JSON.stringify(baseConfig));
        testSessionTriggers[sessionKey][triggerKey] = {
          ...testSessionTriggers[sessionKey][triggerKey],
          ...testMgmt
        };

        const finalOte = oteEntryPercent;
        const configToRun = {
          ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent: finalOte, entryTrigger: 'SMART' as const,
          maxDailyLossR, dailyProfitTargetR, maxConsecutiveLosses, maxTradesPerDay, trailingDrawdownR,
          sessions: testSessionTriggers,
          sessionFilter: [sessionKey],
          enabled: true,
          spreadPips,
          commissionPerLot,
          maxTradesPerSession
        };

        const result = runBacktest(csvData, configToRun);
        
        let pnlR = 0;
        let wins = 0;
        let total = 0;
        result.trades.forEach(t => {
           if (t.rMultiple !== undefined && !Number.isNaN(t.rMultiple)) {
               pnlR += t.rMultiple;
               total++;
               if (t.rMultiple > 0) wins++;
           }
        });
        const wr = total > 0 ? wins / total : 0;
        
        if (pnlR > bestScore || (pnlR === bestScore && wr > bestWinRate)) {
          bestScore = pnlR;
          bestWinRate = wr;
          bestConfig = testMgmt;
        }
      }

      if (i < combinations.length) {
        requestAnimationFrame(processChunk);
      } else {
        setSessionTriggers(prev => {
          const next = JSON.parse(JSON.stringify(prev));
          if (!next[sessionKey]) next[sessionKey] = {};
          if (!next[sessionKey][triggerKey]) next[sessionKey][triggerKey] = { enabled: true };
          next[sessionKey][triggerKey] = {
            ...next[sessionKey][triggerKey],
            ...bestConfig
          };
          return next;
        });
        toast(`Optimización completada. PnL Máximo: ${bestScore.toFixed(2)}R`, 'success');
        setOptimizingTrigger(null);
      }
    };

    requestAnimationFrame(processChunk);
  };
"""

if "const handleOptimizeTrigger = (" not in text:
    text = text.replace("const handleRun = useCallback((overrideOte", handle_opt_func + "\n  const handleRun = useCallback((overrideOte")


with open(file_path, 'w') as f:
    f.write(text)
print("done logic insert")
