// refix_recent_results.ts — re-clasifica los docs del journal de las últimas 24h con el
// cálculo corregido: PnL NETO (gross+commission+swap) y rMultiple contra el SL estructural.
// Uso: npx tsx scripts/refix_recent_results.ts [--hours 24] [--dry-run]
import 'dotenv/config';
import { db } from '../src/db/memory.js';

const HOURS = Number(process.argv[process.argv.indexOf('--hours') + 1] || 24);
const DRY = process.argv.includes('--dry-run');

async function main() {
    const { getDealsByPosition, connectCTrader } = await import('../src/services/ctrader.js');
    const { computeRMultipleFromPnlUsd } = await import('../src/engine/FrictionModel.js');
    await connectCTrader();
    const cutoff = Date.now() - HOURS * 3600 * 1000;
    const snap = await db.collection('trade_journal')
        .where('closedAt', '>=', new Date(cutoff).toISOString())
        .get();
    let fixed = 0, skipped = 0;
    for (const doc of snap.docs) {
        const d = doc.data();
        if (!d.ctraderPositionId || d.manualResult || d.mode === 'backtesting') { skipped++; continue; }
        if (!d.result && !d.reopened) { skipped++; continue; }
        try {
            const deals = await getDealsByPosition(String(d.ctraderPositionId));
            const closeDeal = deals.find((x: any) => x?.closePositionDetail);
            if (!closeDeal) { skipped++; continue; }
            const cp = closeDeal.closePositionDetail;
            const moneyDigits = Number(closeDeal.moneyDigits ?? cp.moneyDigits ?? 2);
            const rawProfit = Number(cp.grossProfit || 0) + Number(cp.commission || 0) + Number(cp.swap || 0);
            const pnl = rawProfit / Math.pow(10, moneyDigits);
            const result = pnl > 0.1 ? 'WIN' : pnl < -0.1 ? 'LOSS' : 'BREAKEVEN';
            const slHit = closeDeal.stopTriggerBase === 'STOP_LOSS' || cp.closeTriggerBase === 'STOP_LOSS';
            const effSl = d.initialSlPrice ?? d.originalSlPrice ?? d.slPrice;
            const rMultiple = computeRMultipleFromPnlUsd(
                d.ticker, Number(d.entryPrice ?? 0), Number(effSl ?? d.entryPrice ?? 0),
                Number(d.ctraderLots ?? 0), pnl
            );
            const changed = d.result !== result || Math.abs((d.rMultiple ?? 0) - rMultiple) > 0.01;
            if (changed) {
                if (!DRY) await doc.ref.update({ result, rMultiple, ctrader_real_pnl: pnl, slHit, refixedAt: Date.now() });
                console.log(`✅ ${doc.id} (${d.ticker}): ${d.result}/${d.rMultiple} → ${result}/${rMultiple} (pnl $${pnl.toFixed(2)})${DRY ? ' [DRY]' : ''}`);
                fixed++;
            } else {
                console.log(`=  ${doc.id} (${d.ticker}): sin cambios (${result}, ${rMultiple}R, pnl $${pnl.toFixed(2)})`);
            }
        } catch (e: any) {
            console.warn(`⚠️ ${doc.id}: ${e.message}`);
        }
    }
    console.log(`\n${fixed} docs corregidos, ${skipped} salteados (${DRY ? 'DRY-RUN' : 'APLICADO'}).`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
