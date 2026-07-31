import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    text = f.read()

# Fix TriggerSettingsPanelProps
props_pattern = r'interface TriggerSettingsPanelProps \{.*?\n\}'
def props_repl(m):
    s = m.group(0)
    if 'onOptimize' not in s:
        s = s.replace('\n}', '\n  onOptimize: () => void;\n  isOptimizing: boolean;\n}')
    return s
text = re.sub(props_pattern, props_repl, text, flags=re.DOTALL)

# Add optimizingTrigger state
state_pattern = r'const \[tradeFilter, setTradeFilter\] = useState<string>\(\'\'\);'
if 'const [optimizingTrigger' not in text:
    text = text.replace(state_pattern, state_pattern + "\n  const [optimizingTrigger, setOptimizingTrigger] = useState<string | null>(null);")

with open(file_path, 'w') as f:
    f.write(text)
