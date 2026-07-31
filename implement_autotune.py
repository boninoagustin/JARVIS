import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    text = f.read()

# Add Loader2 to imports
text = text.replace("Briefcase, Play, Trash2, FileText, Download, RotateCcw } from 'lucide-react';", "Briefcase, Play, Trash2, FileText, Download, RotateCcw, Loader2 } from 'lucide-react';")

# Add state
text = text.replace("const [tradeFilter, setTradeFilter] = useState<'ALL' | 'WIN' | 'LOSS' | 'BE'>('ALL');", "const [tradeFilter, setTradeFilter] = useState<'ALL' | 'WIN' | 'LOSS' | 'BE'>('ALL');\n  const [optimizingTrigger, setOptimizingTrigger] = useState<string | null>(null);")

# Add handleOptimizeTrigger function right after setOptimizingTrigger (or near handleRun)
handle_opt_func = """
  const handleOptimizeTrigger = async (sessionKey: string, triggerKey: string) => {
    if (optimizingTrigger) return;
    setOptimizingTrigger(`${sessionKey}-${triggerKey}`);
    
    // Config values to test
    const slBuffVals = [0, 0.05, 0.1, 0.2];
    const tp2Vals = [1.5, 2.0, 3.0, 4.0];
    const partialClosePctVals = [0, 0.5, 0.8];
    const slAfterTp1Vals: ('midpoint' | 'breakeven' | 'none')[] = ['none', 'midpoint', 'breakeven'];
    const tp15BeEnabledVals = [true, false];
    const atrTrailEnabledVals = [true, false];
    const structuralTrailEnabledVals = [true, false];

    const combinations = [];
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

    // We clone localMgmt and disable all other sessions and triggers
    const baseConfig = JSON.parse(JSON.stringify(localMgmt));
    if (!baseConfig.sessions) baseConfig.sessions = {};
    
    // Disable everything first
    Object.keys(baseConfig.sessions).forEach(sk => {
      Object.keys(baseConfig.sessions[sk]).forEach(tk => {
        if (typeof baseConfig.sessions[sk][tk] === 'object' && baseConfig.sessions[sk][tk] !== null) {
           baseConfig.sessions[sk][tk].enabled = false;
        }
      });
    });

    // Make sure our target exists
    if (!baseConfig.sessions[sessionKey]) baseConfig.sessions[sessionKey] = {};
    if (!baseConfig.sessions[sessionKey][triggerKey]) baseConfig.sessions[sessionKey][triggerKey] = { enabled: true, minScore: 4 };
    
    baseConfig.sessions[sessionKey][triggerKey].enabled = true;
    baseConfig.sessionFilter = [sessionKey];
    baseConfig.entryTrigger = 'SMART'; // ensure engine allows it to fire

    // We process in chunks so UI doesn't freeze
    const CHUNK_SIZE = 50;
    let i = 0;

    const processChunk = () => {
      const end = Math.min(i + CHUNK_SIZE, combinations.length);
      for (; i < end; i++) {
        const testMgmt = combinations[i];
        const testConfig = { ...baseConfig };
        testConfig.sessions[sessionKey][triggerKey] = {
          ...testConfig.sessions[sessionKey][triggerKey],
          ...testMgmt
        };

        const result = runBacktest(csvData, testConfig);
        
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
        setTimeout(processChunk, 0);
      } else {
        // Finish
        setLocalMgmt(prev => {
          const next = { ...prev };
          if (!next.sessions) next.sessions = {};
          if (!next.sessions[sessionKey]) next.sessions[sessionKey] = {};
          if (!next.sessions[sessionKey][triggerKey]) next.sessions[sessionKey][triggerKey] = { enabled: true };
          next.sessions[sessionKey][triggerKey] = {
            ...next.sessions[sessionKey][triggerKey],
            ...bestConfig
          };
          return next;
        });
        toast(`Optimización completada. PnL: ${bestScore.toFixed(2)}R`, 'success');
        setOptimizingTrigger(null);
      }
    };

    setTimeout(processChunk, 0);
  };
"""

text = text.replace("const handleRun = () => {", handle_opt_func + "\n  const handleRun = () => {")

# Add Wand button next to "Simular"
btn_str = """
            <button className="btn-sm" onClick={() => handleRunConfig(sessionKey, triggerKey)} style={{ backgroundColor: 'var(--accent-gold)', color: '#000', padding: '4px 12px' }}>
              <Play size={12} /> Simular
            </button>
"""
new_btn_str = """
            <button className="btn-sm" onClick={() => handleOptimizeTrigger(sessionKey, triggerKey)} style={{ backgroundColor: 'transparent', color: 'var(--accent-gold)', padding: '4px 8px', border: '1px solid var(--accent-gold)', display: 'flex', alignItems: 'center', gap: '4px' }} disabled={optimizingTrigger !== null}>
              {optimizingTrigger === `${sessionKey}-${triggerKey}` ? <Loader2 size={12} className="spin" /> : <Wand2 size={12} />} {optimizingTrigger === `${sessionKey}-${triggerKey}` ? 'Optimizando...' : 'Optimizar'}
            </button>
            <button className="btn-sm" onClick={() => handleRunConfig(sessionKey, triggerKey)} style={{ backgroundColor: 'var(--accent-gold)', color: '#000', padding: '4px 12px' }} disabled={optimizingTrigger !== null}>
              <Play size={12} /> Simular
            </button>
"""
text = text.replace(btn_str, new_btn_str)

with open(file_path, 'w') as f:
    f.write(text)
print("done")
