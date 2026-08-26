// Reporte de paridad VIVO vs BACKTEST (Plan B — ago-2026)
// Lee trigger_telemetry (últimos N días de realidad viva) y produce el embudo por
// ticker×sesión×gatillo con bandera de "GATILLO MUERTO EN VIVO".
// Uso: npx tsx scripts/trigger_parity_report.ts [--days=7]
// Salida: consola + scripts/periodic_opt/reports/parity_live_vs_backtest.json
import 'dotenv/config';
import { db } from '../src/db/memory.js';
import fs from 'node:fs';
import path from 'node:path';

const argDays = process.argv.find(a => a.startsWith('--days='));
const days = Number(argDays?.split('=')[1] ?? 7);

const now = new Date();
const sinceDay = new Date(now.getTime() - days * 86400e3).toISOString().slice(0, 10);

const snap = await db.collection('trigger_telemetry').get();
const daysFound = snap.docs.map(d => d.id).filter(id => id >= sinceDay).sort();

// Agregado por clave TICKER|SESSION|TRIGGER
interface Agg { signals: number; directEntries: number; oteWaits: number; oteExecutions: number; oteDead: Record<string, number>; }
const agg = new Map<string, Agg>();
for (const doc of snap.docs) {
    if (doc.id < sinceDay) continue;
    const data = doc.data() || {};
    for (const [k, v] of Object.entries(data)) {
        const b = v as any;
        if (!b || typeof b !== 'object') continue;
        let a = agg.get(k);
        if (!a) { a = { signals: 0, directEntries: 0, oteWaits: 0, oteExecutions: 0, oteDead: {} }; agg.set(k, a); }
        a.signals += b.signals || 0;
        a.directEntries += b.directEntries || 0;
        a.oteWaits += b.oteWaits || 0;
        a.oteExecutions += b.oteExecutions || 0;
        for (const [r, c] of Object.entries(b.oteDead || {})) a.oteDead[r] = (a.oteDead[r] || 0) + Number(c);
    }
}

type Row = { ticker: string; session: string; trigger: string; signals: number; directEntries: number; oteWaits: number; oteExecutions: number; oteDead: Record<string, number>; deadInLive: boolean };
const rows: Row[] = [];
for (const [k, a] of agg.entries()) {
    const [ticker, session, trigger] = k.split('|');
    const totalDead = Object.values(a.oteDead).reduce((s, c) => s + c, 0);
    // Gatillo muerto en vivo: tuvo señales (directas u OTE esperas) pero 0 ejecuciones totales
    const deadInLive = a.signals > 0 && (a.directEntries + a.oteExecutions) === 0;
    rows.push({ ticker, session, trigger, ...a, deadInLive });
}
rows.sort((x, y) => (x.ticker + x.session + x.trigger).localeCompare(y.ticker + y.session + y.trigger));

// ── Salida consola ──
const OTEDEAD_NAMES: Record<string, string> = {
    chochContrario: 'CHoCH contrario',
    inalcanzable: 'Inalcanzable (>1ATR/30min)',
    rr075: 'R:R < 0.75',
    minScore: 'Puntaje < minScore',
    opuesta: 'Presión contraria',
    otra: 'Otra/expiración',
};
console.log(`\n═══ PARIDAD VIVO vs BACKTEST — últimos ${daysFound.length} día(s) de telemetría (${daysFound[0] ?? '-'} → ${daysFound[daysFound.length - 1] ?? '-'}) ═══`);
const dead = rows.filter(r => r.deadInLive);
const otely = rows.filter(r => r.trigger.startsWith('ote'));
console.log(`Total claves activas: ${rows.length} | Gatillos señalados MUERTOS EN VIVO: ${dead.length}`);
console.log('');
for (const r of rows) {
    const flag = r.deadInLive ? '💀 MUERTO EN VIVO' : '';
    console.log(`${r.ticker} | ${r.session.padEnd(7)} | ${r.trigger.padEnd(12)} | señales=${String(r.signals).padStart(4)} directas=${String(r.directEntries).padStart(3)} oteEsperas=${String(r.oteWaits).padStart(4)} oteEjec=${String(r.oteExecutions).padStart(3)} ${flag}`);
    const deadParts = Object.entries(r.oteDead).filter(([, c]) => c > 0);
    if (deadParts.length) {
        console.log(`        muertes OTE: ${deadParts.map(([r2, c]) => `${OTEDEAD_NAMES[r2] ?? r2}=${c}`).join(' · ')}`);
    }
}
if (otely.length) {
    console.log('');
    const tWaits = otely.reduce((s, r) => s + r.oteWaits, 0);
    const tExec = otely.reduce((s, r) => s + r.oteExecutions, 0);
    const tDead = otely.reduce((s, r) => s + Object.values(r.oteDead).reduce((a, b) => a + b, 0), 0);
    console.log(`🔬 EMBUDO OTE (todos los activos): esperas=${tWaits} ejecutados=${tExec} (${tWaits ? ((tExec / tWaits) * 100).toFixed(2) : '0'}%) muertes=${tDead}`);
    const byReason: Record<string, number> = {};
    for (const r of otely) for (const [r2, c] of Object.entries(r.oteDead)) byReason[r2] = (byReason[r2] || 0) + c;
    const total = Object.values(byReason).reduce((a, b) => a + b, 0) || 1;
    for (const [r2, c] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
        console.log(`   ${OTEDEAD_NAMES[r2] ?? r2}: ${c} (${((c / total) * 100).toFixed(1)}%)`);
    }
}

// ── Salida JSON para el pipeline dominical ──
const outPath = path.resolve('scripts/periodic_opt/reports/parity_live_vs_backtest.json');
const out = {
    generatedAt: now.toISOString(),
    windowDays: days,
    daysWithData: daysFound,
    totals: {
        keys: rows.length,
        deadInLive: dead.length,
        oteWaits: otely.reduce((s, r) => s + r.oteWaits, 0),
        oteExecutions: otely.reduce((s, r) => s + r.oteExecutions, 0),
    },
    rows,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\n💾 Reporte escrito en ${outPath}`);
process.exit(0);
