import re

with open('jarvis-os/src/services/backtestTypes.ts', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace("tp1Hit?: boolean; slHalfwayHit?: boolean;", "tp1Hit?: boolean; tp1_5Hit?: boolean; slHalfwayHit?: boolean;")

with open('jarvis-os/src/services/backtestTypes.ts', 'w', encoding='utf-8') as f:
    f.write(content)
