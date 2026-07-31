import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    text = f.read()

# Fix the one in baseTrades.filter (line 830-842)
text = re.sub(
    r"const tfSuffix = is15m \? '15m' : '5m';\s*let triggerType: string \| null = null;\s*if \(hasOte && isBos\) triggerType = `oteBos\$\{tfSuffix\}`;[\s\S]*?else if \(isChoch && !hasOte\) triggerType = `choch\$\{tfSuffix\}`;",
    r"const tfSuffix = '15m';\n          let triggerType: 'choch15m' | 'bos15m' | 'oteChoch15m' | 'oteBos15m' | null = null;\n          if (hasOte && isBos) triggerType = `oteBos${tfSuffix}` as any;\n          else if (hasOte && isChoch) triggerType = `oteChoch${tfSuffix}` as any;\n          else if (isBos && !hasOte) triggerType = `bos${tfSuffix}` as any;\n          else if (isChoch && !hasOte) triggerType = `choch${tfSuffix}` as any;",
    text
)

# Fix the one in tripleFilteredTrades (line 1588-1606)
text = re.sub(
    r"const tfSuffix = is15m \? '15m' : '5m';\s*let triggerType: 'choch5m'[\s\S]*?if \(!isGlobal && tradeFilter !== 'ALL'\) \{[\s\S]*?if \(tradeFilter === 'OTE_BOS_15M' && triggerType !== 'oteBos15m'\) return false;\s*\}",
    r"""const tfSuffix = '15m';
        let triggerType: 'choch15m' | 'bos15m' | 'oteChoch15m' | 'oteBos15m' | null = null;
        if (hasOte && isBos) triggerType = `oteBos${tfSuffix}` as any;
        else if (hasOte && isChoch) triggerType = `oteChoch${tfSuffix}` as any;
        else if (isBos && !hasOte) triggerType = `bos${tfSuffix}` as any;
        else if (isChoch && !hasOte) triggerType = `choch${tfSuffix}` as any;

        // 1. Local filter by selected tradeFilter in UI (when not in GLOBAL mode)
        if (!isGlobal && tradeFilter !== 'ALL') {
          if (tradeFilter === 'CHOCH_15M' && triggerType !== 'choch15m') return false;
          if (tradeFilter === 'BOS_15M' && triggerType !== 'bos15m') return false;
          if (tradeFilter === 'OTE_CHOCH_15M' && triggerType !== 'oteChoch15m') return false;
          if (tradeFilter === 'OTE_BOS_15M' && triggerType !== 'oteBos15m') return false;
        }""",
    text
)

with open(file_path, 'w') as f:
    f.write(text)
print("done")
