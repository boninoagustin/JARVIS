// update_adr_table.ts — Regeneración SEMANAL de la tabla ADR del cap de TP2.
// Corre el sábado (ExecStartPre del dominical, mercado cerrado) ANTES del optimizador:
//   1) mide el ADR de todos los activos con histórico M5 (últimos 20 días),
//   2) compara los VALORES contra la tabla vigente (semántica, no formato),
//   3) si cambió: reescribe el bloque ADR_TABLE en src/engine/tp2Cap.ts + smoke-test
//      (importa capTp2Price y valida recortes conocidos) + reinicia JARVIS,
//   4) si no cambió: no toca nada (sin reinicios inútiles),
//   5) loguea todo en logs/adr_update_<fecha>.log.
// Si cualquier paso falla: restaura el archivo original y sale 1 (el dominical sigue
// con la tabla vigente porque el ExecStartPre lleva prefijo "-").
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { measureAdrTable } from './calc_adr_table.js';

const TP2CAP_PATH = '/opt/JARVIS/src/engine/tp2Cap.ts';
const LOG_PATH = `/opt/JARVIS/logs/adr_update_${new Date().toISOString().slice(0, 10)}.log`;

function log(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(LOG_PATH, line + '\n');
}

function fmtTable(rows: { ticker: string; adr: number }[]): string {
    const entries: string[] = [];
    let line = '    ';
    for (const r of rows) {
        const chunk = `${r.ticker}: ${Number(r.adr.toFixed(6))},`;
        if ((line + chunk).length > 100) { entries.push(line.trimEnd()); line = '    '; }
        line += chunk + ' ';
    }
    if (line.trim().length > 4) entries.push(line.trimEnd());
    return `const ADR_TABLE: Record<string, number> = {\n${entries.join('\n')}\n};`;
}

/** Extrae el mapa ticker→adr del bloque vigente (entre marcadores). */
function parseCurrentTable(src: string): Map<string, number> {
    const startIdx = src.indexOf('ADR_TABLE_START');
    const endIdx = src.indexOf('// ── ADR_TABLE_END');
    if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return new Map();
    const block = src.slice(startIdx, endIdx);
    const out = new Map<string, number>();
    for (const m of block.matchAll(/([A-Z][A-Z0-9]+):\s*([0-9.]+)/g)) {
        out.set(m[1], parseFloat(m[2]));
    }
    return out;
}

try {
    // 1) Medir
    const measured = measureAdrTable();
    log(`Medición OK: ${measured.length} tickers.`);
    if (measured.length < 10) {
        log(`⚠️ Solo ${measured.length} tickers medidos (<10) — algo raro con los históricos. Abortar sin tocar nada.`);
        process.exit(1);
    }

    // 2) Comparar VALORES contra la tabla vigente (sin tocar formato si no cambió)
    const src = fs.readFileSync(TP2CAP_PATH, 'utf8');
    const current = parseCurrentTable(src);
    const EPS = 1e-6;
    let changed = current.size !== measured.length;
    const diffs: string[] = [];
    if (!changed) {
        for (const r of measured) {
            const cur = current.get(r.ticker);
            if (cur === undefined || Math.abs(cur - r.adr) > EPS) {
                changed = true;
                diffs.push(`${r.ticker}: ${cur ?? 'n/d'} → ${r.adr.toFixed(6)}`);
            }
        }
    }
    if (!changed) {
        log(`Tabla sin cambios de valores (${measured.length} tickers) — no se toca nada ni se reinicia.`);
        process.exit(0);
    }
    log(`Cambios detectados en ${diffs.length || measured.length} tickers. Aplicando...`);

    // 3) Reescribir el bloque (entre marcadores)
    const startIdx = src.indexOf('ADR_TABLE_START');
    const endIdx = src.indexOf('// ── ADR_TABLE_END');
    if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
        log('❌ Marcadores ADR_TABLE_START/END no encontrados en tp2Cap.ts. Abortar.');
        process.exit(1);
    }
    const newBlock = fmtTable(measured);
    const newSrc = src.slice(0, startIdx) + 'ADR_TABLE_START (regenerada semanalmente por scripts/update_adr_table.ts — no editar a mano) ──\n' + newBlock + '\n' + src.slice(endIdx);
    fs.writeFileSync(TP2CAP_PATH + '.bak', src);
    fs.writeFileSync(TP2CAP_PATH, newSrc);
    log(`tp2Cap.ts reescrito (backup en tp2Cap.ts.bak).`);

    // 4) Smoke test (archivo temporal — el -e de tsx es inestable con imports)
    const smokePath = '/opt/JARVIS/scripts/.adr_smoke_test.ts';
    fs.writeFileSync(smokePath, [
        "import { capTp2Price } from '../src/engine/tp2Cap.js';",
        "const a = capTp2Price('USOIL','BUY',93.3,91.68901,98.225485);",
        "const b = capTp2Price('EURUSD','BUY',1.14,1.13,1.145);",
        "if (!(a < 98.225485)) throw new Error('cap USOIL no mordio');",
        "if (!(b <= 1.145)) throw new Error('cap EURUSD mal');",
        "console.log('smoke OK: USOIL', a.toFixed(4), 'EURUSD', b.toFixed(6));",
        "process.exit(0);",
    ].join('\n'));
    try {
        execSync(`cd /opt/JARVIS && timeout 90 npx tsx scripts/.adr_smoke_test.ts`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        log('Smoke test OK.');
    } catch (e: any) {
        const out = (e.stdout || '') + (e.stderr || '');
        log(`❌ Smoke test FALLÓ: ${out.slice(0, 300)}`);
        fs.writeFileSync(TP2CAP_PATH, src); // restaurar
        log('tp2Cap.ts restaurado al original. Salida 1.');
        process.exit(1);
    } finally {
        fs.unlinkSync(smokePath);
    }

    // 5) Reiniciar el bot para que cargue la tabla nueva (sábado, mercado cerrado)
    try {
        execSync('pm2 restart JARVIS --update-env', { encoding: 'utf8', timeout: 60_000 });
        log('JARVIS reiniciado con la tabla ADR nueva.');
    } catch (e: any) {
        log(`⚠️ No se pudo reiniciar JARVIS: ${e.message.slice(0, 200)}. La tabla aplicará en el próximo restart.`);
    }
    log('✅ Actualización semanal de ADR completada.');
    process.exit(0);
} catch (e: any) {
    log(`❌ Error fatal: ${e.message}`);
    process.exit(1);
}
