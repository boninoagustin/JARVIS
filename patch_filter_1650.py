import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = "const oppositeZones = state.zones.filter(z => {"
replacement = "const oppositeZones = state.zones.filter((z: any) => {"

content = content.replace(target, replacement)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
