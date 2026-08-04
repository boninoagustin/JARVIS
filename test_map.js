function mapToCTraderSymbol(ticker) {
    const t = ticker.toUpperCase();
    
    // Common mappings (Funding Pips cTrader)
    const map = {
        'EURUSD': 'EURUSD',
        'GBPUSD': 'GBPUSD',
        'USDJPY': 'USDJPY',
        'USDCAD': 'USDCAD',
        'AUDUSD': 'AUDUSD',
        'AUDCAD': 'AUDCAD',
        'NZDUSD': 'NZDUSD',
        'USDCHF': 'USDCHF',
        'EURJPY': 'EURJPY',
        'GBPJPY': 'GBPJPY',
        'EURGBP': 'EURGBP',
        'XAUUSD': 'XAUUSD',
        'USOIL': 'XTIUSD',
        'BTCUSD': 'BTCUSD',
        'US100': 'US TECH 100',   // Usuario reporta que su broker lo llama 'US TECH 100'
        'NAS100': 'US TECH 100',
        'US30': 'US 30',          // Mapeo corregido a 'US 30'
        'DOW30': 'US 30',
        'US500': 'US 500',        // Mapeo corregido a 'US 500'
        'SPX500': 'US 500',
    };

    // Try exact match first
    if (map[t]) return map[t];
    
    // Try partial match
    for (const [key, value] of Object.entries(map)) {
        if (t.includes(key)) return value;
    }
    
    // Fallback: return as-is
    console.warn(`[CTRADER] ⚠️ Símbolo ${ticker} no mapeado. Usando tal cual.`);
    return t;
}

console.log(mapToCTraderSymbol("USOIL"));
console.log(mapToCTraderSymbol("usoil"));
