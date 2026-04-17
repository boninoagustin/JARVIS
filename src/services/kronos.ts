import axios from 'axios';

interface BinanceKline {
    openTime: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    closeTime: number;
    quoteAssetVolume: string;
    trades: number;
    takerBuyBaseAssetVolume: string;
    takerBuyQuoteAssetVolume: string;
    ignore: string;
}

export interface KronosResponse {
    status: string;
    ticker: string;
    trend: 'BULLISH' | 'BEARISH';
    last_close: number;
    future_close_avg: number;
    predictions: any[];
}

const KRONOS_API_URL = process.env.KRONOS_API_URL || 'http://127.0.0.1:8000/predict';

/**
 * Fetches the most recent klines (OHLCV) from Binance for a given symbol.
 */
async function fetchBinanceOHLCV(symbol: string, interval: string = '5m', limit: number = 400) {
    try {
        // Clean suffix .P or PERP from futures tickers
        let cleanSymbol = symbol.toUpperCase().replace(/\.P$/, '').replace(/PERP$/, '');
        // Remove any other non-alphanumeric chars
        cleanSymbol = cleanSymbol.replace(/[^a-zA-Z0-9]/g, '');
        
        let response;
        try {
            // First try Binance Futures
            response = await axios.get(`https://fapi.binance.com/fapi/v1/klines`, {
                params: {
                    symbol: cleanSymbol,
                    interval: interval,
                    limit: limit
                }
            });
        } catch (fapiError: any) {
            if (fapiError.response && fapiError.response.status === 400) {
                // If it fails with 400 (Invalid symbol), fallback to Binance Spot
                response = await axios.get(`https://api.binance.com/api/v3/klines`, {
                    params: {
                        symbol: cleanSymbol,
                        interval: interval,
                        limit: limit
                    }
                });
            } else {
                throw fapiError;
            }
        }

        // Map Binance array format to Kronos KlineData object format
        return response.data.map((kline: any) => ({
            timestamp: new Date(kline[0]).toISOString(),
            open: parseFloat(kline[1]),
            high: parseFloat(kline[2]),
            low: parseFloat(kline[3]),
            close: parseFloat(kline[4]),
            volume: parseFloat(kline[5]),
            amount: parseFloat(kline[7]) // quoteAssetVolume
        }));

    } catch (error: any) {
        console.error(`[KRONOS] Error fetching Binance OHLCV for ${symbol}:`, error.message);
        return null;
    }
}

async function fetchYahooOHLCV(yahooSymbol: string, interval: string = '5m') {
    try {
        const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`, {
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
    } catch (e: any) {
        console.error(`[KRONOS] Error fetching Yahoo OHLCV for ${yahooSymbol}:`, e.message);
        return null;
    }
}

function getYahooSymbol(ticker: string): string | null {
    const t = ticker.toUpperCase();
    if (t.includes('EURUSD')) return 'EURUSD=X';
    if (t.includes('USDCAD')) return 'USDCAD=X';
    if (t.includes('US100') || t.includes('NAS100') || t.includes('NDX')) return 'NQ=F';
    if (t.includes('XAAUSD') || t.includes('XAUUSD') || t.includes('GOLD')) return 'GC=F';
    if (t.includes('BTCUSD') && !t.includes('USDT')) return 'BTC-USD';
    return null;
}

/**
 * Evaluates the setup with the Kronos AI model.
 * Returns the expected trend or null if the API is down/errors out.
 */
export async function evaluateWithKronos(ticker: string, originalDirection: 'BUY' | 'SELL'): Promise<{
    trend: 'BULLISH' | 'BEARISH' | null,
    isConfirmed: boolean,
    details: string
}> {
    
    // 1. Try to fetch historical data from Yahoo Finance if it's a known Forex/Index pair
    const yahooSymbol = getYahooSymbol(ticker);
    let klines;
    let dataProvider = 'Binance';
    
    if (yahooSymbol) {
        klines = await fetchYahooOHLCV(yahooSymbol);
        dataProvider = 'Yahoo Finance';
    } else {
        klines = await fetchBinanceOHLCV(ticker);
    }
    
    if (!klines || klines.length === 0) {
        return { trend: null, isConfirmed: false, details: `🔴 ${dataProvider} Data Error` };
    }

    try {
        // 2. Call Kronos Python API
        const response = await axios.post(KRONOS_API_URL, {
            ticker: ticker,
            klines: klines,
            pred_len: 20 // Predict the next 20 candles
        }, {
            timeout: 15000 // 15 seconds timeout to not block too long
        });

        const data: KronosResponse = response.data;
        
        if (data.status === 'success') {
            const isConfirmed = 
                (originalDirection === 'BUY' && data.trend === 'BULLISH') ||
                (originalDirection === 'SELL' && data.trend === 'BEARISH');
                
            return {
                trend: data.trend,
                isConfirmed: isConfirmed,
                details: `🔮 Predicción promedio a 20 velas: ${data.future_close_avg.toFixed(2)} (${data.trend})`
            };
        }
        
    } catch (error: any) {
        // Do not crash, fail gracefully
        if (error.code === 'ECONNREFUSED') {
            console.error(`[KRONOS] Error: The Python Kronos API is offline at ${KRONOS_API_URL}`);
            return { trend: null, isConfirmed: false, details: '🔴 Kronos API Offline' };
        }
        console.error(`[KRONOS] Prediction Error:`, error.message);
        return { trend: null, isConfirmed: false, details: `🔴 Kronos Error: ${error.message}` };
    }
    
    return { trend: null, isConfirmed: false, details: '🔴 Unknown Kronos Error' };
}
