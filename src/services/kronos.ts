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

/**
 * Evaluates the setup with the Kronos AI model.
 * Returns the expected trend or null if the API is down/errors out.
 */
export async function evaluateWithKronos(ticker: string, originalDirection: 'BUY' | 'SELL'): Promise<{
    trend: 'BULLISH' | 'BEARISH' | null,
    isConfirmed: boolean,
    details: string
}> {
    
    // 1. Fetch historical data from Binance
    const klines = await fetchBinanceOHLCV(ticker);
    
    if (!klines || klines.length === 0) {
        return { trend: null, isConfirmed: false, details: '🔴 Binance Data Error' };
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
