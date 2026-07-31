import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    text = f.read()

old_block = """          const tfSuffix = '15m';
          let triggerType: 'choch15m' | 'bos15m' | 'oteChoch15m' | 'oteBos15m' | null = null;
          if (hasOte && isBos) triggerType = `oteBos${tfSuffix}` as any;
          else if (hasOte && isChoch) triggerType = `oteChoch${tfSuffix}` as any;
          else if (isBos && !hasOte) triggerType = `bos${tfSuffix}` as any;
          else if (isChoch && !hasOte) triggerType = `choch${tfSuffix}` as any;

          const sessionName = getSessionForTimestamp(t.timestamp);"""

new_block = """          const tfSuffix = '15m';
          let triggerType: 'choch15m' | 'bos15m' | 'oteChoch15m' | 'oteBos15m' | null = null;
          if (hasOte && isBos) triggerType = `oteBos${tfSuffix}` as any;
          else if (hasOte && isChoch) triggerType = `oteChoch${tfSuffix}` as any;
          else if (isBos && !hasOte) triggerType = `bos${tfSuffix}` as any;
          else if (isChoch && !hasOte) triggerType = `choch${tfSuffix}` as any;

          if (!isGlobal && tradeFilter !== 'ALL') {
            if (tradeFilter === 'CHOCH_15M' && triggerType !== 'choch15m') return false;
            if (tradeFilter === 'BOS_15M' && triggerType !== 'bos15m') return false;
            if (tradeFilter === 'OTE_CHOCH_15M' && triggerType !== 'oteChoch15m') return false;
            if (tradeFilter === 'OTE_BOS_15M' && triggerType !== 'oteBos15m') return false;
          }

          const sessionName = getSessionForTimestamp(t.timestamp);"""

text = text.replace(old_block, new_block)

with open(file_path, 'w') as f:
    f.write(text)
print("done")
