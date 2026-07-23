import re

with open('src/services/ctrader.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """    // Try exact match first
    if (map[t]) return map[t];

    // Try partial match
    for (const [key, value] of Object.entries(map)) {
        if (t.includes(key)) return value;
    }"""

replacement = """    // Exact match primero, alias parciales solo inequívocos:
    if (map[t]) return map[t];
    for (const key of ['XAUUSD', 'BTCUSD', 'NAS100', 'SPX500']) {
        if (t.includes(key)) return map[key];
    }"""

content = content.replace(target, replacement)

with open('src/services/ctrader.ts', 'w', encoding='utf-8') as f:
    f.write(content)
