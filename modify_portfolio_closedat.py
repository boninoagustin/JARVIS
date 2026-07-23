import re

with open('src/engine/PortfolioModel.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = """        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .get();"""
replacement1 = """        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs - 48 * 60 * 60 * 1000)
            .get();"""
content = content.replace(target1, replacement1)

target2 = """                return modeMatch && sessionMatch && t.result;
            })
            .sort((a, b) => a.timestamp - b.timestamp);"""
replacement2 = """                return modeMatch && sessionMatch && t.result;
            })
            .filter(t => (typeof t.closedAt === 'number' ? t.closedAt : t.timestamp) >= artMidnightMs)
            .sort((a, b) => (a.closedAt ?? a.timestamp) - (b.closedAt ?? b.timestamp));"""
content = content.replace(target2, replacement2)


with open('src/engine/PortfolioModel.ts', 'w', encoding='utf-8') as f:
    f.write(content)

