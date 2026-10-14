import { connectCTrader, ctClient } from '../src/services/ctrader.js';
import { TrendbarPeriod } from 'ctrader-ts';
import fs from 'fs';
import path from 'path';

// Copied from mapToCTraderSymbol (internal utility in JARVIS, or we can just hardcode for EURUSD)
function mapToCTraderSymbol(ticker: string): string {
    const map: any = {
        'EURUSD': 'EURUSD',
        'GBPUSD': 'GBPUSD',
        'US500': 'US 500',
        'XAUUSD': 'XAUUSD',
        'USDCAD': 'USDCAD',
        'USDJPY': 'USDJPY',
        'AUDCAD': 'AUDCAD',
        'NZDUSD': 'NZDUSD',
        'USOIL': 'XTIUSD',
        'BTCUSD': 'BTCUSD',
        'GBPJPY': 'GBPJPY',
        'AUDJPY': 'AUDJPY',
        'GER40': 'GERMANY 40',
        'JP225': 'JAPAN 225',
        'NIKKEI225': 'JAPAN 225'
    };
    return map[ticker] || ticker;
}



async function fetchHistoricalData(ticker: string, period: TrendbarPeriod, periodStr: string, fromTimestamp: number, toTimestamp: number) {
    console.log(`[Fetch] Fetching ${ticker} ${periodStr} from ${new Date(fromTimestamp).toISOString()} to ${new Date(toTimestamp).toISOString()}`);
    
    const ctraderSymbol = mapToCTraderSymbol(ticker);
    const info = await ctClient.getSymbolInfo(ctraderSymbol);
    if (!info || !info.symbolId) throw new Error(`Symbol no encontrado: ${ctraderSymbol}`);

    let currentFrom = fromTimestamp;
    let allCandles: any[] = [];
    
    // Fetch in chunks of 30 days to avoid cTrader limits
    const chunkMs = 30 * 24 * 60 * 60 * 1000; 

    while (currentFrom < toTimestamp) {
        let currentTo = Math.min(currentFrom + chunkMs, toTimestamp);
        
        console.log(`  -> Fetching chunk ${new Date(currentFrom).toISOString()} to ${new Date(currentTo).toISOString()}`);
        
        const res = await ctClient.raw.market.getTrendbars({
            symbolId: info.symbolId,
            period: period,
            fromTimestamp: currentFrom,
            toTimestamp: currentTo
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
                    volume: tb.volume || 0
                };
            });
            allCandles = allCandles.concat(newCandles);
            console.log(`  -> Got ${newCandles.length} candles.`);
        }
        
        currentFrom = currentTo;
        // sleep a bit to avoid rate limiting
        await new Promise(r => setTimeout(r, 200));
    }

    const outDir = path.join(process.cwd(), 'logs', ticker.toLowerCase(), 'history');
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    // 🆕 16-sep-2026 INCREMENTAL: fusiona con las velas que YA hay en el archivo (dedupe
    // por timestamp) — sin esto, cada corrida reescribía solo lo descargado y perdía la
    // historia acumulada.
    const outPath = path.join(outDir, `history_${periodStr}.csv`);
    let existing: any[] = [];
    if (fs.existsSync(outPath)) {
        try {
            existing = fs.readFileSync(outPath, 'utf8').split('\n').slice(1)
                .filter(l => l.trim())
                .map(l => {
                    const c = l.split(',');
                    return { timestamp: Number(c[0]), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]) };
                });
        } catch { existing = []; }
    }
    allCandles = allCandles.concat(existing);

    // Sort uniquely by timestamp just in case
    const uniqueMap = new Map<number, any>();
    allCandles.forEach(c => uniqueMap.set(c.timestamp, c));
    const sortedCandles = Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    
    // Generate CSV
    const csvLines = ['timestamp,open,high,low,close,volume'];
    sortedCandles.forEach(c => {
        csvLines.push(`${c.timestamp},${c.open},${c.high},${c.low},${c.close},${c.volume}`);
    });
    
    fs.writeFileSync(outPath, csvLines.join('\n'));
    console.log(`[Fetch] Saved ${sortedCandles.length} candles to ${outPath}`);
}

// 🆕 16-sep-2026: tickers dinámicos — active_tickers de Firestore ∪ lista base de 14.
async function resolveTickers(): Promise<string[]> {
    const base = ['EURUSD', 'GBPUSD', 'US500', 'XAUUSD', 'USDCAD', 'USDJPY', 'AUDCAD', 'NZDUSD', 'USOIL', 'BTCUSD', 'AUDJPY', 'GBPJPY', 'GER40', 'JP225'];
    try {
        const adminMod: any = await import('firebase-admin');
        const admin = adminMod.default ?? adminMod;
        if (!admin.apps.length) {
            const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json', 'utf8'));
            admin.initializeApp({ credential: admin.credential.cert(sa) });
        }
        const d = await admin.firestore().collection('optimization_config').doc('active_tickers').get();
        const list: string[] = d.exists ? (d.data()?.tickers ?? []) : [];
        return [...new Set([...list, ...base])].map(t => t.toUpperCase());
    } catch {
        return base;
    }
}

async function main() {
    console.log('Connecting to cTrader...');
    const connected = await connectCTrader();
    if (!connected) {
        console.error('Failed to connect to cTrader');
        process.exit(1);
    }
    console.log('Connected.');

    // 🆕 16-sep-2026 INCREMENTAL: descarga desde la ÚLTIMA vela que ya tiene el archivo
    // (menos 24h de solape para corregir velas republicadas por el broker). Si el archivo
    // no existe → full desde enero. Antes: fromDate fijo 2026-01-01 → re-descargaba TODO
    // cada vez. En el flujo semanal esto equivale a bajar solo la semana nueva (dom→dom).
    const DEFAULT_FROM = new Date('2026-01-01T00:00:00Z').getTime();
    const toDate = Date.now();

    const timeframes = [
        { p: TrendbarPeriod.M15, str: 'M15' },
        { p: TrendbarPeriod.H1, str: 'H1' },
        { p: TrendbarPeriod.H4, str: 'H4' },
        { p: TrendbarPeriod.D1, str: 'D1' },
        { p: TrendbarPeriod.M5, str: 'M5' }
    ];

    const lastCandleMs = (ticker: string, tf: string): number => {
        const p = path.join(process.cwd(), 'logs', ticker.toLowerCase(), 'history', `history_${tf}.csv`);
        if (!fs.existsSync(p)) return 0;
        try {
            const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
            if (lines.length < 2) return 0;
            return Number(lines[lines.length - 1].split(',')[0]) || 0;
        } catch { return 0; }
    };

    // 🆕 16-sep-2026: tickers DINÁMICOS (Firestore active_tickers ∪ lista base de 14).
    // Antes estaban hardcodeados 10 (faltaban AUDJPY/GBPJPY/GER40/JP225).
    let tickers = await resolveTickers();
    if (process.argv.length > 2) {
        tickers = [process.argv[2]];
    }
    console.log(`[Fetch] tickers: ${tickers.join(', ')}`);

    for (const ticker of tickers) {
        for (const tf of timeframes) {
            try {
                // 🆕 16-sep-2026: from = última vela del archivo − 24h (solape anti-republicación);
                // sin archivo → full desde enero.
                const lastMs = lastCandleMs(ticker, tf.str);
                const fromTs = lastMs > 0 ? lastMs - 24 * 3600 * 1000 : DEFAULT_FROM;
                await fetchHistoricalData(ticker, tf.p, tf.str, fromTs, toDate);
            } catch (err) {
                console.error(`Error fetching ${ticker} ${tf.str}:`, err);
            }
        }
    }
    
    console.log('Done fetching history.');
    process.exit(0);
}

main().catch(console.error);
