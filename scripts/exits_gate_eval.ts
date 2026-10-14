// exits_gate_eval.ts — contrafactual de la GESTIÓN DE SALIDA por activo (16-sep-2026).
// Re-simula cada trade cerrado (journal desde 14/9) sobre velas M5 REALES de cTrader
// comparando 4 políticas de salida:
//   P0 = real (resultado del journal, con la config viva: parcial/trail/BE reales)
//   P1 = puro TP2/SL (sin parcial, sin BE, sin trail)
//   P2 = parcial 50% en TP1 + SL→BE + resto a TP2/SL
//   P3 = parcial 50% en TP1 + SL original + resto a TP2/SL
// Publica exits_gate_evals/{T} + _GLOBAL para el panel. Corre post-dominical.
import fs from 'fs';
import { loadEnvFile } from 'node:process';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const CUT = Date.now() - 30 * 86400e3; // 🆕 22-sep: ventana 30d rodante (antes fija 14-sep) — más trades para alcanzar n≥30
// 🆕 22-sep (decisión de Bon): la comparación de políticas solo es decidible con muestra
// suficiente. Con n<30 el "mejor" es ruido (caso real: AUDCAD/EURUSD n=1). El panel no
// muestra botón de aplicar si enoughData=false.
const MIN_N = 30;

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
    if (trades.length === 0) {
        console.log('[exits-eval] sin trades cerrados aún. Nada que simular.');
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
                close: Number(b.low) + Number(b.deltaClose ?? 0),
            })).sort((a, b) => a.ts - b.ts));
        } catch { /* skip */ }
    }
    await ct.disconnect();

    const simPolicies = (t: any, bars: any[]): { P1: number | null; P2: number | null; P3: number | null } => {
        const entry = Number(t.entryPrice), sl = Number(t.slPrice), tp1 = Number(t.tp1Price), tp2 = Number(t.tp2Price);
        if (![entry, sl].every(Number.isFinite)) return { P1: null, P2: null, P3: null };
        const risk = Math.abs(entry - sl);
        if (risk <= 0) return { P1: null, P2: null, P3: null };
        const isBuy = t.direction === 'BUY';
        const R1 = Number.isFinite(tp1) ? Math.abs(tp1 - entry) / risk : NaN;
        const R2 = Number.isFinite(tp2) ? Math.abs(tp2 - entry) / risk : NaN;
        const endRaw = t.closedAt;
        const end = typeof endRaw === 'string' ? Date.parse(endRaw) : Number(endRaw ?? Date.now());
        const win = bars.filter(b => b.ts >= t.timestamp && b.ts <= end);
        if (win.length === 0) return { P1: null, P2: null, P3: null };
        const lastClose = win[win.length - 1].close;
        const hitSL = (b: any) => (isBuy ? b.low <= sl : b.high >= sl);
        const hitTP1 = (b: any) => Number.isFinite(R1) && (isBuy ? b.high >= tp1 : b.low <= tp1);
        const hitTP2 = (b: any) => Number.isFinite(R2) && (isBuy ? b.high >= tp2 : b.low <= tp2);
        const hitBE = (b: any) => (isBuy ? b.low <= entry : b.high >= entry);
        const markR = () => (isBuy ? (lastClose - entry) / risk : (entry - lastClose) / risk);

        let P1: number | null = null, P2: number | null = null, P3: number | null = null;
        // P1 puro: SL antes que TP2 en la misma vela (conservador)
        for (const b of win) {
            if (hitSL(b)) { P1 = -1; break; }
            if (hitTP2(b)) { P1 = R2; break; }
        }
        if (P1 === null) P1 = markR();
        // P2: parcial 50% TP1 + BE + resto
        let done = false, banked = 0;
        for (const b of win) {
            if (hitTP1(b)) { banked = 0.5 * R1; break; }
            if (hitSL(b)) { P2 = -1; done = true; break; }
        }
        if (!done && Number.isFinite(R1)) {
            const after = win.filter(b => b.ts > win.find(b => hitTP1(b))?.ts);
            for (const b of after) {
                if (hitTP2(b)) { P2 = banked + 0.5 * R2; break; }
                if (hitBE(b)) { P2 = banked; break; }
            }
            if (P2 === null) P2 = banked + 0.5 * markR();
        }
        // P3: parcial 50% TP1 + SL original
        done = false; banked = 0;
        for (const b of win) {
            if (hitTP1(b)) { banked = 0.5 * R1; break; }
            if (hitSL(b)) { P3 = -1; done = true; break; }
        }
        if (!done && Number.isFinite(R1)) {
            const after = win.filter(b => b.ts > win.find(b => hitTP1(b))?.ts);
            for (const b of after) {
                if (hitTP2(b)) { P3 = banked + 0.5 * R2; break; }
                if (hitSL(b)) { P3 = banked - 0.5; break; }
            }
            if (P3 === null) P3 = banked + 0.5 * markR();
        }
        return { P1, P2, P3 };
    };

    // genes actuales por activo (para mostrar qué config está viva)
    const cfgSnap = await db.collection('asset_configs').get();
    const genes = new Map<string, any>();
    cfgSnap.forEach(d => {
        if (d.id === 'GLOBAL') return;
        const c = d.data();
        genes.set(d.id, {
            partialClosePct: c.partialClosePct ?? 50, tp15BeEnabled: c.tp15BeEnabled !== false,
            atrTrailEnabled: c.atrTrailEnabled === true, slAfterTp1: c.slAfterTp1 ?? 'midpoint',
        });
    });

    const agg = new Map<string, any>();
    const put = (T: string) => {
        if (!agg.has(T)) agg.set(T, { ticker: T, n: 0, R0: 0, R1: 0, R2: 0, R3: 0, genes: genes.get(T) ?? null });
        return agg.get(T)!;
    };
    for (const t of trades) {
        const bars = barsByTicker.get(t.ticker);
        if (!bars || bars.length === 0) continue;
        const a = put(t.ticker);
        const { P1, P2, P3 } = simPolicies(t, bars);
        if (P1 === null && P2 === null && P3 === null) continue;
        a.n++;
        a.R0 += Number(t.rMultiple ?? 0);
        if (P1 !== null) a.R1 += P1;
        if (P2 !== null) a.R2 += P2;
        if (P3 !== null) a.R3 += P3;
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    for (const a of agg.values()) {
        a.R0 = round(a.R0); a.R1 = round(a.R1); a.R2 = round(a.R2); a.R3 = round(a.R3);
        a.enoughData = a.n >= MIN_N; a.minN = MIN_N;
        await db.collection('exits_gate_evals').doc(a.ticker).set({ ...a, evaluatedAt: Date.now() }, { merge: true });
        console.log(`[exits-eval] ${a.ticker}: n=${a.n}${a.enoughData ? '' : ` (insuficiente <${MIN_N})`} R_real=${a.R0} | puro=${a.R1} | parc+BE=${a.R2} | parc-sinBE=${a.R3}`);
    }
    const g = { ticker: '_GLOBAL', n: 0, R0: 0, R1: 0, R2: 0, R3: 0 };
    for (const a of agg.values()) { g.n += a.n; g.R0 += a.R0; g.R1 += a.R1; g.R2 += a.R2; g.R3 += a.R3; }
    g.R0 = round(g.R0); g.R1 = round(g.R1); g.R2 = round(g.R2); g.R3 = round(g.R3);
    (g as any).enoughData = g.n >= MIN_N; (g as any).minN = MIN_N;
    await db.collection('exits_gate_evals').doc('_GLOBAL').set({ ...g, evaluatedAt: Date.now(), tickers: agg.size }, { merge: true });
    console.log(`[exits-eval] ✅ trades=${trades.length} simulados=${g.n} (minN=${MIN_N}) → exits_gate_evals ×${agg.size + 1}`);
    process.exit(0);
}
main().catch(e => { console.error('[exits-eval] ❌', e); process.exit(1); });
