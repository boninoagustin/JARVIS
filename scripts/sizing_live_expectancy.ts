// Sizing (sep-2026): expectancy LIVE por celda — export pre-reset (94) + trade_journal post-reset.
// Celdas: sesión (hora ARG, misma derivación que extractFeatures), activo, sesión×activo, gatillo.
// Propone factores de sizing fraccional con mínimo de muestra. NO aplica nada.
// Uso: npx tsx scripts/sizing_live_expectancy.ts
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

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

    // 1. Post-reset (Firestore)
    const snap = await db.collection("trade_journal").get();
    const post = snap.docs.map((d: any) => d.data()).filter((t: any) =>
        t.mode !== "backtesting" && (t.result === "WIN" || t.result === "LOSS" || t.result === "BREAKEVEN")
        && (t.closedAt || t.timestamp)
    );

    // 2. Pre-reset (export) — descarta BREAKEVEN/SKIP/REVERSAL sin rMultiple útil
    const pre: any[] = JSON.parse(readFileSync("/opt/JARVIS/logs/trade_journal_export.json", "utf8"))
        .filter((t: any) => t.result === "WIN" || t.result === "LOSS");

    interface Row { n: number; w: number; r: number; }
    const agg = new Map<string, Row>();
    const add = (key: string, t: any) => {
        const r = typeof t.rMultiple === "number" && isFinite(t.rMultiple) ? t.rMultiple
            : (t.result === "WIN" ? 1 : t.result === "LOSS" ? -1 : 0);
        let a = agg.get(key);
        if (!a) { a = { n: 0, w: 0, r: 0 }; agg.set(key, a); }
        a.n++; a.r += r; if (r > 0) a.w++;
    };

    for (const t of [...pre, ...post]) {
        const ts = Number(t.timestamp ?? t.closedAt ?? 0);
        if (!ts) continue;
        // Solo WIN/LOSS para la calibración (BE r=0 no aporta señal de edge)
        if (typeof t.rMultiple === "number" && isFinite(t.rMultiple) && t.rMultiple === 0) continue;
        const sess = t.session || sessionFromTs(ts);
        const tick = (t.ticker || '?').toUpperCase();
        const fam = t.triggerFam || (t.triggerKey ? String(t.triggerKey).replace(/5m|15m/g, '') : '?');
        add(`S|${sess}`, t);
        add(`T|${tick}`, t);
        add(`ST|${sess}|${tick}`, t);
        add(`G|${fam}`, t);
    }

    const show = (label: string, prefix: string, minN: number) => {
        console.log(`\n=== ${label} (mín n=${minN}) ===`);
        const rows = [...agg.entries()].filter(([k]) => k.startsWith(prefix))
            .filter(([, v]) => v.n >= minN)
            .sort((a, b) => (b[1].r / b[1].n) - (a[1].r / a[1].n));
        for (const [k, v] of rows) {
            const exp = v.r / v.n;
            const factor = Math.min(1.6, Math.max(0.4, 1 + 0.5 * exp));
            console.log(`  ${k.slice(prefix.length).padEnd(24)} n=${String(v.n).padEnd(3)} WR=${(v.w / v.n * 100).toFixed(0).padStart(3)}% R=${v.r >= 0 ? '+' : ''}${v.r.toFixed(1).padStart(5)} exp=${exp >= 0 ? '+' : ''}${exp.toFixed(2).padStart(5)}R/t → factor ${factor.toFixed(2)}`);
        }
    };

    const total = [...agg.values()].reduce((s, v) => ({ n: s.n + v.n, r: s.r + v.r, w: s.w + v.w }), { n: 0, r: 0, w: 0 });
    console.log(`\nTOTAL muestra WIN/LOSS: ${total.n} trades | WR ${(total.w / total.n * 100).toFixed(0)}% | ${total.r >= 0 ? '+' : ''}${total.r.toFixed(1)}R | exp ${(total.r / total.n).toFixed(2)}R/t`);

    show('SESION', 'S|', 8);
    show('TICKER', 'T|', 8);
    show('SESION×TICKER', 'ST|', 8);
    show('GATILLO', 'G|', 8);

    // Salida JSON para el A/B
    const out: any = { generatedAt: new Date().toISOString(), cells: {} };
    for (const [k, v] of agg.entries()) {
        const [kind, ...rest] = k.split('|');
        if (kind !== 'S') continue;
        if (v.n >= 8) out.cells[rest.join('|')] = { n: v.n, exp: +(v.r / v.n).toFixed(3), factor: +Math.min(1.6, Math.max(0.4, 1 + 0.5 * v.r / v.n)).toFixed(2) };
    }
    mkdirSync("/opt/JARVIS/scripts/periodic_opt/reports", { recursive: true });
    writeFileSync("/opt/JARVIS/scripts/periodic_opt/reports/sizing_live.json", JSON.stringify(out, null, 2));
    console.log("\n💾 sizing_live.json escrito (factores por sesión con n>=8)");
    process.exit(0);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
