import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Match `.filter(e =>`, `.some(e =>`, `.catch(e =>`
content = re.sub(r'\.filter\(e =>', r'.filter((e: any) =>', content)
content = re.sub(r'\.some\(e =>', r'.some((e: any) =>', content)
content = re.sub(r'\.catch\(e =>', r'.catch((e: any) =>', content)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
