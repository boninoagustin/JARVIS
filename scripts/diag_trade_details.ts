// Dump de campos clave de los últimos trades live del journal.
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";

const KEEP = ["ticker", "direction", "result", "rMultiple", "timestamp", "closedAt", "triggerType",
  "grade", "bias4H", "bias1H", "macroContext", "points", "score", "tp1Hit", "slHit", "durationMin",
  "entryPrice", "slPrice", "tp1Price", "tp2Price", "adopted", "session"];

async function main() {
  const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
  const db = admin.firestore();
  const snap = await db.collection("trade_journal").orderBy("timestamp", "desc").limit(5).get();
  for (const doc of snap.docs) {
    const d = doc.data() as any;
    if (d.mode === "backtesting") continue;
    const ts = d.timestamp ? new Date(d.timestamp).toISOString().replace("T", " ").slice(0, 16) : "?";
    console.log(`--- ${d.ticker ?? "?"} ${d.direction ?? "?"} @ ${ts}Z | result=${d.result} rMultiple=${d.rMultiple} ---`);
    for (const k of KEEP) {
      if (k in d && k !== "ticker" && k !== "direction" && k !== "result" && k !== "rMultiple" && k !== "timestamp") {
        const v = d[k];
        if (typeof v === "object") console.log(`   ${k}: ${JSON.stringify(v)}`);
        else console.log(`   ${k}: ${v}`);
      }
    }
    console.log("");
  }
  process.exit(0);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
