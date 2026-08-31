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
        'GER40': 'GERMANY 40'
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

    // Sort uniquely by timestamp just in case
    const uniqueMap = new Map<number, any>();
    allCandles.forEach(c => uniqueMap.set(c.timestamp, c));
    const sortedCandles = Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);

    const outPath = path.join(outDir, `history_${periodStr}.csv`);
    
    // Generate CSV
    const csvLines = ['timestamp,open,high,low,close,volume'];
    sortedCandles.forEach(c => {
        csvLines.push(`${c.timestamp},${c.open},${c.high},${c.low},${c.close},${c.volume}`);
    });
    
    fs.writeFileSync(outPath, csvLines.join('\n'));
    console.log(`[Fetch] Saved ${sortedCandles.length} candles to ${outPath}`);
}

async function main() {
    console.log('Connecting to cTrader...');
    const connected = await connectCTrader();
    if (!connected) {
        console.error('Failed to connect to cTrader');
        process.exit(1);
    }
    console.log('Connected.');

    const fromDate = new Date('2026-01-01T00:00:00Z').getTime();
    const toDate = Date.now();

    const timeframes = [
        { p: TrendbarPeriod.M15, str: 'M15' },
        { p: TrendbarPeriod.H1, str: 'H1' },
        { p: TrendbarPeriod.H4, str: 'H4' },
        { p: TrendbarPeriod.D1, str: 'D1' },
        { p: TrendbarPeriod.M5, str: 'M5' }
    ];

    let tickers = ['EURUSD', 'GBPUSD', 'US500', 'XAUUSD', 'USDCAD', 'USDJPY', 'AUDCAD', 'NZDUSD', 'USOIL', 'BTCUSD'];
    if (process.argv.length > 2) {
        tickers = [process.argv[2]];
    }

    for (const ticker of tickers) {
        for (const tf of timeframes) {
            try {
                await fetchHistoricalData(ticker, tf.p, tf.str, fromDate, toDate);
            } catch (err) {
                console.error(`Error fetching ${ticker} ${tf.str}:`, err);
            }
        }
    }
    
    console.log('Done fetching history.');
    process.exit(0);
}

main().catch(console.error);
