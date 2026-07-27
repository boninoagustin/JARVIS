import { TrendbarPeriod } from 'ctrader-ts';

export interface OHLCV {
    timestamp: number; // Unix timestamp in milliseconds
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

// Buffer en memoria para velas históricas y en vivo
// Key format: "SYMBOL:PERIOD" e.g., "EURUSD:M5"
const marketBuffer = new Map<string, OHLCV[]>();

// Mantener máximo 5000 velas por activo/temporalidad en memoria
const MAX_CANDLES = 5000;

/**
 * Añade o actualiza velas en el buffer de memoria.
 * Si la vela ya existe (mismo timestamp), se actualiza (ej. velas en formación).
 */
export function addCandles(ticker: string, period: string, candles: OHLCV[]) {
    const key = `${ticker}:${period}`;
    let buffer = marketBuffer.get(key) || [];
    
    const sortedIncoming = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    
    for (const newCandle of sortedIncoming) {
        const existingIndex = buffer.findIndex(c => c.timestamp === newCandle.timestamp);
        if (existingIndex >= 0) {
            // Actualizar vela existente (la vela actual "Live" cambia constantemente)
            buffer[existingIndex] = newCandle;
        } else {
            // Agregar nueva vela
            buffer.push(newCandle);
        }
    }
    
    // Asegurar orden cronológico estricto
    buffer.sort((a, b) => a.timestamp - b.timestamp);
    
    // Limitar el tamaño del buffer
    if (buffer.length > MAX_CANDLES) {
        buffer = buffer.slice(buffer.length - MAX_CANDLES);
    }
    
    marketBuffer.set(key, buffer);
}

/**
 * Recupera el array de velas para un activo y temporalidad específica.
 */
export function getCandles(ticker: string, period: string): OHLCV[] {
    return marketBuffer.get(`${ticker}:${period}`) || [];
}
