// Diagnóstico: estado de gatillos 15m en asset_configs/AUDCAD
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";

async function main() {
  const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
  const db = admin.firestore();
  const doc = await db.collection("asset_configs").doc("AUDCAD").get();
  if (!doc.exists) { console.log("NO EXISTE asset_configs/AUDCAD"); process.exit(0); }
  const d = doc.data() as any;
  console.log("top-level keys:", Object.keys(d).join(", "));
  console.log("updatedAt/updated:", d.updatedAt ?? d.updated ?? "n/a");
  console.log(JSON.stringify(d, null, 1));
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
