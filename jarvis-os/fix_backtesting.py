import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    content = f.read()

# 1. Replace the state initialization inside `useState<Record<string, ...>>(() => {`
old_init_block = """    try {
      const saved = localStorage.getItem('bt_session_triggers');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed['ALL'] && !parsed['OFF']) {
          parsed['OFF'] = parsed['ALL'];
        }

        for (const s of ['OFF', 'LONDON', 'NY', 'ASIA']) {
          if (!parsed[s]) {
            parsed[s] = {
              choch5m: { enabled: true, minScore: 5 }, choch15m: { enabled: true, minScore: 5 },
              bos5m: { enabled: true, minScore: 10 }, bos15m: { enabled: true, minScore: 10 },
              oteChoch5m: { enabled: true, minScore: 8, entryPercent: 62 }, oteChoch15m: { enabled: true, minScore: 8, entryPercent: 62 },
              oteBos5m: { enabled: true, minScore: 8, entryPercent: 62 }, oteBos15m: { enabled: true, minScore: 8, entryPercent: 62 },
              slBufferPercent: 0.1,
              fixedRR: 2.0,
              maxSellLosses: 0,
              maxBuyLosses: 0
            };
            const defTrig: any = { enabled: false, minScore: 4, slBuff: 0, tp2: 1.5, partialClosePct: 0, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 };
            const defOte: any = { ...defTrig, entryPercent: 62 };
            if (!parsed[s].choch15m) parsed[s].choch15m = { ...defTrig };
            if (!parsed[s].bos15m) parsed[s].bos15m = { ...defTrig };
            if (!parsed[s].oteChoch15m) parsed[s].oteChoch15m = { ...defOte };
            if (!parsed[s].oteBos15m) parsed[s].oteBos15m = { ...defOte };
            if (parsed[s].oteChoch15m.entryPercent === undefined) parsed[s].oteChoch15m.entryPercent = 62;
            if (parsed[s].oteBos15m.entryPercent === undefined) parsed[s].oteBos15m.entryPercent = 62;

            delete parsed[s].choch5m;
            delete parsed[s].bos5m;
            delete parsed[s].oteChoch5m;
            delete parsed[s].oteBos5m;
            delete parsed[s].slBufferPercent;
            delete parsed[s].fixedRR;
          }
        }
        return parsed;
      }
    } catch (e) {
      console.error(e);
    }
    
    // Default si falla
    const defTrig: any = { enabled: true, minScore: 4, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 };
    const defOte: any = { ...defTrig, entryPercent: 62 };

    return {
      OFF: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 },
      LONDON: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 },
      NY: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 },
      ASIA: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 }
    };"""

new_init_block = """    const defTrig: any = { enabled: true, minScore: 4, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 };
    const defOte: any = { ...defTrig, entryPercent: 62 };
    const fallback = {
      OFF: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 },
      LONDON: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 },
      NY: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 },
      ASIA: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 }
    };
    try {
      const saved = localStorage.getItem('bt_session_triggers');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed['ALL'] && !parsed['OFF']) {
          parsed['OFF'] = parsed['ALL'];
        }
        for (const s of ['OFF', 'LONDON', 'NY', 'ASIA']) {
          if (!parsed[s]) {
             parsed[s] = JSON.parse(JSON.stringify(fallback[s as keyof typeof fallback]));
          } else {
             // Migrate old structures
             const oldChoch = parsed[s].choch15m || {};
             parsed[s].choch15m = { ...defTrig, ...oldChoch };
             const oldBos = parsed[s].bos15m || {};
             parsed[s].bos15m = { ...defTrig, ...oldBos };
             const oldOteChoch = parsed[s].oteChoch15m || {};
             parsed[s].oteChoch15m = { ...defOte, ...oldOteChoch };
             const oldOteBos = parsed[s].oteBos15m || {};
             parsed[s].oteBos15m = { ...defOte, ...oldOteBos };
             
             delete parsed[s].choch5m;
             delete parsed[s].bos5m;
             delete parsed[s].oteChoch5m;
             delete parsed[s].oteBos5m;
             delete parsed[s].slBufferPercent;
             delete parsed[s].fixedRR;
          }
        }
        return parsed;
      }
    } catch (e) {
      console.error(e);
    }
    return fallback;"""

if old_init_block in content:
    content = content.replace(old_init_block, new_init_block)
else:
    print("WARNING: init block not found")

# 2. Fix `handleResetConfig`
old_reset_block = """  const handleResetConfig = useCallback(() => {
    setMinBuyPoints(4);
    setMinSellPoints(4);
    
    setSessionTriggers(prev => {
      const next = { ...prev };
      for (const s of Object.keys(next)) {
        next[s] = {
          ...next[s],
          choch5m: { enabled: true, minScore: 4 },
          choch15m: { enabled: true, minScore: 4 },
          bos5m: { enabled: true, minScore: 4 },
          bos15m: { enabled: true, minScore: 4 },
          oteChoch5m: { enabled: true, minScore: 4, entryPercent: next[s].oteChoch5m?.entryPercent ?? 62 },
          oteChoch15m: { enabled: true, minScore: 4, entryPercent: next[s].oteChoch15m?.entryPercent ?? 62, ...migrateMgmt(next[s].oteChoch15m) },
          oteBos15m: { enabled: true, minScore: 4, entryPercent: next[s].oteBos15m?.entryPercent ?? 62, ...migrateMgmt(next[s].oteBos15m) },
          oteBos15m: { enabled: true, minScore: 4, entryPercent: next[s].oteBos15m?.entryPercent ?? 62, ...migrateMgmt(next[s].oteBos15m) },
        };
      }
      localStorage.setItem('bt_session_triggers', JSON.stringify(next));
      return next;
    });
  }, []);"""

new_reset_block = """  const handleResetConfig = useCallback(() => {
    setMinBuyPoints(4);
    setMinSellPoints(4);
    
    setSessionTriggers(prev => {
      const defTrig: any = { enabled: true, minScore: 4, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 };
      const defOte: any = { ...defTrig, entryPercent: 62 };
      
      const next = { ...prev };
      for (const s of Object.keys(next)) {
        next[s] = {
          ...next[s],
          choch15m: { ...defTrig },
          bos15m: { ...defTrig },
          oteChoch15m: { ...defOte, entryPercent: next[s].oteChoch15m?.entryPercent ?? 62 },
          oteBos15m: { ...defOte, entryPercent: next[s].oteBos15m?.entryPercent ?? 62 },
        };
      }
      localStorage.setItem('bt_session_triggers', JSON.stringify(next));
      return next;
    });
  }, []);"""

if old_reset_block in content:
    content = content.replace(old_reset_block, new_reset_block)
else:
    print("WARNING: reset block not found")

# 3. Fix line 1652 `triggerConfig = config[triggerType] as any;` but Wait, let's fix choch5m line directly
content = re.sub(r'const triggerConfig = config\[triggerType\] as any;.*?\n.*?const slBuff = triggerConfig\?.slBuff \?\? 0\.1;', 'const triggerConfig = config[triggerType] as any;\n          const slBuff = triggerConfig?.slBuff ?? 0.1;', content, flags=re.DOTALL)
# Actually, the error was: "Property 'choch5m' does not exist on type ... Did you mean 'choch15m'?"
# Where is choch5m on line 1652? Let's check the code around 1652.
