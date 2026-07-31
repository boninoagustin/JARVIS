import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    text = f.read()

# Add onOptimize and isOptimizing to each TriggerSettingsPanel
text = text.replace('filterKey="CHOCH_15M"', 'filterKey="CHOCH_15M" onOptimize={() => handleOptimizeTrigger(sessionFilter, "choch15m")} isOptimizing={optimizingTrigger === `${sessionFilter}-choch15m`}')
text = text.replace('filterKey="BOS_15M"', 'filterKey="BOS_15M" onOptimize={() => handleOptimizeTrigger(sessionFilter, "bos15m")} isOptimizing={optimizingTrigger === `${sessionFilter}-bos15m`}')
text = text.replace('filterKey="OTE_CHOCH_15M"', 'filterKey="OTE_CHOCH_15M" onOptimize={() => handleOptimizeTrigger(sessionFilter, "oteChoch15m")} isOptimizing={optimizingTrigger === `${sessionFilter}-oteChoch15m`}')
text = text.replace('filterKey="OTE_BOS_15M"', 'filterKey="OTE_BOS_15M" onOptimize={() => handleOptimizeTrigger(sessionFilter, "oteBos15m")} isOptimizing={optimizingTrigger === `${sessionFilter}-oteBos15m`}')

with open(file_path, 'w') as f:
    f.write(text)
print("done optimize inject")
