// Historial completo del journal live, agrupado por mes.
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";

async function main() {
  const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
  const db = admin.firestore();
  const snap = await db.collection("trade_journal").get();
  const byMonth: Record<string, { n: number; w: number; l: number; r: number }> = {};
  let total = 0, totalR = 0;
  for (const doc of snap.docs) {
    const d = doc.data() as any;
    if (d.mode === "backtesting" || !d.result) continue;
    const ts = d.timestamp ?? 0;
    if (!ts) continue;
    const m = new Date(ts).toISOString().slice(0, 7);
    const r = typeof d.rMultiple === "number" && isFinite(d.rMultiple) ? d.rMultiple : (d.result === "WIN" ? 1 : -1);
    byMonth[m] = byMonth[m] || { n: 0, w: 0, l: 0, r: 0 };
    byMonth[m].n++; byMonth[m].r += r; d.result === "WIN" ? byMonth[m].w++ : byMonth[m].l++;
    total++; totalR += r;
  }
  console.log("=== JOURNAL LIVE POR MES (completo) ===");
  for (const [m, v] of Object.entries(byMonth).sort()) {
    console.log(`  ${m}: n=${String(v.n).padEnd(3)} W=${v.w} L=${v.l} WR=${(v.w / v.n * 100).toFixed(0).padStart(3)}% R=${v.r >= 0 ? "+" : ""}${v.r.toFixed(1)}`);
  }
  console.log(`\nTOTAL: ${total} trades, ${totalR.toFixed(1)}R`);
  process.exit(0);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
