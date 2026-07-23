import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. tp1Hit
target1 = """                                        originalSlPrice: trade.originalSlPrice
                                    }).catch(() => {});"""
replacement1 = """                                        originalSlPrice: trade.originalSlPrice
                                    }).then(() => import('../engine/PortfolioModel.js').then(m => m.invalidateRiskCache())).catch(() => {});"""
content = content.replace(target1, replacement1)

# 2. slHalfwayHit
target2 = """                                        slHalfwayHit: true,
                                        slPrice: trade.entryPrice
                                    }).catch(() => {});"""
replacement2 = """                                        slHalfwayHit: true,
                                        slPrice: trade.entryPrice
                                    }).then(() => import('../engine/PortfolioModel.js').then(m => m.invalidateRiskCache())).catch(() => {});"""
content = content.replace(target2, replacement2)

# 3. tp2Hit
target3 = """                                        rMultiple,
                                        durationMin
                                    }).catch(() => {});"""
replacement3 = """                                        rMultiple,
                                        durationMin
                                    }).then(() => import('../engine/PortfolioModel.js').then(m => m.invalidateRiskCache())).catch(() => {});"""
content = content.replace(target3, replacement3)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
