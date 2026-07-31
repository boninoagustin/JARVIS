import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/services/backtestEngine.ts'
with open(file_path, 'r') as f:
    text = f.read()

# search for "triggerType" around line 395
lines = text.split('\n')
for i, line in enumerate(lines):
    if "let triggerType" in line:
        print("\n".join(lines[i-5:i+20]))
        break
