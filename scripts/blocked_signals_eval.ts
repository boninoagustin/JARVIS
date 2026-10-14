// blocked_signals_eval.ts — contrafactual de las SEÑALES BLOQUEADAS (16-sep-2026).
// Cada bloqueo del bot (killswitches, MCL, límites, anti-pirámide, SAR, correlación, ML,
// TimesFM) queda en logs/blocked_signals.jsonl con sus parámetros (entry/SL/TP1/TP2).
// Este eval simula qué habría pasado con CADA señal usando velas M5 REALES de cTrader
// (walk-forward: primer objetivo tocado decide el resultado; SL tiene prioridad).
// Publica blocked_signals_evals/_GLOBAL (por razón + por ticker) para el panel.
import fs from 'fs';
import { loadEnvFile } from 'node:process';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const CUT = Date.parse('2026-09-14T03:00:00Z');
const SIG = '/opt/JARVIS/logs/blocked_signals.jsonl';
const MAX_HOLD_MS = 24 * 3600 * 1000; // cap: señal "abierta" si no tocó nada en 24h

if (admin.apps.length === 0) {
    const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
    const sigs: any[] = [];
    if (fs.existsSync(SIG)) {
        for (const l of fs.readFileSync(SIG, 'utf8').split('\n')) {
            if (!l.trim()) continue;
            try {
                const r = JSON.parse(l);
                if ((r.ts ?? 0) >= CUT) sigs.push(r);
            } catch { /* ignorar */ }
        }
    }
    if (sigs.length === 0) {
        console.log('[blk-eval] sin señales bloqueadas registradas aún (desde el corte). Nada que simular.');
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

    // barras M5 por ticker (una llamada por ticker, ventana desde el corte)
    const barsByTicker = new Map<string, any[]>();
    const tickers = [...new Set(sigs.map(s => s.ticker))];
    for (const T of tickers) {
        const sid = idByName.get(T);
        if (sid === undefined) { console.warn(`[blk-eval] ⚠️ ${T} sin symbolId`); continue; }
        try {
            const { trendbars } = await ct.raw.market.getTrendbars({
                symbolId: sid, period: TrendbarPeriod.M5,
                fromTimestamp: CUT - 3600e3, toTimestamp: Date.now(),
            });
            // cTrader proto: low absoluto; high/open/close = low + delta (precios ya escalados por la lib)
            const bars = trendbars.map(b => ({
                ts: (b.utcTimestampInMinutes ?? 0) * 60000,
                low: Number(b.low), high: Number(b.low) + Number(b.deltaHigh ?? 0),
                close: Number(b.low) + Number(b.deltaClose ?? 0),
            })).sort((a, b) => a.ts - b.ts);
            barsByTicker.set(T, bars);
        } catch (e: any) {
            console.warn(`[blk-eval] ⚠️ trendbars ${T}: ${e.message}`);
        }
    }
    await ct.disconnect();

    // simulación
    const sim = (s: any, bars: any[]): { out: string; R: number } => {
        const entry = Number(s.entry), sl = Number(s.sl), tp1 = Number(s.tp1), tp2 = Number(s.tp2);
        if (!Number.isFinite(entry) || !Number.isFinite(sl) || sl === entry) return { out: 'sin-parámetros', R: 0 };
        const risk = Math.abs(entry - sl);
        const isBuy = s.direction === 'BUY';
        const R1 = Number.isFinite(tp1) ? Math.abs(tp1 - entry) / risk : NaN;
        const R2 = Number.isFinite(tp2) ? Math.abs(tp2 - entry) / risk : NaN;
        let lastClose = entry;
        for (const b of bars) {
            if (b.ts < s.ts) continue;
            if (b.ts > s.ts + MAX_HOLD_MS) break;
            lastClose = b.close;
            const hitSL = isBuy ? b.low <= sl : b.high >= sl;
            if (hitSL) return { out: 'SL', R: -1 };
            if (Number.isFinite(R2)) {
                const hitTP2 = isBuy ? b.high >= tp2 : b.low <= tp2;
                if (hitTP2) return { out: 'TP2', R: R2 };
            }
            if (Number.isFinite(R1)) {
                const hitTP1 = isBuy ? b.high >= tp1 : b.low <= tp1;
                if (hitTP1) return { out: 'TP1', R: R1 };
            }
        }
        return { out: 'abierta', R: isBuy ? (lastClose - entry) / risk : (entry - lastClose) / risk };
    };

    const byReason = new Map<string, any>();
    const byTicker = new Map<string, any>();
    for (const s of sigs) {
        const bars = barsByTicker.get(s.ticker);
        if (!bars || bars.length === 0) continue;
        const { out, R } = sim(s, bars);
        const rk = byReason.get(s.reason) ?? { reason: s.reason, n: 0, wins: 0, losses: 0, open: 0, sumR: 0 };
        rk.n++; rk.sumR += R;
        if (out === 'SL') rk.losses++;
        else if (out === 'TP1' || out === 'TP2') rk.wins++;
        else rk.open++;
        byReason.set(s.reason, rk);
        const tk = byTicker.get(s.ticker) ?? { ticker: s.ticker, n: 0, sumR: 0 };
        tk.n++; tk.sumR += R;
        byTicker.set(s.ticker, tk);
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    const reasons = [...byReason.values()].map(r => ({ ...r, sumR: round(r.sumR) })).sort((a, b) => b.n - a.n);
    const ticks = [...byTicker.values()].map(t => ({ ...t, sumR: round(t.sumR) })).sort((a, b) => b.n - a.n);
    const total = { n: reasons.reduce((x, r) => x + r.n, 0), sumR: round(reasons.reduce((x, r) => x + r.sumR, 0)) };

    await db.collection('blocked_signals_evals').doc('_GLOBAL').set({
        ticker: '_GLOBAL', evaluatedAt: Date.now(),
        ...total, reasons, byTicker: ticks,
        simTotal: sigs.length, sinBarras: sigs.length - total.n,
    }, { merge: true });
    console.log(`[blk-eval] señales=${sigs.length} simuladas=${total.n} ΣR_hipotético=${total.sumR >= 0 ? '+' : ''}${total.sumR}`);
    for (const r of reasons) {
        console.log(`  ${r.reason}: n=${r.n} W=${r.wins} L=${r.losses} abiertas=${r.open} ΣR=${r.sumR >= 0 ? '+' : ''}${r.sumR}`);
    }
    process.exit(0);
}
main().catch(e => { console.error('[blk-eval] ❌', e); process.exit(1); });
