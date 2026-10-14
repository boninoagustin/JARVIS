// Resumen de performance live: últimas 8 semanas — WR, R por semana, por sesión y por bias.
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";

async function main() {
  const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
  const db = admin.firestore();
  const since = Date.now() - 56 * 24 * 3600 * 1000;
  const snap = await db.collection("trade_journal").where("timestamp", ">=", since).get();
  const trades = snap.docs.map((d) => d.data()).filter((d: any) => d.mode !== "backtesting" && d.result);
  trades.sort((a: any, b: any) => a.timestamp - b.timestamp);

  const wk = (ts: number) => {
    const d = new Date(ts);
    const day = (d.getUTCDay() + 6) % 7; // lunes=0
    const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
    return mon.toISOString().slice(0, 10);
  };

  const byWeek: Record<string, { n: number; w: number; l: number; r: number }> = {};
  const bySess: Record<string, { n: number; w: number; l: number; r: number }> = {};
  const byBias: Record<string, { n: number; w: number; l: number; r: number }> = {};
  let totR = 0;

  for (const t of trades) {
    const r = typeof t.rMultiple === "number" && isFinite(t.rMultiple) ? t.rMultiple : (t.result === "WIN" ? 1 : -1);
    totR += r;
    const w = t.result === "WIN";
    const wkk = wk(t.timestamp);
    byWeek[wkk] = byWeek[wkk] || { n: 0, w: 0, l: 0, r: 0 };
    byWeek[wkk].n++; byWeek[wkk].r += r; w ? byWeek[wkk].w++ : byWeek[wkk].l++;
    const sess = t.session || "?";
    bySess[sess] = bySess[sess] || { n: 0, w: 0, l: 0, r: 0 };
    bySess[sess].n++; bySess[sess].r += r; w ? bySess[sess].w++ : bySess[sess].l++;
    const biasKey = `${t.bias4H ?? "?"}/${t.bias1H ?? "?"}`;
    byBias[biasKey] = byBias[biasKey] || { n: 0, w: 0, l: 0, r: 0 };
    byBias[biasKey].n++; byBias[biasKey].r += r; w ? byBias[biasKey].w++ : byBias[biasKey].l++;
  }

  console.log(`\n=== POR SEMANA (${trades.length} trades, ${totR.toFixed(1)}R en 8 semanas) ===`);
  for (const [k, v] of Object.entries(byWeek).sort()) {
    console.log(`  ${k}: n=${v.n} W=${v.w} L=${v.l} WR=${(v.w / v.n * 100).toFixed(0)}% R=${v.r >= 0 ? "+" : ""}${v.r.toFixed(1)}`);
  }
  console.log(`\n=== POR SESION ===`);
  for (const [k, v] of Object.entries(bySess).sort((a: any, b: any) => b[1].r - a[1].r)) {
    console.log(`  ${k.padEnd(8)}: n=${String(v.n).padEnd(2)} W=${v.w} L=${v.l} WR=${(v.w / v.n * 100).toFixed(0)}% R=${v.r >= 0 ? "+" : ""}${v.r.toFixed(1)}`);
  }
  console.log(`\n=== POR BIAS 4H/1H ===`);
  for (const [k, v] of Object.entries(byBias).sort((a: any, b: any) => b[1].r - a[1].r)) {
    console.log(`  ${k.padEnd(18)}: n=${String(v.n).padEnd(2)} WR=${(v.w / v.n * 100).toFixed(0)}% R=${v.r >= 0 ? "+" : ""}${v.r.toFixed(1)}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
