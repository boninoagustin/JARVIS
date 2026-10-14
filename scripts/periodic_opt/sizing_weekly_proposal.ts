// Sizing weekly proposal (sep-2026) — módulo del dominical, DESACTIVADO por flag en run_weekly.py.
// Calcula expectancy por SESIÓN con ventana móvil (WIN/LOSS del trade_journal), propone
// factores de sizing fraccional (clamp 0.4..1.6, K=0.5, n>=8, banda muerta |exp|<0.15 → factor 1).
// Escribe reports/sizing_proposal.json + secuencias para MC (opt_out/sizing_*.json).
// Regla de oro: PROPONE, NO aplica. Uso: npx tsx scripts/periodic_opt/sizing_weekly_proposal.ts
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const WINDOW_DAYS = 84;   // 12 semanas
const MIN_N = 8;          // mínimo de muestra por celda
const K = 0.5;            // sensibilidad: factor = 1 + K·exp
const FLOOR = 0.4, CAP = 1.6;
const DEADBAND = 0.15;    // |exp| menor → factor 1 (sin propuesta)

function sessionFromTs(ts: number): string {
    const d = new Date(ts);
    const arH = (d.getUTCHours() - 3 + 24) % 24;
    const dec = arH + d.getUTCMinutes() / 60;
    if (dec >= 21 || dec < 4) return 'OFF';
    if (dec >= 4 && dec < 10.5) return 'ASIA';
    if (dec >= 10.5 && dec < 17) return 'LONDON';
    return 'NY';
}

async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();

    const since = Date.now() - WINDOW_DAYS * 24 * 3600 * 1000;
    const snap = await db.collection("trade_journal").get();
    const trades = snap.docs.map((d: any) => d.data()).filter((t: any) =>
        t.mode !== "backtesting"
        && (t.result === "WIN" || t.result === "LOSS")
        && typeof t.rMultiple === "number" && isFinite(t.rMultiple) && t.rMultiple !== 0
        && Number(t.timestamp ?? t.closedAt ?? 0) >= since
    );

    interface Cell { n: number; w: number; r: number; }
    const bySess = new Map<string, Cell>();
    const seq: { r: number; sess: string }[] = [];
    for (const t of trades) {
        const r = t.rMultiple;
        const ts = Number(t.timestamp ?? t.closedAt ?? 0);
        const sess = t.session || sessionFromTs(ts);
        const a = bySess.get(sess) || { n: 0, w: 0, r: 0 };
        a.n++; a.r += r; if (r > 0) a.w++;
        bySess.set(sess, a);
        seq.push({ r, sess });
    }

    const cells: Record<string, any> = {};
    const factors: Record<string, number> = {};
    let proposedCells = 0;
    for (const [sess, v] of bySess) {
        const exp = v.r / v.n;
        let factor = 1;
        if (v.n >= MIN_N && Math.abs(exp) >= DEADBAND) {
            factor = Math.min(CAP, Math.max(FLOOR, 1 + K * exp));
            proposedCells++;
        }
        cells[sess] = { n: v.n, wr: +(v.w / v.n).toFixed(2), exp: +exp.toFixed(3), factor: +factor.toFixed(2) };
        factors[sess] = factor;
    }

    // Secuencias para MC: base (factor 1) vs ponderada (factor de sesión)
    const baseSeq = seq.map(t => t.r);
    const wSeq = seq.map(t => +(t.r * (factors[t.sess] ?? 1)).toFixed(3));

    const out = {
        generatedAt: new Date().toISOString(),
        windowDays: WINDOW_DAYS,
        n: trades.length,
        status: proposedCells > 0 ? "PROPUESTA" : "HOLD",
        reason: proposedCells > 0
            ? `${proposedCells} celda(s) de sesión con n>=${MIN_N} y |exp|>=${DEADBAND}`
            : trades.length >= 10
                ? `ninguna celda cruza n>=${MIN_N} y |exp|>=${DEADBAND} (muestra=${trades.length})`
                : `muestra insuficiente en ${WINDOW_DAYS}d (${trades.length} trades WIN/LOSS)`,
        cells,
        factors,
    };
    mkdirSync("/opt/JARVIS/scripts/periodic_opt/reports", { recursive: true });
    mkdirSync("/opt/JARVIS/scripts/periodic_opt/opt_out", { recursive: true });
    writeFileSync("/opt/JARVIS/scripts/periodic_opt/reports/sizing_proposal.json", JSON.stringify(out, null, 2));
    writeFileSync("/opt/JARVIS/scripts/periodic_opt/opt_out/sizing_mc_base.json",
        JSON.stringify(baseSeq.map((r, i) => ({ rMultiple: r, timestamp: i }))));
    writeFileSync("/opt/JARVIS/scripts/periodic_opt/opt_out/sizing_mc_weighted.json",
        JSON.stringify(wSeq.map((r, i) => ({ rMultiple: r, timestamp: i }))));
    console.log(JSON.stringify(out));
    process.exit(0);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
