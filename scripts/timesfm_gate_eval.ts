// timesfm_gate_eval.ts — contrafactual del FILTRO TIMESFM por activo (16-sep-2026).
// Join: logs/timesfm_audit.jsonl (veredictos reales del filtro en vivo) × trade_journal
// (resultados reales desde el corte 14/9). Por activo:
//   - Δ riskMult: (mult−1)×PnL/R de los trades ejecutados (APPROVE/REDUCE) — cuánto cambió
//     el resultado el ajuste de tamaño (0 si mult=1).
//   - REJECT: entradas bloqueadas (nunca ejecutaron — su resultado hipotético es incognoscible
//     en vivo; se cuentan para el ledger y el backtest las mide por ablación).
//   - tp2Dynamic: trades con TP2 por q90 (efecto ya embebido en el pnl — solo se cuentan).
// Publica timesfm_gate_evals/{TICKER} + _GLOBAL para el panel (corre post-dominical).
import fs from 'fs';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const CUT = Date.parse('2026-09-14T03:00:00Z');
const MATCH_MS = 180_000;
const AUDIT = '/opt/JARVIS/logs/timesfm_audit.jsonl';

if (admin.apps.length === 0) {
    const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
    const audit: any[] = [];
    if (fs.existsSync(AUDIT)) {
        for (const l of fs.readFileSync(AUDIT, 'utf8').split('\n')) {
            if (!l.trim()) continue;
            try {
                const r = JSON.parse(l);
                if ((r.ts ?? 0) >= CUT) audit.push(r);
            } catch { /* ignorar línea corrupta */ }
        }
    }
    const snap = await db.collection('trade_journal').get();
    const trades: any[] = [];
    snap.forEach(d => {
        const x = d.data();
        if ((x.timestamp ?? 0) >= CUT && x.mode === 'live' && x.ctraderStatus === 'EXECUTED' && typeof x.result === 'string') {
            trades.push(x);
        }
    });
    trades.sort((a, b) => a.timestamp - b.timestamp);

    // join greedy (mismo patrón que corr_gate_eval)
    const used = new Set<number>();
    const matches: Array<{ trade: any; ev: any }> = [];
    for (const t of trades) {
        let best = -1, bestDt = Infinity;
        for (let i = 0; i < audit.length; i++) {
            if (used.has(i)) continue;
            const r = audit[i];
            if (r.ticker !== t.ticker || r.direction !== t.direction) continue;
            const dt = Math.abs((r.ts ?? 0) - t.timestamp);
            if (dt <= MATCH_MS && dt < bestDt) { best = i; bestDt = dt; }
        }
        if (best >= 0) { used.add(best); matches.push({ trade: t, ev: audit[best] }); }
    }

    const agg = new Map<string, any>();
    const put = (T: string) => {
        if (!agg.has(T)) agg.set(T, {
            ticker: T, n: 0, approve: 0, reduce: 0, reject: 0, degraded: 0, tp2Dynamic: 0,
            mult: { n: 0, usd: 0, R: 0 }, samples: [],
        });
        return agg.get(T)!;
    };

    // eventos sin trade ejecutado (rechazos/legs que no ejecutaron)
    for (let i = 0; i < audit.length; i++) {
        if (used.has(i)) continue;
        const r = audit[i];
        if (r.action === 'REJECT' && r.dryRun !== true) put(r.ticker).reject++;
    }

    for (const { trade, ev } of matches) {
        const a = put(trade.ticker);
        const pnl = Number(trade.ctrader_real_pnl ?? 0);
        const R = Number(trade.rMultiple ?? 0);
        a.n++;
        if (ev.action === 'APPROVE') a.approve++;
        else if (ev.action === 'REDUCE') a.reduce++;
        if (ev.degraded) a.degraded++;
        if (ev.tp2Dynamic) a.tp2Dynamic++;
        const mult = Number(ev.riskMult ?? 1);
        if (Number.isFinite(mult) && mult !== 1) {
            const k = mult - 1;
            a.mult.n++; a.mult.usd += k * pnl; a.mult.R += k * R;
            if (mult < 1) a.samples.push(`${ev.action}×${mult} → ${pnl >= 0 ? 'WIN' : 'LOSS'} (${pnl >= 0 ? 'costó' : 'ahorró'} $${Math.abs(k * pnl).toFixed(2)})`);
        }
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    for (const a of agg.values()) {
        a.mult.usd = round(a.mult.usd); a.mult.R = round(a.mult.R);
    }

    for (const a of agg.values()) {
        await db.collection('timesfm_gate_evals').doc(a.ticker).set({ ...a, evaluatedAt: Date.now() }, { merge: true });
        console.log(`[tfm-eval] ${a.ticker}: n=${a.n} approve=${a.approve} reduce=${a.reduce} reject=${a.reject} Δmult=${a.mult.usd >= 0 ? '+' : ''}$${a.mult.usd} degradadas=${a.degraded}`);
    }
    const g = { ticker: '_GLOBAL', n: 0, approve: 0, reduce: 0, reject: 0, degraded: 0, tp2Dynamic: 0, mult: { n: 0, usd: 0, R: 0 } };
    for (const a of agg.values()) {
        g.n += a.n; g.approve += a.approve; g.reduce += a.reduce; g.reject += a.reject;
        g.degraded += a.degraded; g.tp2Dynamic += a.tp2Dynamic;
        g.mult.n += a.mult.n; g.mult.usd += a.mult.usd; g.mult.R += a.mult.R;
    }
    g.mult.usd = round(g.mult.usd); g.mult.R = round(g.mult.R);
    await db.collection('timesfm_gate_evals').doc('_GLOBAL').set({ ...g, evaluatedAt: Date.now(), tickers: agg.size }, { merge: true });
    console.log(`[tfm-eval] ✅ audit=${audit.length} trades=${trades.length} unidos=${matches.length} → timesfm_gate_evals ×${agg.size + 1}`);
    process.exit(0);
}
main().catch(e => { console.error('[tfm-eval] ❌', e); process.exit(1); });
