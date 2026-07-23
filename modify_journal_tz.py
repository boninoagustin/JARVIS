import re

with open('src/services/journal.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = "const date = new Date(Number(record.timestamp)).toISOString().split('T')[0];"
replacement = "const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date(Number(record.timestamp)));"
content = content.replace(target, replacement)

with open('src/services/journal.ts', 'w', encoding='utf-8') as f:
    f.write(content)
