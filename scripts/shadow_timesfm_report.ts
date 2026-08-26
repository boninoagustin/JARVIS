// Análisis shadow TimesFM: cruza decisiones auditadas (dryRun) con resultados reales del journal.
import 'dotenv/config';
import { db } from '../src/db/memory.js';
import fs from 'node:fs';

const audit = fs.readFileSync('/opt/JARVIS/logs/timesfm_audit.jsonl', 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));

const since = Date.parse('2026-08-17T00:00:00Z');
const snap = await db.collection('trade_journal')
    .where('timestamp', '>=', since)
    .orderBy('timestamp', 'asc')
    .get();

interface T { id: string; ticker: string; direction: string; ts: number; result?: string; pnl?: number; rMultiple?: number; points?: number }
const trades: T[] = snap.docs.map(d => {
    const x = d.data();
    return { id: d.id, ticker: String(x.ticker ?? '').toUpperCase(), direction: String(x.direction ?? ''), ts: Number(x.timestamp ?? 0), result: x.result, pnl: x.pnl, rMultiple: x.rMultiple, points: x.points };
}).filter(t => t.ts > 0);

console.log(`journal desde 17-ago: ${trades.length} trades`);
console.log(`audit: ${audit.length} decisiones`);

// join: mismo ticker+dirección y |Δt| <= 120s
const matched: { trade: T; decision: any; dtSec: number }[] = [];
const usedAudit = new Set<number>();
for (const t of trades) {
    let best: any = null; let bestIdx = -1; let bestDt = Infinity;
    audit.forEach((a, i) => {
        if (usedAudit.has(i)) return;
        if (String(a.ticker).toUpperCase() !== t.ticker || String(a.direction).toUpperCase() !== t.direction) return;
        const dt = Math.abs(Number(a.ts) - t.ts);
        if (dt < bestDt) { bestDt = dt; best = a; bestIdx = i; }
    });
    if (best && bestDt <= 120_000) { matched.push({ trade: t, decision: best, dtSec: bestDt / 1000 }); usedAudit.add(bestIdx); }
}

console.log(`\nmatches: ${matched.length} / ${trades.length} trades · audit sin match: ${audit.length - usedAudit.size}`);

const r = (v: number | undefined | null) => (v == null || Number.isNaN(Number(v))) ? 0 : Number(v);
const groups: Record<string, { n: number; closed: number; wins: number; losses: number; be: number; sumR: number; sumPnl: number }> = {
    APPROVE: { n: 0, closed: 0, wins: 0, losses: 0, be: 0, sumR: 0, sumPnl: 0 },
    REDUCE: { n: 0, closed: 0, wins: 0, losses: 0, be: 0, sumR: 0, sumPnl: 0 },
    REJECT: { n: 0, closed: 0, wins: 0, losses: 0, be: 0, sumR: 0, sumPnl: 0 },
};
const rows: string[] = [];
let realR = 0, shadowR = 0;
for (const m of matched) {
    const g = groups[m.decision.action] ?? groups.APPROVE;
    g.n++;
    const res = m.trade.result;
    if (res) g.closed++;
    const rr = r(m.trade.rMultiple);
    const rm = r(m.decision.riskMult);
    realR += rr;
    const effMult = m.decision.action === 'REJECT' ? 0 : (m.decision.action === 'REDUCE' ? rm : 1);
    shadowR += rr * effMult;
    if (res === 'WIN') g.wins++; else if (res === 'LOSS') g.losses++; else if (res === 'BREAKEVEN') g.be++;
    g.sumR += rr; g.sumPnl += r(m.trade.pnl);
    rows.push(`${m.decision.action.padEnd(7)} ${m.trade.ticker.padEnd(7)} ${m.trade.direction.padEnd(4)} ${String(res ?? 'OPEN').padEnd(9)} r=${rr.toFixed(2).padStart(6)} pnl=${r(m.trade.pnl).toFixed(1).padStart(6)} dt=${m.dtSec.toFixed(0)}s mult=${rm}`);
}
console.log('\n' + rows.join('\n'));
console.log('\n--- por decisión (solo trades matcheados) ---');
for (const [k, g] of Object.entries(groups)) {
    if (!g.n) continue;
    const closed = g.closed || (g.wins + g.losses + g.be);
    console.log(`${k.padEnd(7)} n=${String(g.n).padStart(2)} cerrados=${String(closed).padStart(2)} W=${g.wins} L=${g.losses} BE=${g.be} ΣR=${g.sumR.toFixed(2)} Σpnl=${g.sumPnl.toFixed(1)}`);
}
console.log(`\nREAL: ΣR=${realR.toFixed(2)} (sobre ${matched.length} trades)`);
console.log(`SHADOW (REJECT→0, REDUCE×mult): ΣR=${shadowR.toFixed(2)} → Δ=${(shadowR - realR).toFixed(2)}R (${((shadowR / realR - 1) * 100).toFixed(0)}%)`);
process.exit(0);
