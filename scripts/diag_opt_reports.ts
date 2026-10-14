// Diagnóstico: opt_reports — appliedAt, appliedBy, y si el report incluye 15m en session_apply/best_config
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";

async function main() {
  const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
  const db = admin.firestore();
  const snap = await db.collection("opt_reports").get();
  for (const doc of snap.docs) {
    const d = doc.data() as any;
    const appliedAt = d.appliedAt ? new Date(d.appliedAt).toISOString() : "NO APLICADO";
    const sa = d.session_apply ?? {};
    const m15 = Object.entries(sa).flatMap(([s, trs]: any) =>
      Object.keys(trs).filter((t) => t.includes("15m")).map((t) => `${s}/${t}`)
    );
    console.log(`${doc.id}: status=${d.status ?? "?"} appliedAt=${appliedAt} by=${d.appliedBy ?? "-"} 15mEnPropuesta=${m15.length ? m15.join(",") : "no"}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
