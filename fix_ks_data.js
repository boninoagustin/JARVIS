// fix_ks_data.js — Fix A: limpiar datos corruptos del journal que disparan el killswitch falso
// 1) ALDQAU: BREAKEVEN pero rMultiple=-7.9823 (fantasma) → rMultiple=0, pnl=0
// 2) AG2E76: stale-open (duplicado de ORH4Y1, misma pos 283956477 ya cerrada BREAKEVEN) → cerrar BREAKEVEN r=0
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
    const tj = db.collection('trade_journal');

    // 1) ALDQAU
    const aldq = await tj.doc('ALDQAU').get();
    if (aldq.exists) {
        const d = aldq.data();
        console.log(`ALDQAU ANTES: result=${d.result} rMultiple=${d.rMultiple} pnl=${d.pnl}`);
        await tj.doc('ALDQAU').update({ rMultiple: 0, pnl: 0 });
        console.log('✅ ALDQAU: rMultiple=-7.9823 → 0, pnl=-1.01 → 0 (BREAKEVEN real = 0R)');
    } else {
        console.log('ALDQAU no existe');
    }

    // 2) AG2E76 — stale-open (posición 283956477 ya cerró BREAKEVEN vía ORH4Y1)
    const ag2 = await tj.doc('AG2E76').get();
    if (ag2.exists) {
        const d = ag2.data();
        console.log(`AG2E76 ANTES: result=${d.result ?? '(open)'} ctraderPositionId=${d.ctraderPositionId}`);
        if (!d.result) {
            await tj.doc('AG2E76').update({
                result: 'BREAKEVEN', rMultiple: 0, pnl: 0,
                closedAt: Date.now(), reconciled: true,
            });
            console.log('✅ AG2E76: stale-open → BREAKEVEN r=0 (misma posición que ORH4Y1, ya cerrada)');
        } else {
            console.log('AG2E76 ya tiene result, no se toca');
        }
    } else {
        console.log('AG2E76 no existe');
    }

    // Verificación final
    const { getFxDayStartMs } = await import('./src/engine/PortfolioModel.js');
    const nowMs = Date.now();
    const fxDayStartMs = getFxDayStartMs(nowMs);
    const snap = await tj.where('timestamp', '>=', fxDayStartMs - 48 * 60 * 60 * 1000).get();
    const trades = snap.docs.map(d => d.data())
        .filter(t => t.mode !== 'backtesting' && t.result)
        .filter(t => (typeof t.closedAt === 'number' ? t.closedAt : t.timestamp) >= fxDayStartMs);
    let dailyPnLR = 0;
    for (const t of trades) {
        let r = Number(t.rMultiple);
        if (!Number.isFinite(r) || t.rMultiple == null) r = (t.result === 'WIN' ? 1.5 : t.result === 'LOSS' ? -1 : 0);
        dailyPnLR += r;
        console.log(`  ${t.id} | ${t.ticker} | ${t.result} | r=${r}`);
    }
    console.log(`\n📊 dailyPnLR tras fix de datos: ${dailyPnLR.toFixed(2)}R (debe ser ≥ -1.5R para no disparar)`);
    process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
