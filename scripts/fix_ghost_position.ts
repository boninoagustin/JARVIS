// fix_ghost_position.ts — reconciliación manual de una posición fantasma.
// Consulta el historial REAL en cTrader (deals de la posición), corrige trade_journal
// y elimina el doc de active_trades. Después: reiniciar JARVIS para limpiar la RAM.
// Uso: npx tsx scripts/fix_ghost_position.ts <positionId> <journalId>
import { readFileSync } from 'node:fs';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const POSITION_ID = parseInt(process.argv[2] || '0', 10);
const JOURNAL_ID = process.argv[3] || '';

function loadEnv(path: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        // Soporta KEY=valor, KEY = 'valor' y KEY = "valor"
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*["']?(.*?)["']?\s*$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

async function main() {
    if (!POSITION_ID || !JOURNAL_ID) {
        console.error('Uso: npx tsx scripts/fix_ghost_position.ts <positionId> <journalId>');
        process.exit(1);
    }
    const env = loadEnv('/opt/JARVIS/.env');
    const sa = JSON.parse(readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
    const db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });

    // 1. Conectar cTrader y traer los deals reales de la posición
    const { connect } = await import('ctrader-ts');
    const client = await connect({
        clientId: env.CTRADER_CLIENT_ID,
        clientSecret: env.CTRADER_CLIENT_SECRET,
        accessToken: env.CTRADER_ACCESS_TOKEN,
        accountId: parseInt(env.CTRADER_ACCOUNT_ID, 10) || 0,
        environment: env.CTRADER_DEMO === 'true' ? 'demo' : 'live',
    });
    const deals: any[] = await (client as any).getDealsByPosition(POSITION_ID);
    console.log(`Deals de posID ${POSITION_ID}: ${deals.length}`);
    let closeDeal: any = null;
    for (const d of deals) {
        const cp = d?.closePositionDetail;
        if (cp) closeDeal = d;
        console.log(` - deal #${d?.dealId} side=${d?.dealSide} vol=${d?.volume} pnl=${cp ? cp.grossProfit : '—'} price=${d?.price ?? '—'}`);
    }
    client.disconnect();

    // 2. Determinar resultado real
    let result = 'BREAKEVEN';
    let rMultiple = 0;
    let pnl = 0;
    let slHit = false;
    if (closeDeal) {
        const cp = closeDeal.closePositionDetail;
        pnl = Number(cp.grossProfit || 0);
        rMultiple = Number((pnl / 50).toFixed(2)); // 1R = $50 (cuenta 5k al 1%)
        if (pnl > 0.5) result = 'WIN';
        else if (pnl < -0.5) result = 'LOSS';
        slHit = (closeDeal as any).stopTriggerBase === 'STOP_LOSS' || (closeDeal as any).closePositionDetail?.closeTriggerBase === 'STOP_LOSS';
    } else {
        console.log('⚠️ Sin deal de cierre en historial — se marca BREAKEVEN conservador.');
    }
    console.log(`→ Resultado real: ${result} | pnl=$${pnl.toFixed(2)} | rMultiple=${rMultiple} | slHit=${slHit}`);

    // 3. Corregir journal
    if (JOURNAL_ID) {
        await db.collection('trade_journal').doc(JOURNAL_ID).set({
            result, rMultiple, ctrader_real_pnl: pnl, slHit,
            closedAt: closeDeal ? new Date((closeDeal as any).executionTimestamp || Date.now()).toISOString() : new Date().toISOString(),
            reconciledBy: 'fix_ghost_position',
        }, { merge: true });
        console.log(`✓ trade_journal/${JOURNAL_ID} actualizado`);
    }

    // 4. Borrar doc de active_trades (si existe para este journal)
    const at = await db.collection('active_trades').doc(JOURNAL_ID).get();
    if (at.exists) {
        await db.collection('active_trades').doc(JOURNAL_ID).delete();
        console.log(`✓ active_trades/${JOURNAL_ID} eliminado`);
    } else {
        console.log('(no había doc en active_trades con ese id — buscar por ctraderPositionId)');
        const q = await db.collection('active_trades').where('ctraderPositionId', '==', String(POSITION_ID)).get();
        for (const d of q.docs) { await d.ref.delete(); console.log(`✓ active_trades/${d.id} eliminado (por positionId)`); }
    }
    console.log('Listo. Reiniciar JARVIS para limpiar la RAM: pm2 restart JARVIS');
    process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); console.error(e.stack); process.exit(1); });
