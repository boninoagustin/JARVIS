// Limpieza one-time del trade_journal: reapertura de journals cerrados con posición viva,
// dedupe de duplicados por ctraderPositionId y resolución de abiertos con deals reales.
// Uso: npx tsx scripts/limpiar_journal.ts          → DRY-RUN (solo muestra cambios)
//       npx tsx scripts/limpiar_journal.ts --apply  → aplica los cambios
import 'dotenv/config';
import { db } from '../src/db/memory.js';

const apply = process.argv.includes('--apply');
const changes: string[] = [];
const act = async (label: string, fn: () => Promise<any>) => {
    changes.push(label);
    if (apply) { try { await fn(); } catch (e: any) { console.warn('  ⚠️ fallo:', e.message); } }
};

// 1) Estado real del broker
const { getOpenPositions, getDealsByPosition, connectCTrader } = await import('../src/services/ctrader.js');
await connectCTrader();
const open = await getOpenPositions();
const openIds = new Set(open.map((p: any) => String(p.positionId)));
console.log(`Posiciones abiertas en cTrader: [${[...openIds].join(', ') || 'ninguna'}]`);

// 2) Journal reciente
const snap = await db.collection('trade_journal').orderBy('timestamp', 'desc').limit(500).get();
const docs = snap.docs.map(d => ({ ref: d.ref, id: d.id, ...d.data() }));
console.log(`Docs de journal analizados: ${docs.length}\n`);

const byPid = new Map<string, any[]>();
for (const d of docs) {
    const pid = d.ctraderPositionId ? String(d.ctraderPositionId) : '';
    if (!pid) continue;
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid)!.push(d);
}

// active_trades → tradeId→posID (para docs viejos sin ctraderPositionId en el journal)
const activeMap = new Map<string, string>();
try {
    const atSnap = await db.collection('active_trades').get();
    for (const d of atSnap.docs) {
        const x = d.data();
        if (x.ctraderPositionId) activeMap.set(d.id, String(x.ctraderPositionId));
    }
} catch (e: any) { console.warn('no se pudo leer active_trades:', e.message); }
console.log(`active_trades con posID: ${activeMap.size}`);

// 3bis) Reapertura para docs SIN pid: id del doc = tradeId activo con posición viva
for (const d of docs) {
    if (d.result && !d.reopened && !d.ctraderPositionId) {
        const pid = activeMap.get(d.id);
        if (pid && openIds.has(pid)) {
            await act(`REABRIR #${d.id} (${d.ticker} ${d.direction}, trade activo posID ${pid} sigue VIVO; result previo=${d.result})`,
                () => d.ref.update({ result: null, closedAt: null, rMultiple: null, slHit: null, reopened: true, reopenedAt: Date.now() }));
        }
    }
}

// 4bis) Dedupe sin pid: mismo ticker+dirección y timestamp ±90s → duplicados
const noPid = docs.filter(d => !d.ctraderPositionId);
const grouped = new Map<string, any[]>();
for (const d of noPid) {
    const key = `${String(d.ticker).toUpperCase()}|${String(d.direction).toUpperCase()}|${Math.round(Number(d.timestamp ?? 0) / 90000)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(d);
}
for (const [, group] of grouped.entries()) {
    if (group.length < 2) continue;
    const withResult = group.filter(d => d.result);
    const openDocs2 = group.filter(d => !d.result);
    if (withResult.length >= 1 && openDocs2.length >= 1) {
        const keeper = withResult.sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0))[0];
        for (const d of openDocs2) {
            await act(`DUPLICADO #${d.id} → duplicateOf #${keeper.id} (mismo ticker/dir/ts, sin posID)`,
                () => d.ref.update({ duplicateOf: keeper.id }));
        }
    } else if (openDocs2.length > 1) {
        const keeper = [...openDocs2].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0))[0];
        for (const d of openDocs2) {
            if (d.id !== keeper.id) {
                await act(`DUPLICADO #${d.id} → duplicateOf #${keeper.id} (mismo ticker/dir/ts, sin posID)`,
                    () => d.ref.update({ duplicateOf: keeper.id }));
            }
        }
    }
}

for (const [pid, group] of byPid.entries()) {
    const alive = openIds.has(pid);

    // 3) Reapertura: result pero posición viva en el broker
    for (const d of group) {
        if (d.result && !d.reopened && alive) {
            await act(`REABRIR #${d.id} (${d.ticker} ${d.direction}, posID ${pid} sigue VIVA; result previo=${d.result})`,
                () => d.ref.update({ result: null, closedAt: null, rMultiple: null, slHit: null, reopened: true, reopenedAt: Date.now() }));
        }
    }

    // 4) Dedupe: varios docs abiertos para el mismo posID
    const openDocs = group.filter(d => !d.result && !d.reopened);
    if (openDocs.length > 1) {
        const keeper = [...openDocs].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0))[0];
        for (const d of openDocs) {
            if (d.id !== keeper.id) {
                await act(`DUPLICADO #${d.id} → duplicateOf #${keeper.id} (posID ${pid})`,
                    () => d.ref.update({ duplicateOf: keeper.id }));
            }
        }
    }

    // 5) Abiertos cuya posición ya cerró en el broker → resolver con deals
    if (!alive) {
        for (const d of openDocs) {
            if (Date.now() - Number(d.timestamp ?? 0) < 5 * 60_000) continue; // gracia
            const deals = await getDealsByPosition(pid);
            const closeDeal = deals.find((x: any) => x?.closePositionDetail);
            if (!closeDeal) continue;
            const cp = closeDeal.closePositionDetail;
            const moneyDigits = Number(closeDeal.moneyDigits ?? cp.moneyDigits ?? 2);
            const pnl = Number(cp.grossProfit || 0) / Math.pow(10, moneyDigits);
            const result = pnl > 0.5 ? 'WIN' : pnl < -0.5 ? 'LOSS' : 'BREAKEVEN';
            await act(`RESOLVER #${d.id} (${d.ticker}, posID ${pid} cerrada) → ${result} pnl=$${pnl.toFixed(2)}`,
                () => d.ref.set({ result, ctrader_real_pnl: pnl, reconciled: true, closedAt: new Date().toISOString() }, { merge: true }));
        }
    }
}

console.log('\n─────────────────────────────────────');
console.log(apply ? `APLICADO: ${changes.length} cambios.` : `DRY-RUN: ${changes.length} cambios que se aplicarían.`);
console.log('─────────────────────────────────────');
for (const c of changes) console.log(`  · ${c}`);
process.exit(0);
