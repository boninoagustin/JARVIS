// OTE vs DIRECTO — resultados reales cruzando journal ↔ telemetría (sep-2026, pedido Bon)
// Qué mide: de los trades cerrados del trade_journal, separa los que entraron por OTE
// (retroceso esperado) de los directos, y compara W/L/BE, R acumulado y USD por grupo.
// Además cruza con trigger_telemetry (embudo: esperas/ejecuciones OTE y directas) como sanity check.
// Uso: npx tsx scripts/ote_vs_directo.ts [--days=30]
import 'dotenv/config';
import { db } from '../src/db/memory.js';
import fs from 'node:fs';
import path from 'node:path';

const argDays = process.argv.find(a => a.startsWith('--days='));
const days = Number(argDays?.split('=')[1] ?? 30);
const sendTelegram = process.argv.includes('--telegram');
const now = new Date();
const cutoffTs = now.getTime() - days * 86400e3;
const sinceDay = new Date(cutoffTs).toISOString().slice(0, 10);

// ── Clasificación de entrada (misma lógica que deriveTriggerKey de journal.ts) ──
function deriveEntryType(record: any): { entryType: string; triggerKey: string; derived: boolean } {
    if (record.entryType === 'OTE' || record.entryType === 'DIRECTO') {
        return { entryType: record.entryType, triggerKey: record.triggerKey ?? '?', derived: false };
    }
    const ev: string[] = Array.isArray(record.events) ? record.events : [];
    const entry = ev.find((e: string) => e.includes('🚀') || e.includes('🔨'));
    const structural = entry ?? [...ev].reverse().find((e: string) => /^(CHoCH|BOS)_/.test(e));
    const fam = structural?.includes('BOS') ? 'BOS' : structural?.includes('CHoCH') ? 'CHoCH' : null;
    const tf = (structural?.match(/_(\d+M|1H|4H|D|W)$/)?.[1]?.toLowerCase() ?? '');
    const isOte = record.isChochEntry === false || ev.some((e: string) => /OTE|Retracement/i.test(e));
    const famLower = fam ? fam.toLowerCase() : 'unknown';
    const key = fam
        ? `${isOte ? 'ote' + (fam === 'BOS' ? 'Bos' : 'Choch') : famLower}${tf}`
        : (isOte ? 'ote_unknown' : 'unknown');
    return { entryType: isOte ? 'OTE' : 'DIRECTO', triggerKey: key, derived: true };
}

interface GroupAgg {
    n: number; wins: number; losses: number; be: number; other: number;
    sumR: number; nR: number; sumUsd: number; nUsd: number;
    bestR: number; worstR: number; byTicker: Map<string, { n: number; sumR: number; sumUsd: number }>;
}
const newAgg = (): GroupAgg => ({ n: 0, wins: 0, losses: 0, be: 0, other: 0, sumR: 0, nR: 0, sumUsd: 0, nUsd: 0, bestR: -Infinity, worstR: Infinity, byTicker: new Map() });

// ── Leer journal ──
const snap = await db.collection('trade_journal').get();
const closed: { type: string; ticker: string; result: string; r: number | null; usd: number | null }[] = [];
let totalDocs = 0, outOfWindow = 0, open = 0, skipped = 0, adopted = 0, backtest = 0, dupes = 0, noResult = 0, derivedN = 0;
let journalMinTs = Infinity;

for (const d of snap.docs) {
    totalDocs++;
    const x = d.data() || {};
    if (x.mode === 'backtesting') { backtest++; continue; }
    if (x.duplicateOf) { dupes++; continue; }
    const ts = Number(x.timestamp ?? 0);
    if (!ts || ts < cutoffTs) { outOfWindow++; continue; }
    if (ts < journalMinTs) journalMinTs = ts;
    const result = String(x.result ?? '');
    if (x.adopted === true) { adopted++; continue; }
    if (result === 'SKIP' || x.ctraderStatus === 'ABORTED' || x.skipReason) { skipped++; continue; }
    if (!result) { open++; continue; }
    const { entryType, derived } = deriveEntryType(x);
    if (derived) derivedN++;
    const r = Number.isFinite(Number(x.rMultiple)) ? Number(x.rMultiple) : null;
    const usd = Number.isFinite(Number(x.ctrader_real_pnl)) ? Number(x.ctrader_real_pnl) : null;
    closed.push({ type: entryType, ticker: String(x.ticker || '?').toUpperCase(), result, r, usd });
}

// ── Agregar por tipo de entrada ──
const groups = new Map<string, GroupAgg>();
for (const t of closed) {
    let g = groups.get(t.type);
    if (!g) { g = newAgg(); groups.set(t.type, g); }
    g.n++;
    if (t.result === 'WIN') g.wins++;
    else if (t.result === 'LOSS') g.losses++;
    else if (t.result === 'BREAKEVEN') g.be++;
    else g.other++;
    if (t.r != null) { g.sumR += t.r; g.nR++; if (t.r > g.bestR) g.bestR = t.r; if (t.r < g.worstR) g.worstR = t.r; }
    if (t.usd != null) { g.sumUsd += t.usd; g.nUsd++; }
    let bt = g.byTicker.get(t.ticker);
    if (!bt) { bt = { n: 0, sumR: 0, sumUsd: 0 }; g.byTicker.set(t.ticker, bt); }
    bt.n++; if (t.r != null) bt.sumR += t.r; if (t.usd != null) bt.sumUsd += t.usd;
}

// ── Embudo de telemetría (sanity check) — restringido a la ventana con RESULTADOS en el journal ──
const journalSinceDay = Number.isFinite(journalMinTs) ? new Date(journalMinTs).toISOString().slice(0, 10) : sinceDay;
const telSnap = await db.collection('trigger_telemetry').get();
const funnel = { oteWaits: 0, oteExecutions: 0, directEntries: 0, since: journalSinceDay };
for (const doc of telSnap.docs) {
    if (doc.id < journalSinceDay) continue;
    const data = doc.data() || {};
    for (const [k, v] of Object.entries(data)) {
        const b = v as any;
        if (!b || typeof b !== 'object') continue;
        const trigger = String(k).split('|')[2] ?? '';
        if (!trigger.startsWith('ote')) continue;
        funnel.oteWaits += b.oteWaits || 0;
        funnel.oteExecutions += b.oteExecutions || 0;
    }
    // directas: todas las claves (no solo ote*)
    for (const [k, v] of Object.entries(data)) {
        const b = v as any;
        if (!b || typeof b !== 'object') continue;
        funnel.directEntries += b.directEntries || 0;
    }
}

// ── Salida consola ──
console.log(`\n═══ OTE vs DIRECTO — últimos ${days} días (journal + embudo de telemetría) ═══`);
console.log(`Cobertura journal: ${totalDocs} docs totales | en ventana cerrados=${closed.length} | abiertos=${open} | SKIP/abortados=${skipped} | adoptados=${adopted} | fuera de ventana=${outOfWindow} | backtest=${backtest} | duplicados=${dupes}`);
console.log(`Ventana con resultados: journal tiene docs desde ${journalSinceDay} (el resto de la ventana no tiene datos de resultados).`);
if (derivedN > 0) console.log(`  (${derivedN} docs sin entryType almacenado → clasificados al vuelo con la misma lógica de journal.ts)`);
console.log('');

const ORDER = ['OTE', 'DIRECTO', 'UNKNOWN'];
const rows = [...groups.entries()].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
console.log('tipo      n    W   L   BE  otro   WR%      ΣR      R/trade   R medido   ΣUSD      USD/trade');
console.log('────────────────────────────────────────────────────────────────────────────────────────────────');
for (const [type, g] of rows) {
    const dec = g.wins + g.losses;
    const wr = dec > 0 ? ((g.wins / dec) * 100).toFixed(1) : '  -  ';
    const avgR = g.nR > 0 ? g.sumR / g.nR : 0;
    const avgUsd = g.nUsd > 0 ? g.sumUsd / g.nUsd : 0;
    console.log(`${type.padEnd(8)} ${String(g.n).padStart(3)} ${String(g.wins).padStart(4)} ${String(g.losses).padStart(3)} ${String(g.be).padStart(3)} ${String(g.other).padStart(4)}  ${String(wr).padStart(5)}%  ${g.sumR.toFixed(2).padStart(7)}  ${avgR.toFixed(2).padStart(8)}  ${String(g.nR).padStart(3)}/${g.n}  ${g.sumUsd.toFixed(2).padStart(8)}  ${avgUsd.toFixed(2).padStart(9)}`);
    if (g.nR > 0 && g.bestR !== -Infinity) console.log(`         mejor=${g.bestR.toFixed(2)}R · peor=${g.worstR.toFixed(2)}R`);
}
console.log('');

// Desglose por ticker (solo grupos con ≥1 cerrado)
for (const [type, g] of rows) {
    const tks = [...g.byTicker.entries()].sort((a, b) => b[1].sumR - a[1].sumR);
    if (!tks.length) continue;
    console.log(`── ${type} por activo (ΣR y ΣUSD, solo cerrados) ──`);
    for (const [tk, s] of tks) {
        console.log(`   ${tk.padEnd(10)} n=${String(s.n).padStart(2)}  ΣR=${s.sumR.toFixed(2).padStart(6)}  ΣUSD=${s.sumUsd.toFixed(2).padStart(8)}`);
    }
    console.log('');
}

// Cruce embudo ↔ journal
console.log('── Cruce con el embudo (telemetría misma ventana) ──');
const jOte = groups.get('OTE')?.n ?? 0;
const jDir = groups.get('DIRECTO')?.n ?? 0;
console.log(`   esperas OTE registradas: ${funnel.oteWaits}`);
console.log(`   ejecuciones OTE (telemetría): ${funnel.oteExecutions}  |  cerradas con resultado en journal (OTE): ${jOte}`);
console.log(`   entradas directas (telemetría): ${funnel.directEntries}  |  cerradas con resultado en journal (DIRECTO): ${jDir}`);
console.log(`   nota: telemetría cuenta ejecuciones; journal cuenta cerrados (hay abiertos, SKIP y legs que nunca ejecutaron).`);
console.log('');

// ── Salida JSON ──
const outPath = path.resolve('scripts/periodic_opt/reports/ote_vs_directo.json');
const out = {
    generatedAt: now.toISOString(),
    windowDays: days,
    coverage: { totalDocs, closed: closed.length, open, skipped, adopted, outOfWindow, backtest, dupes, derivedEntryType: derivedN, journalSince: journalSinceDay },
    funnel,
    groups: Object.fromEntries([...groups.entries()].map(([t, g]) => [t, {
        n: g.n, wins: g.wins, losses: g.losses, breakeven: g.be, other: g.other,
        winRate: (g.wins + g.losses) > 0 ? g.wins / (g.wins + g.losses) : null,
        sumR: +g.sumR.toFixed(4), avgR: g.nR > 0 ? +(g.sumR / g.nR).toFixed(4) : null,
        rCoverage: `${g.nR}/${g.n}`,
        sumUsd: +g.sumUsd.toFixed(2), avgUsd: g.nUsd > 0 ? +(g.sumUsd / g.nUsd).toFixed(2) : null,
        usdCoverage: `${g.nUsd}/${g.n}`,
        bestR: g.bestR === -Infinity ? null : g.bestR, worstR: g.worstR === Infinity ? null : g.worstR,
        byTicker: Object.fromEntries([...g.byTicker.entries()].map(([tk, s]) => [tk, { n: s.n, sumR: +s.sumR.toFixed(4), sumUsd: +s.sumUsd.toFixed(2) }])),
    }])),
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`💾 Reporte escrito en ${outPath}`);

// ── Resumen por Telegram (--telegram, para el pipeline dominical) ──
// NOTA: se usa grammy DIRECTAMENTE (no src/bot/telegram.ts) porque ese módulo
// arrastra el MCP router y el loop del agente → EPIPE/crash al salir de un script.
if (sendTelegram) {
    try {
        const [{ Bot }, { config }] = await Promise.all([
            import('grammy'),
            import('../src/config.js'),
        ]);
        const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
        await bot.api.getMe(); // valida token/red (equivale a bot.init())
        const g = (t: string) => groups.get(t);
        const o = g('OTE'), d = g('DIRECTO');
        const line = (t: string, x: GroupAgg | undefined) => x
            ? `${t}: ${x.n} cerrados | ${x.wins}W/${x.losses}L${x.be ? `/${x.be}BE` : ''} | WR ${x.wins + x.losses > 0 ? ((x.wins / (x.wins + x.losses)) * 100).toFixed(0) : '—'}% | ΣR ${x.sumR.toFixed(2)} | ΣUSD ${x.sumUsd >= 0 ? '+' : ''}${x.sumUsd.toFixed(2)}`
            : `${t}: sin datos`;
        const msg = [
            '📊 <b>OTE vs DIRECTO — semana</b>',
            `Ventana resultados: ${journalSinceDay} → hoy (${closed.length} cerrados)`,
            line('OTE', o),
            line('DIRECTO', d),
            `Embudo: ${funnel.oteWaits} esperas OTE → ${funnel.oteExecutions} ejec | ${funnel.directEntries} directas`,
            '⚠️ Muestra chica: no decidir con una sola semana.',
            `Detalle: scripts/periodic_opt/reports/ote_vs_directo.json`,
        ].join('\n');
        for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
            try { await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' }); }
            catch (e: any) {
                try { await bot.api.sendMessage(userId, msg.replace(/<[^>]*>/g, '')); }
                catch { console.warn(`[OTE-VS-DIRECTO] Telegram falló para ${userId}: ${e.message}`); }
            }
        }
        console.log('[OTE-VS-DIRECTO] Resumen enviado por Telegram.');
    } catch (e: any) {
        console.warn(`[OTE-VS-DIRECTO] Telegram no disponible (${e.message}) — el reporte JSON quedó igual.`);
    }
}
process.exit(0);
