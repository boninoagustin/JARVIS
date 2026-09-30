// Calcula ADR (rango diario promedio, últimos 20 días) por activo desde los históricos M5.
// 🆕 30-sep-2026: descubre TODOS los tickers con histórico (antes lista fija de 10).
// Uso: npx tsx scripts/calc_adr_table.ts
import fs from 'node:fs';
import path from 'node:path';

const LOGS_DIR = '/opt/JARVIS/logs';

function pipSizeFor(t: string): number {
    if (t.includes('JPY')) return 0.01;
    if (t.includes('XAU') || t.includes('GOLD')) return 0.1;
    if (t.includes('XAG') || t.includes('XPT') || t.includes('XPD')) return 0.01;
    if (t.includes('OIL') || t.includes('XTI') || t.includes('WTI') || t.includes('BRENT') || t.includes('XBR') || t.includes('NATGAS') || t.includes('NGAS')) return 0.01;
    if (t.includes('BTC') || t.includes('ETH')) return 1;
    if (t.includes('US30') || t.includes('DOW') || t.includes('NAS') || t.includes('US100') || t.includes('USTEC') || t.includes('USTECH')
        || t.includes('SPX') || t.includes('US500') || t.includes('GER') || t.includes('DE40') || t.includes('DAX')
        || t.includes('JP225') || t.includes('NIKKEI') || t.includes('NL25') || t.includes('ITALY') || t.includes('FRA40')
        || t.includes('UK100') || t.includes('FTSE') || t.includes('SPAIN') || t.includes('IBEX') || t.includes('EUROPE')
        || t.includes('EU50') || t.includes('AUSTRALIA') || t.includes('AUS200') || t.includes('NIFTY') || t.includes('HK50')
        || t.includes('HSI') || t.includes('CN50') || t.includes('KOSPI') || t.includes('US2000') || t.includes('RUSSELL')) return 1;
    return 0.0001; // forex
}

// Descubrir tickers con histórico M5 exportado
const tickers: string[] = [];
for (const dir of fs.readdirSync(LOGS_DIR)) {
    const csv = path.join(LOGS_DIR, dir, 'history_exported', 'pine-logs-SMC Master_M5.csv');
    if (fs.existsSync(csv)) tickers.push(dir);
}
tickers.sort();

console.log(`Tickers con histórico M5: ${tickers.length}\n`);
console.log('TICKER    | ADR        | pips    | días');
console.log('----------|------------|---------|-----');
const results: { ticker: string; adr: number; days: number }[] = [];
for (const t of tickers) {
    const csv = path.join(LOGS_DIR, t, 'history_exported', 'pine-logs-SMC Master_M5.csv');
    const lines = fs.readFileSync(csv, 'utf8').split('\n');
    const byDay = new Map<string, { h: number; l: number }>();
    for (const ln of lines) {
        if (!ln.includes('PING_PRICE')) continue;
        const m = ln.match(/(\d{4}-\d{2}-\d{2})T.*?PING_PRICE.*?High:\s*([0-9.]+).*?Low:\s*([0-9.]+)/i);
        if (!m) continue;
        const h = parseFloat(m[2]), l = parseFloat(m[3]);
        if (!(h > l)) continue;
        const d = byDay.get(m[1]) || { h: -1e9, l: 1e9 };
        d.h = Math.max(d.h, h); d.l = Math.min(d.l, l);
        byDay.set(m[1], d);
    }
    const ranges = [...byDay.values()].map(d => d.h - d.l);
    if (ranges.length < 5) { console.log(`${t.padEnd(9)} | sin datos (${ranges.length} días)`); continue; }
    const last20 = ranges.slice(-20);
    const adr = last20.reduce((a, b) => a + b, 0) / last20.length;
    const pip = pipSizeFor(t.toUpperCase());
    const cls = pip >= 1 ? 'pts' : pip >= 0.01 && !t.toUpperCase().includes('JPY') ? 'cents' : 'pips';
    console.log(`${t.padEnd(9)} | ${adr.toFixed(5).padStart(10)} | ${(adr / pip).toFixed(0).padStart(6)} ${cls} | ${ranges.length}`);
    results.push({ ticker: t.toUpperCase(), adr, days: ranges.length });
}
console.log('\n=== TABLA para tp2Cap.ts (ADR_TABLE) ===');
for (const r of results) {
    console.log(`    ${r.ticker}: ${Number(r.adr.toFixed(6))},`);
}
