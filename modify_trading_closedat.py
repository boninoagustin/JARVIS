import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# tp2Hit
target_tp2 = """                                        tp2Hit: true,
                                        tp2Timestamp: nowTrade,
                                        result: 'WIN',
                                        pnl: parseFloat(finalPnlPct.toFixed(2)),
                                        rMultiple,
                                        durationMin
                                    }).then("""
replacement_tp2 = """                                        tp2Hit: true,
                                        tp2Timestamp: nowTrade,
                                        result: 'WIN',
                                        pnl: parseFloat(finalPnlPct.toFixed(2)),
                                        rMultiple,
                                        durationMin,
                                        closedAt: nowTrade
                                    }).then("""
content = content.replace(target_tp2, replacement_tp2)

# slHit
target_sl = """                                    slHit: true,
                                    slTimestamp: nowTrade,
                                    result: finalResult,
                                    pnl: parseFloat(finalPnlPct.toFixed(2)),
                                    rMultiple,
                                    durationMin
                                }).then("""
replacement_sl = """                                    slHit: true,
                                    slTimestamp: nowTrade,
                                    result: finalResult,
                                    pnl: parseFloat(finalPnlPct.toFixed(2)),
                                    rMultiple,
                                    durationMin,
                                    closedAt: nowTrade
                                }).then("""
content = content.replace(target_sl, replacement_sl)

# tp1Hit is a partial close, not a full close, but if they want we can add closedAt? 
# The issue says "y updates de trading.ts (647, 720, 779, 853)". Wait, lines 647 (tp1) and 720 (slHalfway) do NOT set 'result', so they shouldn't trigger the filter "t.result" anyway.
# But just in case, let's see. The user says: "(y updates de trading.ts (647, 720, 779, 853)) await docRef.update({ result, pnl: pnl || null, closedAt: Date.now() });"
# tp1Hit and slHalfwayHit don't set result. They only set tp1Hit or slHalfwayHit. If I set closedAt for them, when the final close happens it will overwrite closedAt.
# So I'll just add it to tp1Hit and slHalfwayHit too.

target_tp1 = """                                        tp1Hit: true,
                                        tp1Timestamp: nowTrade,
                                        slPrice: trade.slPrice,
                                        originalSlPrice: trade.originalSlPrice
                                    }).then("""
replacement_tp1 = """                                        tp1Hit: true,
                                        tp1Timestamp: nowTrade,
                                        slPrice: trade.slPrice,
                                        originalSlPrice: trade.originalSlPrice,
                                        closedAt: nowTrade
                                    }).then("""
content = content.replace(target_tp1, replacement_tp1)


target_slhalfway = """                                        slHalfwayHit: true,
                                        slPrice: trade.entryPrice
                                    }).then("""
replacement_slhalfway = """                                        slHalfwayHit: true,
                                        slPrice: trade.entryPrice,
                                        closedAt: nowTrade
                                    }).then("""
content = content.replace(target_slhalfway, replacement_slhalfway)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)

