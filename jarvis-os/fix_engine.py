import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/services/backtestEngine.ts'
with open(file_path, 'r') as f:
    content = f.read()

# 1. Fix line 736 and 751
old_stEnabled_1 = "              const stOte = trade.events?.some(e => e.includes('OTE_Retracement')) ?? false;\n              const stEnabled = ((stOte ? config.oteManagement : config.directManagement)?.structuralTrailEnabled) ?? config.structuralTrailEnabled ?? true;"
new_stEnabled_1 = "              const isChoch = trade.events?.some(e => e.includes('EVENTO_CHOCH'));\n              const isBos = trade.events?.some(e => e.includes('EVENTO_BOS'));\n              const hasOte = trade.events?.some(e => e.includes('OTE_Retracement'));\n              const tfSuffix = trade.tf === '5' ? '5m' : '15m';\n              let ft = '';\n              if (hasOte && isBos) ft = `oteBos${tfSuffix}`;\n              else if (hasOte && isChoch) ft = `oteChoch${tfSuffix}`;\n              else if (isBos && !hasOte) ft = `bos${tfSuffix}`;\n              else if (isChoch && !hasOte) ft = `choch${tfSuffix}`;\n              const sn = getSessionForTimestamp(trade.timestamp);\n              const lm = config.sessions?.[sn]?.[ft as keyof typeof config.sessions[typeof sn]] as any;\n              const stEnabled = lm?.structuralTrailEnabled ?? false;"

content = content.replace(old_stEnabled_1, new_stEnabled_1)

# 2. Fix line 442 unused variable
content = content.replace("const structuralTrailEnabled = localMgmt?.structuralTrailEnabled ?? false;\n", "")

# 3. Fix line 1263 `config.partialClosePct`
# Wait, 1263 is not in the tick loop? Let's check where it is.
