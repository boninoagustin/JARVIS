// rollover_eval.ts — contrafactual de las REGLAS DE ROLLOVER A/D (16-sep-2026).
// Regla A (SL→BE 20:20-20:28 UTC): para cada trade abierto a través de un rollover,
// simula si el SL ORIGINAL habría sido tocado por el pico de spread (velas M5 reales de
// cTrader en [20:15, 21:05] UTC). Si habría tocado y el trade sobrevivió → la regla salvó.
//   R_salvado = R_real − (−1R) = R_real + 1  (supuesto: BE aplicado, default ON).
// Regla D (bloquear entradas 20:29-21:30 UTC): cuenta las bloqueadas (capturadas por
// logBlockedSignal('ROLLOVER')); su ΣR hipotético lo publica blocked_signals_eval.
// Publica rollover_evals/{T} + _GLOBAL para el panel.
import fs from 'fs';
import { loadEnvFile } from 'node:process';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const CUT = Date.parse('2026-09-14T03:00:00Z');
const WIN_START_MIN = 20 * 60 + 15; // 20:15 UTC
const WIN_END_MIN = 21 * 60 + 5;    // 21:05 UTC

if (admin.apps.length === 0) {
    const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
    const snap = await db.collection('trade_journal').get();
    const trades: any[] = [];
    snap.forEach(d => {
        const x = d.data();
        if ((x.timestamp ?? 0) >= CUT && x.mode === 'live' && x.ctraderStatus === 'EXECUTED' && typeof x.result === 'string') {
            trades.push(x);
        }
    });
    const cfgSnap = await db.collection('asset_configs').get();
    const beEnabled = new Map<string, boolean>();
    cfgSnap.forEach(d => { if (d.id !== 'GLOBAL') beEnabled.set(d.id, d.data().rolloverBeEnabled !== false); });

    // Regla D: bloqueadas por ventana (desde la captura de señales bloqueadas)
    const blkByTicker = new Map<string, number>();
    const SIG = '/opt/JARVIS/logs/blocked_signals.jsonl';
    if (fs.existsSync(SIG)) {
        for (const l of fs.readFileSync(SIG, 'utf8').split('\n')) {
            if (!l.trim()) continue;
            try {
                const r = JSON.parse(l);
                if (r.reason === 'ROLLOVER' && (r.ts ?? 0) >= CUT) {
                    blkByTicker.set(r.ticker, (blkByTicker.get(r.ticker) ?? 0) + 1);
                }
            } catch { /* ignorar */ }
        }
    }

    if (trades.length === 0) {
        console.log('[roll-eval] sin trades cerrados aún.');
        process.exit(0);
    }
    loadEnvFile('/opt/JARVIS/.env');
    const { connect, DEMO_ENDPOINT, TrendbarPeriod } = await import('ctrader-ts');
    const ct = await connect({
        host: DEMO_ENDPOINT, useSSL: true,
        clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET,
        accessToken: process.env.CTRADER_ACCESS_TOKEN, accountId: Number(process.env.CTRADER_ACCOUNT_ID),
    });
    const syms = await ct.getSymbols();
    const idByName = new Map(syms.map(s => [s.symbolName, s.symbolId]));
    const barsByTicker = new Map<string, any[]>();
    for (const T of [...new Set(trades.map(t => t.ticker))]) {
        const sid = idByName.get(T);
        if (sid === undefined) continue;
        try {
            const { trendbars } = await ct.raw.market.getTrendbars({
                symbolId: sid, period: TrendbarPeriod.M5,
                fromTimestamp: CUT - 3600e3, toTimestamp: Date.now(),
            });
            barsByTicker.set(T, trendbars.map(b => ({
                ts: (b.utcTimestampInMinutes ?? 0) * 60000,
                low: Number(b.low), high: Number(b.low) + Number(b.deltaHigh ?? 0),
            })).sort((a, b) => a.ts - b.ts));
        } catch { /* skip */ }
    }
    await ct.disconnect();

    const agg = new Map<string, any>();
    const put = (T: string) => {
        if (!agg.has(T)) agg.set(T, { ticker: T, nVentanas: 0, slTocado: 0, sobrevivio: 0, rSalvado: 0, dBlocked: 0 });
        return agg.get(T)!;
    };
    const now = Date.now();
    for (const t of trades) {
        if (beEnabled.get(t.ticker) === false) continue; // regla A apagada en este activo
        const bars = barsByTicker.get(t.ticker);
        if (!bars || bars.length === 0) continue;
        const entry = Number(t.entryPrice), sl = Number(t.slPrice);
        if (!Number.isFinite(entry) || !Number.isFinite(sl)) continue;
        const isBuy = t.direction === 'BUY';
        const endRaw = t.closedAt;
        const openEnd = typeof endRaw === 'string' ? Date.parse(endRaw) : Number(endRaw ?? now);
        // ventanas de rollover entre apertura y cierre (en días UTC desde el corte)
        for (let day = new Date(Math.max(CUT, t.timestamp)); day.getTime() <= openEnd; day.setUTCDate(day.getUTCDate() + 1)) {
            const wStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + WIN_START_MIN * 60000;
            const wEnd = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + WIN_END_MIN * 60000;
            if (wStart < t.timestamp || wStart >= openEnd) continue; // no estaba abierto en esta ventana
            const winBars = bars.filter(b => b.ts >= wStart && b.ts <= wEnd);
            if (winBars.length === 0) continue;
            const a = put(t.ticker);
            a.nVentanas++;
            const tocado = isBuy ? winBars.some(b => b.low <= sl) : winBars.some(b => b.high >= sl);
            if (tocado) {
                a.slTocado++;
                if (openEnd > wEnd || !Number.isFinite(t.closedAt)) {
                    a.sobrevivio++;
                    a.rSalvado += (Number(t.rMultiple ?? 0)) + 1; // habría sido −1R
                }
            }
        }
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    const all = [...new Set([...agg.keys(), ...blkByTicker.keys()])];
    for (const T of all) {
        const a = agg.get(T) ?? { ticker: T, nVentanas: 0, slTocado: 0, sobrevivio: 0, rSalvado: 0, dBlocked: 0 };
        a.dBlocked = blkByTicker.get(T) ?? 0;
        a.rSalvado = round(a.rSalvado);
        await db.collection('rollover_evals').doc(T).set({ ...a, evaluatedAt: Date.now() }, { merge: true });
        if (a.nVentanas > 0 || a.dBlocked > 0) console.log(`[roll-eval] ${T}: ventanas=${a.nVentanas} SL-tocado=${a.slTocado} sobrevivió=${a.sobrevivio} R_salvado=${a.rSalvado} | D bloqueadas=${a.dBlocked}`);
    }
    const g = { ticker: '_GLOBAL', nVentanas: 0, slTocado: 0, sobrevivio: 0, rSalvado: 0, dBlocked: 0 };
    for (const a of agg.values()) {
        g.nVentanas += a.nVentanas; g.slTocado += a.slTocado; g.sobrevivio += a.sobrevivio; g.rSalvado += a.rSalvado;
    }
    for (const v of blkByTicker.values()) g.dBlocked += v;
    g.rSalvado = round(g.rSalvado);
    await db.collection('rollover_evals').doc('_GLOBAL').set({ ...g, evaluatedAt: Date.now(), tickers: agg.size }, { merge: true });
    console.log(`[roll-eval] ✅ → rollover_evals publicados (ventanas=${g.nVentanas}, salvado=${g.rSalvado}R, D=${g.dBlocked})`);
    process.exit(0);
}
main().catch(e => { console.error('[roll-eval] ❌', e); process.exit(1); });
