import re

with open('src/services/journal.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """        await docRef.update({ result, pnl: pnl || null });"""
replacement = """        await docRef.update({ result, pnl: pnl || null, closedAt: Date.now() });"""

content = content.replace(target, replacement)

with open('src/services/journal.ts', 'w', encoding='utf-8') as f:
    f.write(content)
