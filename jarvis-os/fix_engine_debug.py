import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/services/backtestEngine_debug.ts'
with open(file_path, 'r') as f:
    content = f.read()

# Replace config.fixedRR
old_line = "const activeFixedRR = sessionConfig?.fixedRR ?? config.fixedRR ?? 2.0;"
new_line = "const activeFixedRR = 2.0; // fallback or logic changed"

content = content.replace(old_line, new_line)

with open(file_path, 'w') as f:
    f.write(content)
