// corr_gate_eval.ts — contrafactual del FILTRO DE CORRELACIÓN por activo (16-sep-2026).
// Join: logs/correlation_audit.jsonl (evaluaciones reales del gate en vivo, todas las
// entradas incluidas las directas) × trade_journal (resultados reales desde el corte 14/9).
// Por activo: si el filtro hubiera BLOQUEADO → Δ = −(PnL/R del trade); si hubiera aplicado
// RISK-PARITY → Δ = (riskMult−1)×(PnL/R). Publica corr_gate_evals/{TICKER} para el panel.
// Corre post-dominical (ExecStartPost, liviano) y también a mano: npx tsx scripts/corr_gate_eval.ts
import fs from 'fs';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const CUT = Date.parse('2026-09-14T03:00:00Z'); // mismo corte que el Diario Analítico
const MATCH_MS = 180_000; // ventana de join audit↔journal (±3 min)
const AUDIT = '/opt/JARVIS/logs/correlation_audit.jsonl';

if (admin.apps.length === 0) {
    const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
    // 1) eventos del audit desde el corte
    const audit: any[] = [];
    if (fs.existsSync(AUDIT)) {
        for (const l of fs.readFileSync(AUDIT, 'utf8').split('\n')) {
            if (!l.trim()) continue;
            try {
                const r = JSON.parse(l);
                if (r.ts >= CUT) audit.push(r);
            } catch { /* línea corrupta: ignorar */ }
        }
    }
    // 2) trades reales del journal (ejecutados, desde el corte)
    const snap = await db.collection('trade_journal').get();
    const trades: any[] = [];
    snap.forEach(d => {
        const x = d.data();
        if ((x.timestamp ?? 0) >= CUT && x.mode === 'live' && x.ctraderStatus === 'EXECUTED' && typeof x.result === 'string') {
            trades.push({ ...x, docId: d.id });
        }
    });
    trades.sort((a, b) => a.timestamp - b.timestamp);

    // 3) join greedy: a cada trade, el evento de audit más cercano (mismo ticker+dirección, ≤3 min)
    const used = new Set<number>();
    const matches: Array<{ trade: any; ev: any }> = [];
    for (const t of trades) {
        let best = -1, bestDt = Infinity;
        for (let i = 0; i < audit.length; i++) {
            if (used.has(i)) continue;
            const r = audit[i];
            if (r.ticker !== t.ticker || r.direction !== t.direction) continue;
            const dt = Math.abs(r.ts - t.timestamp);
            if (dt <= MATCH_MS && dt < bestDt) { best = i; bestDt = dt; }
        }
        if (best >= 0) { used.add(best); matches.push({ trade: t, ev: audit[best] }); }
    }
    const unmatchedAudit = audit.length - used.size;

    // 4) agregado por activo
    const agg = new Map<string, any>();
    const put = (T: string) => {
        if (!agg.has(T)) agg.set(T, { ticker: T, n: 0, blk: { n: 0, usd: 0, R: 0 }, rp: { n: 0, usd: 0, R: 0 }, degraded: 0, samples: [] });
        return agg.get(T)!;
    };
    for (const { trade, ev } of matches) {
        const a = put(trade.ticker);
        const pnl = Number(trade.ctrader_real_pnl ?? 0);
        const R = Number(trade.rMultiple ?? 0);
        a.n++;
        if (ev.degraded) a.degraded++;
        if (ev.wouldBlock) {
            a.blk.n++; a.blk.usd -= pnl; a.blk.R -= R;
            a.samples.push(`${trade.direction} ${ev.blockedBy?.map((b: any) => b.otherTicker).join('+')} → ${pnl >= 0 ? 'WIN' : 'LOSS'} (blk ${pnl >= 0 ? '−' : '+'}$${Math.abs(pnl).toFixed(2)})`);
        } else if ((ev.riskMult ?? 1) < 1) {
            const k = ev.riskMult - 1; // negativo: achica la apuesta
            a.rp.n++; a.rp.usd += k * pnl; a.rp.R += k * R;
        }
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    for (const a of agg.values()) {
        a.blk.usd = round(a.blk.usd); a.blk.R = round(a.blk.R);
        a.rp.usd = round(a.rp.usd); a.rp.R = round(a.rp.R);
    }

    // 5) publicar
    for (const a of agg.values()) {
        await db.collection('corr_gate_evals').doc(a.ticker).set({ ...a, evaluatedAt: Date.now() }, { merge: true });
        console.log(`[corr-eval] ${a.ticker}: n=${a.n} blk(${a.blk.n})=${a.blk.usd >= 0 ? '+' : ''}$${a.blk.usd} rp(${a.rp.n})=${a.rp.usd >= 0 ? '+' : ''}$${a.rp.usd} degraded=${a.degraded}`);
    }
    const totals = { ticker: '_GLOBAL', n: 0, blk: { n: 0, usd: 0, R: 0 }, rp: { n: 0, usd: 0, R: 0 }, degraded: 0 };
    for (const a of agg.values()) {
        totals.n += a.n; totals.blk.n += a.blk.n; totals.blk.usd += a.blk.usd; totals.blk.R += a.blk.R;
        totals.rp.n += a.rp.n; totals.rp.usd += a.rp.usd; totals.rp.R += a.rp.R; totals.degraded += a.degraded;
    }
    totals.blk.usd = round(totals.blk.usd); totals.blk.R = round(totals.blk.R);
    totals.rp.usd = round(totals.rp.usd); totals.rp.R = round(totals.rp.R);
    await db.collection('corr_gate_evals').doc('_GLOBAL').set({ ...totals, evaluatedAt: Date.now(), samples: agg.size }, { merge: true });
    console.log(`[corr-eval] ✅ audit=${audit.length} trades=${trades.length} unidos=${matches.length} sin-audit=${unmatchedAudit} → corr_gate_evals ×${agg.size + 1}`);
    process.exit(0);
}
main().catch(e => { console.error('[corr-eval] ❌', e); process.exit(1); });
