import re

with open('src/services/journal.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update logTrade
target_log = """        await db.collection(JOURNAL_COLLECTION).doc(id).set(cleanRecord);
        console.log(`[JOURNAL] Trade #${id} logged: ${record.ticker} ${record.direction} ${record.grade} (${record.points} pts) | SL:${record.slPrice} TP1:${record.tp1Price} TP2:${record.tp2Price}`);
        return id;"""
replacement_log = """        await db.collection(JOURNAL_COLLECTION).doc(id).set(cleanRecord);
        try {
            const { invalidateRiskCache } = await import('../engine/PortfolioModel.js');
            invalidateRiskCache();
        } catch (e) {}
        console.log(`[JOURNAL] Trade #${id} logged: ${record.ticker} ${record.direction} ${record.grade} (${record.points} pts) | SL:${record.slPrice} TP1:${record.tp1Price} TP2:${record.tp2Price}`);
        return id;"""
content = content.replace(target_log, replacement_log)

# 2. Update recordResult
target_rec = """        await docRef.update({ result, pnl: pnl || null });
        console.log(`[JOURNAL] Trade #${tradeId} recorded as ${result}${pnl ? ` (${pnl > 0 ? '+' : ''}${pnl}%)` : ''}`);
        return true;"""
replacement_rec = """        await docRef.update({ result, pnl: pnl || null });
        try {
            const { invalidateRiskCache } = await import('../engine/PortfolioModel.js');
            invalidateRiskCache();
        } catch (e) {}
        console.log(`[JOURNAL] Trade #${tradeId} recorded as ${result}${pnl ? ` (${pnl > 0 ? '+' : ''}${pnl}%)` : ''}`);
        return true;"""
content = content.replace(target_rec, replacement_rec)

with open('src/services/journal.ts', 'w', encoding='utf-8') as f:
    f.write(content)

