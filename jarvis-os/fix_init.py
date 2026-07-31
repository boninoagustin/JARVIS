import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    lines = f.readlines()

start_idx = -1
end_idx = -1
for i, line in enumerate(lines):
    if "const defTrig: any = { enabled: true" in line:
        start_idx = i
        break

if start_idx != -1:
    for i in range(start_idx, len(lines)):
        if "    const [riskUsd, setRiskUsd] = useState(50);" in lines[i]:
            end_idx = i - 1
            break

if start_idx != -1 and end_idx != -1:
    new_block = """    const defTrig: any = { enabled: true, minScore: 4, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 };
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
    return fallback;
  });
"""
    lines[start_idx:end_idx+1] = [new_block]
    with open(file_path, 'w') as f:
        f.writelines(lines)
    print("Fixed!")
else:
    print("Could not find block boundaries")
