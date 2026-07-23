import re

with open('src/engine/FrictionModel.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target1 = """    const entryFriction = spreadCost + slippageCost;
    
    // Aplicamos el peor precio de entrada al simulador"""
replacement1 = """    const entryFriction = spreadCost + slippageCost;
    const exitFriction = slippageCost; // Spread applies once per round-trip, slippage twice (entry & exit)
    
    // Aplicamos el peor precio de entrada al simulador"""
content = content.replace(target1, replacement1)

target2 = "    const netRiskDistance = grossRiskDistance + entryFriction + commissionCostInPrice;"
replacement2 = "    const netRiskDistance = grossRiskDistance + entryFriction + exitFriction + commissionCostInPrice;"
content = content.replace(target2, replacement2)

target3 = "    const netRewardDistance = grossRewardDistance - entryFriction - commissionCostInPrice;"
replacement3 = "    const netRewardDistance = grossRewardDistance - entryFriction - exitFriction - commissionCostInPrice;"
content = content.replace(target3, replacement3)

target4 = "        const netRewardDistanceTp2 = grossRewardDistanceTp2 - entryFriction - commissionCostInPrice;"
replacement4 = "        const netRewardDistanceTp2 = grossRewardDistanceTp2 - entryFriction - exitFriction - commissionCostInPrice;"
content = content.replace(target4, replacement4)

with open('src/engine/FrictionModel.ts', 'w', encoding='utf-8') as f:
    f.write(content)
