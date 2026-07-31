import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    text = f.read()

text = re.sub(r"style=\{\{ width: '100%', accentColor: 'var\(--accent-(red|green|gold)\)' \}\}", "style={{ width: '100%' }}", text)
text = re.sub(r"style=\{\{ width: '100%', accentColor: '#f7931a' \}\}", "style={{ width: '100%' }}", text)

with open(file_path, 'w') as f:
    f.write(text)
print("done")
