// Diagnóstico: gatillos 15m enabled en TODOS los asset_configs
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";

async function main() {
  const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
  const db = admin.firestore();
  const snap = await db.collection("asset_configs").get();
  for (const doc of snap.docs) {
    const d = doc.data() as any;
    const sessions = d.sessions ?? {};
    const viol: string[] = [];
    for (const [sk, sv] of Object.entries(sessions)) {
      if (!sv || typeof sv !== "object") continue;
      for (const [gk, gv] of Object.entries(sv as any)) {
        if (gk.toLowerCase().includes("15m") && gv && (gv as any).enabled === true) {
          viol.push(`${sk}/${gk}`);
        }
      }
    }
    console.log(`${doc.id}: ${viol.length === 0 ? "OK solo-5M" : "❌ " + viol.join(", ")} | upd=${d.updatedAt ?? "n/a"} by=${d.updatedBy ?? "n/a"}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
