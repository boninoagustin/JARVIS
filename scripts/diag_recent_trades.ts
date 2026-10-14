// Últimos trades del journal: racha, rMultiple por trade, por activo y gatillo.
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";

async function main() {
  const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
  const db = admin.firestore();
  const snap = await db.collection("trade_journal").orderBy("timestamp", "desc").limit(40).get();
  const rows: any[] = [];
  for (const doc of snap.docs) {
    const d = doc.data() as any;
    if (d.mode === "backtesting") continue;
    rows.push(d);
  }
  rows.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  let cumR = 0;
  console.log("=== ÚLTIMOS TRADES LIVE (orden cronológico) ===");
  for (const d of rows) {
    const ts = d.timestamp ? new Date(d.timestamp).toISOString().replace("T", " ").slice(0, 16) : "?";
    const r = typeof d.rMultiple === "number" && isFinite(d.rMultiple) ? d.rMultiple : null;
    const rTxt = r === null ? (d.result ?? "?") : `${r > 0 ? "+" : ""}${r.toFixed(2)}R`;
    if (r !== null) cumR += r;
    console.log(`${ts}Z | ${(d.ticker ?? "?").padEnd(7)} | ${(d.direction ?? "?").padEnd(4)} | ${(d.triggerType ?? d.grade ?? "?").padEnd(16)} | ${rTxt.padEnd(8)} | ${d.result ?? "?"}${d.adopted ? " (adoptado)" : ""}`);
  }
  const wins = rows.filter((d) => d.result === "WIN").length;
  const losses = rows.filter((d) => d.result === "LOSS").length;
  console.log(`\nTotal: ${rows.length} | W=${wins} L=${losses} | R acumulado (últimos 40): ${cumR.toFixed(1)}R`);
  process.exit(0);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
