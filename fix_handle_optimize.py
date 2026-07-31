import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    text = f.read()

# Replace handleOptimizeTrigger entirely
old_func_start = "const handleOptimizeTrigger = (sessionKey: string, triggerKey: string) => {"
old_func_end = "requestAnimationFrame(processChunk);\n  };"

new_func = """const handleOptimizeTrigger = async (sessionKey: string, triggerKey: string) => {
    if (optimizingTrigger) return;
    if (uploadedFiles.length === 0) { toast('Subí al menos 1 log', 'error'); return; }
    
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
    
    const logs = new Map<string, string[]>();
    uploadedFiles.forEach(f => logs.set(f.tf, f.lines));
    const logsArray = Array.from(logs.entries());

    const CHUNK_SIZE = 50;
    let i = 0;

    const processChunk = async () => {
      const end = Math.min(i + CHUNK_SIZE, combinations.length);
      const chunkConfigs = [];
      const chunkMgmts = [];
      
      for (; i < end; i++) {
        const testMgmt = combinations[i];
        chunkMgmts.push(testMgmt);
        
        const testSessionTriggers = JSON.parse(JSON.stringify(baseConfig));
        testSessionTriggers[sessionKey][triggerKey] = {
          ...testSessionTriggers[sessionKey][triggerKey],
          ...testMgmt
        };

        const configToRun = {
          ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger: 'SMART' as const,
          maxDailyLossR: maxDailyLossR || undefined,
          dailyProfitTargetR: dailyProfitTargetR || undefined,
          maxConsecutiveLosses: maxConsecutiveLosses || undefined,
          maxTradesPerDay: maxTradesPerDay || undefined,
          maxTradesPerSession: maxTradesPerSession || undefined,
          trailingDrawdownR: trailingDrawdownR || undefined,
          sessions: testSessionTriggers,
          sessionFilter: [sessionKey],
          enabled: true,
          spreadPips,
          commissionPerLot,
          partialClosePct: testMgmt.partialClosePct,
          slAfterTp1: testMgmt.slAfterTp1,
          tp15BeEnabled: testMgmt.tp15BeEnabled,
          atrTrailEnabled: testMgmt.atrTrailEnabled,
          structuralTrailEnabled: testMgmt.structuralTrailEnabled,
          tp1StructuralMinRR: tp1StructuralMinRR
        };
        chunkConfigs.push(configToRun);
      }

      try {
        const chunkResults = await runWorkerTask('RUN_BATCH', { logsArray, configs: chunkConfigs });
        
        for (let j = 0; j < chunkResults.length; j++) {
            const res = chunkResults[j];
            let pnlR = 0;
            let wins = 0;
            let total = 0;
            res.trades.forEach((t: any) => {
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
              bestConfig = chunkMgmts[j];
            }
        }
      } catch (err) {
        console.error("Batch error:", err);
      }

      if (i < combinations.length) {
        requestAnimationFrame(() => { processChunk(); });
      } else {
        setSessionTriggers(prev => {
          const next = JSON.parse(JSON.stringify(prev));
          if (!next[sessionKey]) next[sessionKey] = {};
          if (!next[sessionKey][triggerKey]) next[sessionKey][triggerKey] = { enabled: true };
          next[sessionKey][triggerKey] = {
            ...next[sessionKey][triggerKey],
            ...bestConfig
          };
          localStorage.setItem('bt_session_triggers', JSON.stringify(next));
          return next;
        });
        toast(`Optimización completada. PnL Máximo: ${bestScore.toFixed(2)}R`, 'success');
        setOptimizingTrigger(null);
      }
    };

    processChunk();
  };"""

start_idx = text.find(old_func_start)
end_idx = text.find(old_func_end) + len(old_func_end)

if start_idx != -1 and text.find(old_func_end) != -1:
    text = text[:start_idx] + new_func + text[end_idx:]

with open(file_path, 'w') as f:
    f.write(text)
print("done fix optimize logic")
