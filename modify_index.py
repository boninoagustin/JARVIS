import re

with open('src/index.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """                try {
                    const { processTradingAlert } = await import('./db/trading.js');
                    await processTradingAlert(alertText);
                    await db?.collection('trading_incoming').doc(docId).delete();
                } catch (err: any) {
                    console.error('[LOCAL TRADING ERROR] Error procesando update:', err.message);
                    await db?.collection('trading_incoming').doc(docId).update({ status: 'failed' });
                }"""

replacement = """                if (!db) {
                    try {
                        const { processTradingAlert } = await import('./db/trading.js');
                        await processTradingAlert(alertText);
                    } catch (e) {
                        console.error(e);
                    }
                    continue;
                }

                const ref = db.collection('trading_incoming').doc(docId);
                let claimed = false;
                try {
                    claimed = await db.runTransaction(async (tx: any) => {
                        const snap = await tx.get(ref);
                        if (!snap.exists || snap.data()?.status !== 'pending') return false;
                        tx.update(ref, { status: 'processing', claimedAt: Date.now() });
                        return true;
                    });
                } catch { claimed = false; }
                
                if (!claimed) {
                    console.log(`[QUEUE] 🔒 Documento ${docId} ya reclamado por otra instancia o no disponible.`);
                    continue;
                }

                try {
                    const { processTradingAlert } = await import('./db/trading.js');
                    await processTradingAlert(alertText);
                    await ref.delete();
                } catch (err: any) {
                    console.error('[LOCAL TRADING ERROR] Error procesando update:', err.message);
                    await ref.update({ status: 'failed' }).catch(() => {});
                }"""

content = content.replace(target, replacement)

with open('src/index.ts', 'w', encoding='utf-8') as f:
    f.write(content)

