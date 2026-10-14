// Análisis del trade EURUSD abierto 12:11 (sep-2026): pips de TP/SL, ATR/ADR actual,
// y probabilidad empírica de que el precio mueva X pips a favor en el horizonte del trade.
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";
import fs from 'node:fs';
import path from 'node:path';

async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();

    // 1) Trade EURUSD abierto hoy
    console.log("══ Trade EURUSD en curso ══");
    const actSnap = await db.collection("active_trades").where("ticker", "==", "EURUSD").limit(5).get();
    const jourSnap = await db.collection("trade_journal").where("ticker", "==", "EURUSD").limit(20).get();
    const seen: string[] = [];
    const dump = (t: any, src: string) => {
        const id = t.tradeId || t.id;
        if (seen.includes(id)) return; seen.push(id);
        console.log(`  [${src}] ${id} dir=${t.direction} entry=${t.entryPrice} sl=${t.slPrice} tp1=${t.tp1Price} tp2=${t.tp2Price} ts=${new Date(t.openTimestamp || t.timestamp || 0).toISOString().slice(5, 16).replace('T', ' ')}`);
        const pip = 0.0001;
        if (t.entryPrice && t.slPrice) console.log(`     SL: ${(Math.abs(t.entryPrice - t.slPrice) / pip).toFixed(1)} pips`);
        if (t.entryPrice && t.tp1Price) console.log(`     TP1: ${(Math.abs(t.entryPrice - t.tp1Price) / pip).toFixed(1)} pips`);
        if (t.entryPrice && t.tp2Price) console.log(`     TP2: ${(Math.abs(t.entryPrice - t.tp2Price) / pip).toFixed(1)} pips`);
    };
    actSnap.forEach(d => dump(d.data(), "active"));
    jourSnap.forEach(d => dump(d.data(), "journal"));

    // 2) ATR/ADR de EURUSD del histórico M5
    const csv = "/opt/JARVIS/logs/eurusd/history_exported/pine-logs-SMC Master_M5.csv";
    if (!fs.existsSync(csv)) { console.log("sin csv"); process.exit(0); }
    const lines = fs.readFileSync(csv, 'utf8').split('\n').filter(l => l.trim());
    // Parsear velas: filas PING_PRICE con price/high/low + timestamp. Formato: detectar columnas.
    const sample = lines[0];
    console.log(`\n══ EURUSD histórico (${lines.length} filas M5) ══`);
    const candles: { ts: number; h: number; l: number }[] = [];
    for (const ln of lines) {
        if (!ln.includes('PING_PRICE')) continue;
        const m = ln.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}).*?PING_PRICE.*?High:\s*([0-9.]+).*?Low:\s*([0-9.]+)/i);
        if (!m) continue;
        const ts = new Date(m[1] + 'Z').getTime();
        const h = parseFloat(m[2]), l = parseFloat(m[3]);
        if (isFinite(ts) && h > l) candles.push({ ts, h, l });
    }
    if (candles.length < 100) {
        // fallback: columnas distintas — intentar parseo genérico
        console.log(`  parseo PING_PRICE falló (${candles.length} velas) — veo el formato:`);
        console.log("  " + sample.slice(0, 200));
        process.exit(0);
    }
    candles.sort((a, b) => a.ts - b.ts);
    const closes: number[] = [];
    // reconstruir cierre aproximado: usar low/high del siguiente candle no es exacto; usar mid
    const mids = candles.map(c => (c.h + c.l) / 2);
    // TR para ATR14 con mid previo
    let atr = 0;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const tr = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - mids[i - 1]), Math.abs(candles[i].l - mids[i - 1]));
        trs.push(tr);
    }
    const atr14 = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
    // ADR: rango por día UTC (últimos 20 días)
    const byDay = new Map<string, { h: number; l: number }>();
    for (const c of candles) {
        const day = new Date(c.ts).toISOString().slice(0, 10);
        const d = byDay.get(day) || { h: -1e9, l: 1e9 };
        d.h = Math.max(d.h, c.h); d.l = Math.min(d.l, c.l);
        byDay.set(day, d);
    }
    const ranges = [...byDay.values()].slice(-20).map(d => d.h - d.l);
    const adr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const pip = 0.0001;
    console.log(`  ATR14 (M5, últimas 14 velas): ${(atr / pip).toFixed(1)} pips`);
    console.log(`  ADR (rango diario, 20 días): ${(adr / pip).toFixed(1)} pips | min ${(Math.min(...ranges) / pip).toFixed(0)} máx ${(Math.max(...ranges) / pip).toFixed(0)}`);
    console.log(`  TP de 34.9 pips = ${(34.9 / (adr / pip)).toFixed(2)}×ADR | = ${(34.9 / (atr / pip)).toFixed(1)}×ATR14(M5)`);

    // 3) Probabilidad empírica: partiendo de cada vela M5, en cuántos casos el precio se mueve
    //    >= 35 pips A FAVOR (en cualquier dirección) dentro de las siguientes 3h (36 velas)
    const TARGET = 0.0035;
    const HORIZON = 36; // velas M5 = 3h (duración típica de los trades EURUSD)
    let ok = 0, total = 0;
    for (let i = 0; i + HORIZON < candles.length; i += 3) {
        const start = candles[i];
        let mx = start.h, mn = start.l;
        for (let j = 1; j <= HORIZON; j++) {
            mx = Math.max(mx, candles[i + j].h);
            mn = Math.min(mn, candles[i + j].l);
        }
        total++;
        if (mx - start.l >= TARGET || start.h - mn >= TARGET) ok++;
    }
    console.log(`\n  P(±35 pips en 3h desde una vela M5 cualquiera): ${(ok / total * 100).toFixed(0)}% (${ok}/${total} muestras)`);
    process.exit(0);
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });
