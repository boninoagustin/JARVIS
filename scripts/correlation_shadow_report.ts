// scripts/correlation_shadow_report.ts — reporte del modo shadow del filtro de correlación
// Lee logs/correlation_audit.jsonl y resume: decisiones auditadas, bloqueos "would-have-been"
// por regla/par, risk-parity aplicado y días cubiertos.
// Uso: npx tsx scripts/correlation_shadow_report.ts [--dias N] [--json]
import fs from 'fs';

const AUDIT = 'logs/correlation_audit.jsonl';
const argDias = process.argv.indexOf('--dias');
const DIAS = argDias >= 0 ? parseInt(process.argv[argDias + 1], 10) || 30 : 30;
const asJson = process.argv.includes('--json');

if (!fs.existsSync(AUDIT)) {
    console.log('⚠️ No existe logs/correlation_audit.jsonl — el filtro aún no auditó ninguna decisión.');
    process.exit(0);
}

const lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean);
const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const cutoff = Date.now() - DIAS * 24 * 3600 * 1000;
const recent = entries.filter(e => (e.ts ?? 0) >= cutoff);

const byRule: Record<string, number> = {};
const byPair: Record<string, number> = {};
const byDay: Record<string, number> = {};
let riskParityHits = 0;
let degraded = 0;
let shadowOn = true;

for (const e of recent) {
    if (e.shadow !== undefined) shadowOn = e.shadow;
    if (e.degraded) degraded++;
    if (e.riskMult < 1) riskParityHits++;
    if (e.wouldBlock) {
        const day = new Date(e.ts).toISOString().slice(0, 10);
        byDay[day] = (byDay[day] ?? 0) + 1;
        for (const b of e.blockedBy ?? []) {
            byRule[b.rule] = (byRule[b.rule] ?? 0) + 1;
            const p = [e.ticker, b.otherTicker].sort().join('|');
            byPair[p] = (byPair[p] ?? 0) + 1;
        }
    }
}

const blocks = recent.filter(e => e.wouldBlock).length;
const daysCovered = new Set(recent.map(e => new Date(e.ts).toISOString().slice(0, 10))).size;

const out: Record<string, unknown> = {
    modo: shadowOn ? 'SHADOW (no bloquea)' : 'VIVO (bloquea)',
    diasVentana: DIAS,
    decisionesAuditadas: recent.length,
    diasConActividad: daysCovered,
    bloqueosHabriaHecho: blocks,
    porRegla: byRule,
    porPar: byPair,
    porDia: byDay,
    riskParityAplicados: riskParityHits,
    paresDegradados: degraded,
};

if (asJson) {
    console.log(JSON.stringify(out, null, 2));
} else {
    console.log('🧲 REPORTE FILTRO DE CORRELACIÓN — modo ' + out.modo);
    console.log(`Ventana: últimos ${DIAS} días`);
    console.log(`Decisiones auditadas: ${recent.length} (${daysCovered} días con actividad)`);
    console.log(`⛔ Bloqueos que habría hecho: ${blocks}`);
    if (Object.keys(byRule).length) {
        console.log('  por regla:');
        for (const [r, n] of Object.entries(byRule)) console.log(`    ${r}: ${n}`);
    }
    if (Object.keys(byPair).length) {
        console.log('  por par:');
        for (const [p, n] of Object.entries(byPair).sort((a, b) => b[1] - a[1])) console.log(`    ${p}: ${n}`);
    }
    if (Object.keys(byDay).length) {
        console.log('  por día:');
        for (const [d, n] of Object.entries(byDay).sort()) console.log(`    ${d}: ${n}`);
    }
    console.log(`Risk-parity auditados: ${riskParityHits}`);
    console.log(`Decisiones con algún par degradado (fail-open): ${degraded}`);
    if (blocks > 0) {
        console.log('\nEjemplos de bloqueos que habría hecho:');
        for (const e of recent.filter(x => x.wouldBlock).slice(-5)) {
            const det = (e.blockedBy ?? []).map((b: any) => `${b.otherTicker}(${b.otherDir}) ρ=${b.rho?.toFixed(2)}`).join('; ');
            console.log(`  ${new Date(e.ts).toISOString().slice(0, 16)} ${e.ticker} ${e.direction}: ${det}`);
        }
    }
}
process.exit(0);
