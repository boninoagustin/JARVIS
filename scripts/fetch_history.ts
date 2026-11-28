import { TrendbarPeriod } from 'ctrader-ts';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFileSync, withTickerHistoryLock } from './history_lock.js';

export const CTRADER_SYMBOL_MAP: Record<string, string> = {
    'EURUSD': 'EURUSD',
    'GBPUSD': 'GBPUSD',
    'USDCAD': 'USDCAD',
    'USDJPY': 'USDJPY',
    'AUDCAD': 'AUDCAD',
    'NZDUSD': 'NZDUSD',
    'GBPJPY': 'GBPJPY',
    'AUDJPY': 'AUDJPY',
    'EURGBP': 'EURGBP',
    'AUDUSD': 'AUDUSD',
    'USDCHF': 'USDCHF',
    'EURCHF': 'EURCHF',
    'CHFJPY': 'CHFJPY',
    'EURAUD': 'EURAUD',
    'CADJPY': 'CADJPY',
    'GBPAUD': 'GBPAUD',
    'EURCAD': 'EURCAD',
    'GBPCAD': 'GBPCAD',
    'AUDCHF': 'AUDCHF',
    'GBPNZD': 'GBPNZD',
    'CADCHF': 'CADCHF',
    'GBPCHF': 'GBPCHF',
    'NZDCHF': 'NZDCHF',
    'NZDCAD': 'NZDCAD',
    'EURNZD': 'EURNZD',
    'AUDNZD': 'AUDNZD',
    'NZDJPY': 'NZDJPY',
    'XAUUSD': 'XAUUSD',
    'XAGUSD': 'XAGUSD',
    'XPTUSD': 'XPTUSD',
    'XPDUSD': 'XPDUSD',
    'USOIL': 'XTIUSD',
    'XBRUSD': 'XBRUSD',
    'NATGAS': 'NAT.GAS',
    'BTCUSD': 'BTCUSD',
    'US500': 'US 500',
    'US30': 'US 30',
    'USTECH100': 'US TECH 100',
    'GER40': 'GERMANY 40',
    'FRA40': 'FRANCE 40',
    'UK100': 'UK 100',
    'SPAIN35': 'SPAIN 35',
    'NL25': 'NETHERLANDS 25',
    'ITALY40': 'ITALY 40',
    'EUROPE50': 'EUROPE 50',
    'AUSTRALIA200': 'AUSTRALIA 200',
    'JP225': 'JAPAN 225',
    'NIKKEI225': 'JAPAN 225',
};

export function mapToCTraderSymbol(ticker: string): string {
    const key = String(ticker || '').trim().toUpperCase();
    return CTRADER_SYMBOL_MAP[key] || key;
}

export function mergeCandles(existing: any[], incoming: any[]) {
    const uniqueMap = new Map<number, any>();
    for (const c of existing) {
        if (Number.isFinite(c?.timestamp) && c.timestamp > 0 && Number.isFinite(c?.close)) {
            uniqueMap.set(c.timestamp, c);
        }
    }
    for (const c of incoming) {
        if (Number.isFinite(c?.timestamp) && c.timestamp > 0 && Number.isFinite(c?.close)) {
            uniqueMap.set(c.timestamp, c);
        }
    }
    return Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchHistoricalData(
    ctClient: any,
    ticker: string,
    period: TrendbarPeriod,
    periodStr: string,
    fromTimestamp: number,
    toTimestamp: number,
    logsRoot = path.join(process.cwd(), 'logs'),
) {
    console.log(`[Fetch] Fetching ${ticker} ${periodStr} from ${new Date(fromTimestamp).toISOString()} to ${new Date(toTimestamp).toISOString()}`);

    const ctraderSymbol = mapToCTraderSymbol(ticker);
    const info = await ctClient.getSymbolInfo(ctraderSymbol);
    if (!info || !info.symbolId) throw new Error(`Symbol no encontrado: ${ctraderSymbol} (ticker=${ticker})`);

    let currentFrom = fromTimestamp;
    let downloaded: any[] = [];
    const chunkMs = 30 * 24 * 60 * 60 * 1000;

    while (currentFrom < toTimestamp) {
        const currentTo = Math.min(currentFrom + chunkMs, toTimestamp);
        console.log(`  -> Fetching chunk ${new Date(currentFrom).toISOString()} to ${new Date(currentTo).toISOString()}`);

        const res = await ctClient.raw.market.getTrendbars({
            symbolId: info.symbolId,
            period,
            fromTimestamp: currentFrom,
            toTimestamp: currentTo,
        });

        if (res && res.trendbars) {
            const divider = 100000;
            const newCandles = res.trendbars.map((tb: any) => {
                const lowRaw = tb.low || 0;
                return {
                    timestamp: (tb.utcTimestampInMinutes || 0) * 60000,
                    open: (lowRaw + (tb.deltaOpen || 0)) / divider,
                    high: (lowRaw + (tb.deltaHigh || 0)) / divider,
                    low: lowRaw / divider,
                    close: (lowRaw + (tb.deltaClose || 0)) / divider,
                    volume: tb.volume || 0,
                };
            });
            downloaded = downloaded.concat(newCandles);
            console.log(`  -> Got ${newCandles.length} candles.`);
        }

        currentFrom = currentTo;
        await new Promise((r) => setTimeout(r, 200));
    }

    await withTickerHistoryLock(ticker, () => {
        const outDir = path.join(logsRoot, ticker.toLowerCase(), 'history');
        fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `history_${periodStr}.csv`);
        let existing: any[] = [];
        if (fs.existsSync(outPath)) {
            existing = fs.readFileSync(outPath, 'utf8').split(/\r?\n/).slice(1)
                .filter((l) => l.trim())
                .map((l) => {
                    const c = l.split(',');
                    return {
                        timestamp: Number(c[0]),
                        open: Number(c[1]),
                        high: Number(c[2]),
                        low: Number(c[3]),
                        close: Number(c[4]),
                        volume: Number(c[5]),
                    };
                })
                .filter((c) => Number.isFinite(c.timestamp) && c.timestamp > 0);
        }
        const sortedCandles = mergeCandles(existing, downloaded);
        if (sortedCandles.length === 0) {
            throw new Error(`No valid candles available to write for ${ticker} ${periodStr}`);
        }
        if (existing.length > 0 && sortedCandles.length < existing.length) {
            throw new Error(`Refusing history shrinkage for ${ticker} ${periodStr} (${sortedCandles.length} < ${existing.length})`);
        }
        const csvLines = ['timestamp,open,high,low,close,volume'];
        for (const c of sortedCandles) {
            csvLines.push(`${c.timestamp},${c.open},${c.high},${c.low},${c.close},${c.volume}`);
        }
        atomicWriteFileSync(outPath, csvLines.join('\n') + '\n');
        console.log(`[Fetch] Saved ${sortedCandles.length} candles to ${outPath}`);
    }, { timeoutSec: 300, shared: false });
}

async function resolveTickers(): Promise<string[]> {
    const base = ['EURUSD', 'GBPUSD', 'US500', 'XAUUSD', 'USDCAD', 'USDJPY', 'AUDCAD', 'NZDUSD', 'USOIL', 'AUDJPY', 'GBPJPY', 'JP225'];
    try {
        const adminMod: any = await import('firebase-admin');
        const admin = adminMod.default ?? adminMod;
        if (!admin.apps.length) {
            const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
            admin.initializeApp({ credential: admin.credential.cert(sa) });
        }
        const d = await admin.firestore().collection('optimization_config').doc('active_tickers').get();
        const list: string[] = d.exists ? (d.data()?.tickers ?? []) : [];
        if (list.length > 0) return [...new Set(list.map((t) => t.trim().toUpperCase()).filter(Boolean))];
        return base;
    } catch {
        return base;
    }
}

export function parseFetchArgs(argv: string[]) {
    let tickers: string[] | null = null;
    let strict = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--strict') {
            strict = true;
        } else if (a === '--tickers') {
            const val = argv[++i] || '';
            tickers = val.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
        } else if (a.startsWith('--tickers=')) {
            tickers = a.slice('--tickers='.length).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
        } else if (!a.startsWith('--') && !tickers) {
            tickers = a.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
        }
    }
    return { tickers, strict };
}

async function main() {
    const { tickers: explicitTickers, strict } = parseFetchArgs(process.argv.slice(2));
    const { withReadOnlyCTraderClient } = await import('../src/services/ctrader_readonly_client.js');
    console.log('Connecting to cTrader (read-only session)...');

    const DEFAULT_FROM = new Date('2026-01-01T00:00:00Z').getTime();
    const toDate = Date.now();

    const timeframes = [
        { p: TrendbarPeriod.M15, str: 'M15' },
        { p: TrendbarPeriod.H1, str: 'H1' },
        { p: TrendbarPeriod.H4, str: 'H4' },
        { p: TrendbarPeriod.D1, str: 'D1' },
        { p: TrendbarPeriod.M5, str: 'M5' },
    ];

    const lastCandleMs = (ticker: string, tf: string): number => {
        const p = path.join(process.cwd(), 'logs', ticker.toLowerCase(), 'history', `history_${tf}.csv`);
        if (!fs.existsSync(p)) return 0;
        try {
            const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
            if (lines.length < 2) return 0;
            return Number(lines[lines.length - 1].split(',')[0]) || 0;
        } catch {
            return 0;
        }
    };

    const tickers = explicitTickers && explicitTickers.length > 0 ? explicitTickers : await resolveTickers();
    console.log(`[Fetch] tickers (${tickers.length}): ${tickers.join(', ')}`);

    const failures: string[] = [];
    await withReadOnlyCTraderClient(async (client) => {
        console.log('Connected (read-only).');
        for (const ticker of tickers) {
            for (const tf of timeframes) {
                try {
                    const lastMs = lastCandleMs(ticker, tf.str);
                    const fromTs = lastMs > 0 ? lastMs - 24 * 3600 * 1000 : DEFAULT_FROM;
                    await fetchHistoricalData(client, ticker, tf.p, tf.str, fromTs, toDate);
                } catch (err: any) {
                    const msg = `${ticker}/${tf.str}: ${err?.message || err}`;
                    failures.push(msg);
                    console.error(`Error fetching ${msg}`);
                }
            }
        }
    });

    if (failures.length > 0) {
        console.error(`[Fetch] Completed with ${failures.length} failure(s): ${failures.join(' | ')}`);
        if (strict) process.exit(1);
    }
    console.log('Done fetching history.');
    process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
