const adminModule = require("firebase-admin");
const admin = adminModule.default ?? adminModule;
const fs = require("node:fs");
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
  // últimos 2 días de GBPUSD
  const q = await db.collection('trade_journal')
    .where('ticker', '==', 'GBPUSD')
    .where('date', '>=', '2026-09-06')
    .orderBy('date', 'desc')
    .limit(20).get();
  for (const d of q.docs) {
    const x = d.data();
    console.log('---', d.id);
    console.log(JSON.stringify({
      date: x.date, hourOfDay: x.hourOfDay, direction: x.direction, entryType: x.entryType,
      entryPrice: x.entryPrice, slPrice: x.slPrice, tp1Price: x.tp1Price, tp2Price: x.tp2Price,
      result: x.result, rMultiple: x.rMultiple, slHit: x.slHit, tp1Hit: x.tp1Hit,
      ctraderPositionId: x.ctraderPositionId, ctraderStatus: x.ctraderStatus,
      ctrader_real_pnl: x.ctrader_real_pnl, closedAt: x.closedAt,
      timestamp: x.timestamp ? new Date(x.timestamp).toISOString() : null,
      tf: x.tf, session: x.session, triggerKey: x.triggerKey, grade: x.grade, points: x.points,
      kronosVerdict: x.kronosVerdict, mixtureConsensus: x.mixtureConsensus,
    }, null, 1));
  }
  process.exit(0);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
