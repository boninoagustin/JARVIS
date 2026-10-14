// Embudo OTE diario — últimos N días de telemetría en vivo (sep-2026, pedido Bon punto 2)
// Esperas OTE, ejecuciones y muertes por causa, día a día.
// Uso: npx tsx scripts/ote_funnel_daily.ts [--days=7]
import 'dotenv/config';
import { db } from '../src/db/memory.js';

const argDays = process.argv.find(a => a.startsWith('--days='));
const days = Number(argDays?.split('=')[1] ?? 7);
const now = new Date();
const sinceDay = new Date(now.getTime() - days * 86400e3).toISOString().slice(0, 10);

const snap = await db.collection('trigger_telemetry').get();
const daysFound = snap.docs.map(d => d.id).filter(id => id >= sinceDay).sort();

const NAMES: Record<string, string> = {
    chochContrario: 'CHoCH contrario',
    inalcanzable: 'Inalcanzable (>1ATR/30min)',
    rr075: 'R:R < 0.75',
    minScore: 'Puntaje < minScore',
    opuesta: 'Presión contraria',
    otra: 'Otra/expiración',
    otraMl: 'Expiró c/ rechazo ML',
    reemplazado: 'Pisado por impulso nuevo',
};

interface DayAgg { waits: number; execs: number; direct: number; mlRejects: number; dead: Record<string, number>; }
const byDay = new Map<string, DayAgg>();
for (const doc of snap.docs) {
    if (doc.id < sinceDay) continue;
    let a = byDay.get(doc.id);
    if (!a) { a = { waits: 0, execs: 0, direct: 0, mlRejects: 0, dead: {} }; byDay.set(doc.id, a); }
    const data = doc.data() || {};
    for (const [k, v] of Object.entries(data)) {
        const b = v as any;
        if (!b || typeof b !== 'object') continue;
        const trigger = String(k).split('|')[2] ?? '';
        if (!trigger.startsWith('ote')) continue; // embudo OTE: solo claves ote*
        a.waits += b.oteWaits || 0;
        a.execs += b.oteExecutions || 0;
        a.mlRejects += b.oteMlRejects || 0;
        for (const [r, c] of Object.entries(b.oteDead || {})) a.dead[r] = (a.dead[r] || 0) + Number(c);
    }
}

console.log(`\n═══ EMBUDO OTE DIARIO — últimos ${daysFound.length} día(s) con datos (${daysFound[0]} → ${daysFound[daysFound.length - 1]}) ═══`);
console.log('día        esperas  ejec   %ejec   muertes | detalle');
const t = { waits: 0, execs: 0, mlRejects: 0, dead: {} as Record<string, number> };
for (const day of daysFound) {
    const a = byDay.get(day)!;
    const deadTotal = Object.values(a.dead).reduce((s, c) => s + c, 0);
    const pct = a.waits ? ((a.execs / a.waits) * 100).toFixed(1) : '  - ';
    const detail = Object.entries(a.dead).filter(([, c]) => c > 0)
        .map(([r, c]) => `${NAMES[r] ?? r}=${c}`).join(' · ') || '—';
    const ml = a.mlRejects > 0 ? ` · MLrechazos=${a.mlRejects}` : '';
    console.log(`${day}  ${String(a.waits).padStart(4)}  ${String(a.execs).padStart(4)}  ${String(pct).padStart(5)}%  ${String(deadTotal).padStart(4)} | ${detail}${ml}`);
    t.waits += a.waits; t.execs += a.execs; t.mlRejects += a.mlRejects;
    for (const [r, c] of Object.entries(a.dead)) t.dead[r] = (t.dead[r] || 0) + c;
}
console.log('───────────────────────────────────────────────────────────────');
const td = Object.values(t.dead).reduce((s, c) => s + c, 0);
console.log(`TOTAL     ${String(t.waits).padStart(4)}  ${String(t.execs).padStart(4)}  ${t.waits ? ((t.execs / t.waits) * 100).toFixed(1) : '-'}%  ${String(td).padStart(4)}`);
console.log('');
console.log('Muertes por causa (ventana completa):');
for (const [r, c] of Object.entries(t.dead).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(NAMES[r] ?? r).padEnd(30)} ${c}  (${((c / (td || 1)) * 100).toFixed(1)}%)`);
}
// 🆕 sep-2026: waits se crean HOY pero las muertes pueden ser de legs de días previos
// (8h de vida + reemplazos) → la resta simple puede dar negativo y confunde.
const aliveNote = td > t.waits
    ? 'muertes > esperas: legs de días previos muriendo hoy (reemplazos/expiración 8h) — normal'
    : `${t.waits - td} legs aún vivos al cierre del día o muerte fuera de ventana`;
console.log(`\nEsperas sin muerte registrada en ventana: ${aliveNote}`);
process.exit(0);
