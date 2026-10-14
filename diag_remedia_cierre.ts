// Remediación 30-sep: finalizar journal DF3WS7 (XTIUSD) con los deals reales del broker
// y limpiar los trades fantasma EMR98C / R33DI4 (nunca se abrieron en cTrader).
// Usa la inicialización de Firebase del propio bot (memory.ts) — sin doble init.
import { db } from '/opt/JARVIS/src/db/memory.js';
const { finalizeClosedPositionFromDeals } = await import('/opt/JARVIS/src/db/trading.js');

if (!db) { console.log('NO DB'); process.exit(1); }

// 1) XTIUSD: trade OG8QHV, posID 294201070, journal DF3WS7
const atSnap = await db.collection('active_trades').doc('OG8QHV').get();
const trade = atSnap.data() || {};
if (!trade.ticker) {
  console.log('OG8QHV ya no existe en active_trades');
} else {
  try {
    const fin = await finalizeClosedPositionFromDeals('294201070', trade as any);
    console.log('finalize OG8QHV →', JSON.stringify(fin));
    if (fin) {
      await db.collection('trade_journal').doc('DF3WS7').set(
        { result: fin.result, rMultiple: fin.rMultiple, ctrader_real_pnl: fin.pnl, balanceAfterUsd: fin.balanceAfterUsd, slHit: fin.slHit, reconciled: true, closedAt: new Date().toISOString() },
        { merge: true }
      );
      console.log('journal DF3WS7 actualizado.');
    }
    await db.collection('active_trades').doc('OG8QHV').delete();
    console.log('active_trades OG8QHV borrado.');
  } catch (e: any) {
    console.log('ERROR finalize:', e.message);
  }
}

// 2) Fantasmas sin posID
for (const id of ['EMR98C', 'R33DI4']) {
  const s = await db.collection('active_trades').doc(id).get();
  if (s.exists) {
    await db.collection('active_trades').doc(id).delete();
    console.log(`Fantasma ${id} (${(s.data() as any).ticker}) borrado de active_trades.`);
  } else {
    console.log(`${id} ya no existe.`);
  }
}
process.exit(0);
