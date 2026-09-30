// Calcula ADR (rango diario promedio, últimos 20 días) por activo desde los históricos M5.
// 🆕 30-sep-2026: descubrimiento automático de tickers + función exportable para
// scripts/update_adr_table.ts (regeneración semanal del dominical).
// Uso CLI: npx tsx scripts/calc_adr_table.ts
import fs from 'node:fs';
import path from 'node:path';

export const LOGS_DIR = '/opt/JARVIS/logs';

export function pipSizeFor(t: string): number {
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

export interface AdrResult { ticker: string; adr: number; days: number; }

/** Mide el ADR de TODOS los tickers con histórico M5 exportado (últimos 20 días). */
export function measureAdrTable(): AdrResult[] {
    const tickers: string[] = [];
    for (const dir of fs.readdirSync(LOGS_DIR)) {
        const csv = path.join(LOGS_DIR, dir, 'history_exported', 'pine-logs-SMC Master_M5.csv');
        if (fs.existsSync(csv)) tickers.push(dir);
    }
    tickers.sort();
    const results: AdrResult[] = [];
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
        if (ranges.length < 5) continue;
        const last20 = ranges.slice(-20);
        const adr = last20.reduce((a, b) => a + b, 0) / last20.length;
        results.push({ ticker: t.toUpperCase(), adr, days: ranges.length });
    }
    return results;
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && path.basename(process.argv[1]).startsWith('calc_adr_table')) {
    const results = measureAdrTable();
    console.log(`Tickers con histórico M5: ${results.length}\n`);
    console.log('TICKER    | ADR        | pips    | días');
    console.log('----------|------------|---------|-----');
    for (const r of results) {
        const pip = pipSizeFor(r.ticker);
        const cls = pip >= 1 ? 'pts' : pip >= 0.01 && !r.ticker.includes('JPY') ? 'cents' : 'pips';
        console.log(`${r.ticker.padEnd(9)} | ${r.adr.toFixed(5).padStart(10)} | ${(r.adr / pip).toFixed(0).padStart(6)} ${cls} | ${r.days}`);
    }
}
