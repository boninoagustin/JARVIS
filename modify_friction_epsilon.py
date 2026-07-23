import re

with open('src/engine/FrictionModel.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = "    const hasTp2 = trade.tp2Price !== undefined && trade.tp2Price !== trade.tp1Price && trade.tp2Price !== 0;"
replacement = """    const priceEps = pipValue * 0.1;
    const hasTp2 = trade.tp2Price !== undefined 
        && Math.abs(trade.tp2Price - trade.tp1Price) > priceEps 
        && Math.abs(trade.tp2Price) > priceEps;"""
content = content.replace(target, replacement)

with open('src/engine/FrictionModel.ts', 'w', encoding='utf-8') as f:
    f.write(content)
