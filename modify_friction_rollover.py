import re

with open('src/engine/FrictionModel.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """    const hourUTC = new Date(nowMs).getUTCHours();
    // 17:00 NY time is rollover "Death Spread" hour
    if (hourUTC === 21) {"""
replacement = """    const hourUTC = new Date(nowMs).getUTCHours();
    // 17:00 America/New_York = 21:00 UTC (EDT) / 22:00 UTC (EST)
    if (hourUTC === 21 || hourUTC === 22) {"""
content = content.replace(target, replacement)

with open('src/engine/FrictionModel.ts', 'w', encoding='utf-8') as f:
    f.write(content)
