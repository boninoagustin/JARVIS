import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    text = f.read()

# Fix handleResetConfig
old_reset = """          ...next[s],
          choch5m: { enabled: true, minScore: 4 },
          choch15m: { enabled: true, minScore: 4 },
          bos5m: { enabled: true, minScore: 4 },
          bos15m: { enabled: true, minScore: 4 },
          oteChoch5m: { enabled: true, minScore: 4, entryPercent: next[s].oteChoch5m?.entryPercent ?? 62 },
          oteChoch15m: { enabled: true, minScore: 4, entryPercent: next[s].oteChoch15m?.entryPercent ?? 62, ...migrateMgmt(next[s].oteChoch15m) },
          oteBos15m: { enabled: true, minScore: 4, entryPercent: next[s].oteBos15m?.entryPercent ?? 62, ...migrateMgmt(next[s].oteBos15m) },
          oteBos15m: { enabled: true, minScore: 4, entryPercent: next[s].oteBos15m?.entryPercent ?? 62, ...migrateMgmt(next[s].oteBos15m) },
        };"""

new_reset = """          ...next[s],
          choch15m: { enabled: true, minScore: 4, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 },
          bos15m: { enabled: true, minScore: 4, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 },
          oteChoch15m: { enabled: true, minScore: 4, entryPercent: next[s].oteChoch15m?.entryPercent ?? 62, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 },
          oteBos15m: { enabled: true, minScore: 4, entryPercent: next[s].oteBos15m?.entryPercent ?? 62, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 },
        };"""

text = text.replace(old_reset, new_reset)

with open(file_path, 'w') as f:
    f.write(text)
print("done")
