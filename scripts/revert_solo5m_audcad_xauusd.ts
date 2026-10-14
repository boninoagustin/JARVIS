// Revert solo-5M: deshabilita gatillos 15m en AUDCAD y XAUUSD (con backup previo).
// El bot los toma por onSnapshot (sin restart).
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const TICKERS = ["AUDCAD", "XAUUSD"];

function serialize(doc: any): any {
  // Timestamp de Firestore → {__ts: iso} para respaldo legible
  return JSON.parse(
    JSON.stringify(doc, (k, v) => {
      if (v && typeof v === "object" && typeof v.toMillis === "function") {
        return { __ts: new Date(v.toMillis()).toISOString() };
      }
      return v;
    })
  );
}

async function main() {
  const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
  const db = admin.firestore();
  mkdirSync("/opt/JARVIS/backups", { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  for (const ticker of TICKERS) {
    const ref = db.collection("asset_configs").doc(ticker);
    const snap = await ref.get();
    if (!snap.exists) { console.log(`${ticker}: NO EXISTE — skip`); continue; }
    const d = snap.data() as any;

    // 1) Backup
    const backupPath = `/opt/JARVIS/backups/asset_configs_${ticker}_pre_revert_solo5m_${ts}.json`;
    writeFileSync(backupPath, JSON.stringify(serialize(d), null, 2));
    console.log(`${ticker}: backup → ${backupPath}`);

    // 2) Merge profundo: deshabilitar 15m en todas las sesiones
    const sessions = JSON.parse(JSON.stringify(d.sessions ?? {}));
    let changed = 0;
    for (const [sk, sv] of Object.entries(sessions)) {
      if (!sv || typeof sv !== "object") continue;
      for (const [gk, gv] of Object.entries(sv as any)) {
        if (gk.toLowerCase().includes("15m") && gv && (gv as any).enabled === true) {
          (sv as any)[gk] = { ...(gv as any), enabled: false };
          changed++;
        }
      }
    }
    if (changed === 0) { console.log(`${ticker}: ya sin 15m habilitados — no se escribe`); continue; }

    await ref.set(
      { sessions, updatedAt: new Date().toISOString(), updatedBy: "manual_revert_solo5m" },
      { merge: true }
    );
    console.log(`${ticker}: ${changed} gatillos 15m → disabled. Escrito OK.`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
