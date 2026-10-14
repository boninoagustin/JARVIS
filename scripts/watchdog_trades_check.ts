// Helper del watchdog externo: cuenta docs en active_trades de Firestore.
// Imprime un único número (0 = sin trades activos). Si falla, no imprime nada.
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";

async function main() {
  const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
  if (admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(key) });
  }
  const db = admin.firestore();
  const snap = await db.collection("active_trades").get();
  console.log(snap.size);
}

main().then(() => process.exit(0)).catch(() => process.exit(1));
