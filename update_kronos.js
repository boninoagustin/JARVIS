const fs = require('fs');
let content = fs.readFileSync('src/services/kronos.ts', 'utf8');

const newCode = `
async function fetchYahooOHLCV(yahooSymbol, interval = '5m') {
    try {
        const res = await axios.get(\`https://query1.finance.yahoo.com/v8/finance/chart/\${yahooSymbol}\`, {
            params: {
                interval: interval,
                range: '2d'
            }
        });
        const result = res.data.chart.result[0];
        const timestamps = result.timestamp;
        const ohlcv = result.indicators.quote[0];
        
        let formatted = [];
        for (let i = 0; i < timestamps.length; i++) {
            if (ohlcv.close[i] === null) continue;
            formatted.push({
                timestamp: new Date(timestamps[i] * 1000).toISOString(),
                open: ohlcv.open[i],
                high: ohlcv.high[i],
                low: ohlcv.low[i],
                close: ohlcv.close[i],
                volume: ohlcv.volume[i] || 0,
                amount: (ohlcv.volume[i] || 0) * ohlcv.close[i]
            });
        }
        return formatted;
    } catch (e) {
        console.error(\`[KRONOS] Error fetching Yahoo OHLCV for \${yahooSymbol}:\`, e.message);
        return null;
    }
}

function getYahooSymbol(ticker) {
    const t = ticker.toUpperCase();
    if (t.includes('EURUSD')) return 'EURUSD=X';
    if (t.includes('USDCAD')) return 'USDCAD=X';
    if (t.includes('US100') || t.includes('NAS100') || t.includes('NDX')) return 'NQ=F';
    if (t.includes('XAAUSD') || t.includes('XAUUSD') || t.includes('GOLD')) return 'GC=F';
    if (t.includes('BTCUSD') && !t.includes('USDT')) return 'BTC-USD';
    return null;
}
`;

content = content.replace("export async function evaluateWithKronos", newCode.trim() + "\n\nexport async function evaluateWithKronos");

// Now rewrite evaluateWithKronos to use getYahooSymbol
let evaluateBodyOld = `    // 1. Fetch historical data from Binance
    const klines = await fetchBinanceOHLCV(ticker);`;

let evaluateBodyNew = `    // 1. Try to fetch historical data from Yahoo Finance if it's a known Forex/Index pair
    const yahooSymbol = getYahooSymbol(ticker);
    let klines;
    
    if (yahooSymbol) {
        klines = await fetchYahooOHLCV(yahooSymbol);
    } else {
        klines = await fetchBinanceOHLCV(ticker);
    }`;

content = content.replace(evaluateBodyOld, evaluateBodyNew);

fs.writeFileSync('src/services/kronos.ts', content);
console.log('kronos.ts updated successfully');
