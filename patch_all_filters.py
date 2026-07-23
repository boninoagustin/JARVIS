import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace("state.zones.filter(z =>", "state.zones.filter((z: any) =>")

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
