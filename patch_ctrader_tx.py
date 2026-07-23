import re

with open('src/services/ctrader.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """            // Acumular PnL de deals parciales (no sobreescribir)
            const previousPnl = trade.ctrader_real_pnl || 0;
            const accumulatedPnl = Number((previousPnl + dealPnl).toFixed(2));

            // Posición cerrada completamente (Hit SL o Hit TP final)
            if (positionStatus === 3) {
                let resultStatus: string;
                if (accumulatedPnl > 1) resultStatus = 'WIN';
                else if (accumulatedPnl < -1) resultStatus = 'LOSS';
                else resultStatus = 'BREAKEVEN';

                await tradeDoc.ref.update({
                    result: resultStatus,
                    ctrader_real_pnl: accumulatedPnl,
                    status: 'CLOSED'
                });
                console.log(`[CTRADER-EVENT] Trade #${tradeDoc.id} cerrado. PnL Acumulado: $${accumulatedPnl} -> ${resultStatus}`);
            }
            // Posición aún abierta pero hubo un deal (cierre parcial)
            else if (positionStatus === 2 && event.deal && dealPnl !== 0) {
                await tradeDoc.ref.update({
                    result: 'PARTIAL_TP1',
                    ctrader_real_pnl: accumulatedPnl,
                    tp1Hit: true
                });
                console.log(`[CTRADER-EVENT] Trade #${tradeDoc.id} cierre parcial. Deal PnL: $${dealPnl}, Acumulado: $${accumulatedPnl}`);
            }"""

replacement = """            // Acumular PnL de deals parciales (no sobreescribir) usando transacción atómica
            await db.runTransaction(async (tx: any) => {
                const fresh = await tx.get(tradeDoc.ref);
                if (!fresh.exists) return;
                
                const accumulatedPnl = Number(((fresh.data()?.ctrader_real_pnl || 0) + dealPnl).toFixed(2));
                
                if (positionStatus === 3) { // CLOSED
                    const resultStatus = accumulatedPnl > 1 ? 'WIN' : accumulatedPnl < -1 ? 'LOSS' : 'BREAKEVEN';
                    tx.update(tradeDoc.ref, { result: resultStatus, ctrader_real_pnl: accumulatedPnl, status: 'CLOSED' });
                    console.log(`[CTRADER-EVENT] Trade #${tradeDoc.id} cerrado. PnL Acumulado: $${accumulatedPnl} -> ${resultStatus}`);
                } else if (positionStatus === 2 && event.deal && dealPnl !== 0) { // ABIERTA con cierre parcial
                    tx.update(tradeDoc.ref, { result: 'PARTIAL_TP1', ctrader_real_pnl: accumulatedPnl, tp1Hit: true });
                    console.log(`[CTRADER-EVENT] Trade #${tradeDoc.id} cierre parcial. Deal PnL: $${dealPnl}, Acumulado: $${accumulatedPnl}`);
                }
            });"""

content = content.replace(target, replacement)

with open('src/services/ctrader.ts', 'w', encoding='utf-8') as f:
    f.write(content)
