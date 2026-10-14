// Limpia los opt_reports actuales: quita gatillos 15m del session_apply
// (reports generados antes del fix solo-5M). El panel no los mostrará ni aplicará.
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
    const sa = d.session_apply ?? {};
    if (typeof sa !== "object") continue;
    const cleaned: any = {};
    let removed = 0;
    for (const [session, triggers] of Object.entries(sa)) {
      if (!triggers || typeof triggers !== "object") continue;
      const sOut: any = {};
      for (const [trig, cfg] of Object.entries(triggers as any)) {
        if (trig.includes("15m")) { removed++; continue; }
        sOut[trig] = cfg;
      }
      if (Object.keys(sOut).length > 0) cleaned[session] = sOut;
    }
    if (removed > 0) {
      await db.collection("opt_reports").doc(doc.id).update({ session_apply: cleaned });
      console.log(`${doc.id}: ${removed} gatillos 15m quitados del session_apply`);
    } else {
      console.log(`${doc.id}: sin 15m — sin cambios`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
