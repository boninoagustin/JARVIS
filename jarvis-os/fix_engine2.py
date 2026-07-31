import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/services/backtestEngine.ts'
with open(file_path, 'r') as f:
    content = f.read()

# Replace config.partialClosePct in line 1263
old_line = "        const partialPct = config.partialClosePct ?? 0.5;"
new_line = "        const isChoch = existingTradeForTicker.events?.some(e => e.includes('EVENTO_CHOCH'));\n        const isBos = existingTradeForTicker.events?.some(e => e.includes('EVENTO_BOS'));\n        const hasOte = existingTradeForTicker.events?.some(e => e.includes('OTE_Retracement'));\n        const tfSuffix = existingTradeForTicker.tf === '5' ? '5m' : '15m';\n        let ft = '';\n        if (hasOte && isBos) ft = `oteBos${tfSuffix}`;\n        else if (hasOte && isChoch) ft = `oteChoch${tfSuffix}`;\n        else if (isBos && !hasOte) ft = `bos${tfSuffix}`;\n        else if (isChoch && !hasOte) ft = `choch${tfSuffix}`;\n        const sn = getSessionForTimestamp(existingTradeForTicker.timestamp);\n        const lm = config.sessions?.[sn]?.[ft as keyof typeof config.sessions[typeof sn]] as any;\n        const partialPct = lm?.partialClosePct ?? 0.5;"

content = content.replace(old_line, new_line)

with open(file_path, 'w') as f:
    f.write(content)
