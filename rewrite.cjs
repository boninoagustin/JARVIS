const fs = require('fs');
let code = fs.readFileSync('jarvis-os/src/services/backtestEngine.ts', 'utf8');

const preParseFn = `
function preParseAlert(alertText: string): any {
  const textUpToPayload = alertText.includes('Payload:') ? alertText.split('Payload:')[0] : alertText;
  const parts = textUpToPayload.split(/[,|]/).map(p => p.trim());
  if (parts.length < 2) return undefined;

  const prefix = parts[0].toUpperCase();
  const upperText = alertText.toUpperCase();

  const tfMatch = alertText.match(/TF:\\s*([a-zA-Z0-9]+)/i);
  const eventTf = tfMatch ? tfMatch[1] : 'UNKNOWN';
  const readableTf = parseTF(eventTf);

  let currentDirection: 'BUY' | 'SELL' | null = null;
  if (upperText.includes('BUY') || upperText.includes('BULLISH')) currentDirection = 'BUY';
  else if (upperText.includes('SELL') || upperText.includes('BEARISH')) currentDirection = 'SELL';

  const parsed: any = { prefix, eventTf, readableTf, currentDirection };

  if (prefix === 'SYNC_ZONES') {
    const trendMatch = alertText.match(/Trend:\\s*(BUY|SELL)/i);
    if (trendMatch) parsed.trendMatch = trendMatch[1].toUpperCase();
    if (alertText.includes('Payload:')) {
      const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();
      try {
        parsed.rawZones = JSON.parse(payloadStr);
      } catch { /* ignore */ }
    }
  }

  if (prefix === 'PING_PRICE') {
    const priceMatch = alertText.match(/Precio:\\s*([0-9.]+)/i);
    if (priceMatch) parsed.currentPrice = parseFloat(priceMatch[1]);
    const highMatch = alertText.match(/High:\\s*([0-9.]+)/i);
    const lowMatch = alertText.match(/Low:\\s*([0-9.]+)/i);
    if (highMatch) parsed.highPrice = parseFloat(highMatch[1]);
    if (lowMatch) parsed.lowPrice = parseFloat(lowMatch[1]);
  }
  
  if (prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS' || prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
    const originMatch = alertText.match(/ORIGIN:\\s*([0-9.]+)/i);
    if (originMatch) parsed.origin = parseFloat(originMatch[1]);
    const priceMatch = alertText.match(/Precio:\\s*([0-9.]+)/i);
    if (priceMatch) parsed.currentPrice = parseFloat(priceMatch[1]);
  }
  
  if (upperText.includes('VWAP UNDER')) parsed.vwapUnder = true;
  if (upperText.includes('VWAP OVER')) parsed.vwapOver = true;

  return parsed;
}
`;

// Insert preParseFn before processAlert
code = code.replace('function processAlert(', preParseFn + '\nfunction processAlert(');

// In runBacktest, modify caching loop
code = code.replace(
  'allEntries.push({ ts: tsMatch ? parseInt(tsMatch[1], 10) : 0, line, tf });',
  'allEntries.push({ ts: tsMatch ? parseInt(tsMatch[1], 10) : 0, line, tf, parsed: preParseAlert(line) });'
);

// Update processAlert signature and first few lines
code = code.replace(
  /function processAlert\([\s\S]*?\n\) \{[\s\S]*?const sessionId = \`\$\{todayStr\}-\$\{currentSession\}\`;/,
  `function processAlert(
  entry: LogEntry, nowMs: number, state: RadarState,
  config: BacktestConfig, trades: BacktestTrade[],
  activeTrades: Map<string, BacktestTrade>,
  dailyStats: DailyStats
) {
  const p = entry.parsed;
  if (!p) return;
  const { prefix, eventTf, readableTf, currentDirection } = p;
  const alertText = entry.line;
  const upperText = alertText.toUpperCase();
  const ticker = config.ticker;
  const todayStr = new Date(nowMs).toISOString().split('T')[0];
  const currentSession = getSessionForTimestamp(nowMs);
  const sessionId = \`\${todayStr}-\${currentSession}\`;`
);

// Update calls to processAlert
code = code.replace(
  'processAlert(entry.line, entry.ts, state, config, trades, activeTrades, dailyStats);',
  'processAlert(entry, entry.ts, state, config, trades, activeTrades, dailyStats);'
);
code = code.replace(
  'processAlert(restEntries[i].line, restEntries[i].ts, state, config, trades, activeTrades, dailyStats);',
  'processAlert(restEntries[i], restEntries[i].ts, state, config, trades, activeTrades, dailyStats);'
);

// SYNC_ZONES replacements
code = code.replace(
  /const trendMatch = alertText\.match\(\/Trend:\\s\*\(BUY\|SELL\)\/i\);\n\s*if \(trendMatch\) state\.marketBias\[sourceTf\] = trendMatch\[1\]\.toUpperCase\(\);/,
  `if (p.trendMatch) state.marketBias[sourceTf] = p.trendMatch;`
);

code = code.replace(
  /const rawZones = JSON\.parse\(payloadStr\) as Record<string, unknown>\[\];/,
  `const rawZones = p.rawZones as Record<string, unknown>[];\n      if (!rawZones) return;`
);

// PING_PRICE replacements
code = code.replace(
  /const priceMatch = alertText\.match\(\/Precio:\\s\*\(\[0-9\.\]\+\)\/i\);\n\s*if \(\!priceMatch\) return;\n\s*const currentPrice = parseFloat\(priceMatch\[1\]\);\n\s*const highMatch = alertText\.match\(\/High:\\s\*\(\[0-9\.\]\+\)\/i\);\n\s*const lowMatch = alertText\.match\(\/Low:\\s\*\(\[0-9\.\]\+\)\/i\);\n\s*const highPrice = highMatch \? parseFloat\(highMatch\[1\]\) : currentPrice;\n\s*const lowPrice = lowMatch \? parseFloat\(lowMatch\[1\]\) : currentPrice;/,
  `if (p.currentPrice === undefined) return;\n    const currentPrice = p.currentPrice;\n    const highPrice = p.highPrice !== undefined ? p.highPrice : currentPrice;\n    const lowPrice = p.lowPrice !== undefined ? p.lowPrice : currentPrice;`
);

// CHOCH and BOS replacements
code = code.replace(
  /const originMatch = alertText\.match\(\/ORIGIN:\\s\*\(\[0-9\.\]\+\)\/i\);\n\s*const priceMatchChoch = alertText\.match\(\/Precio:\\s\*\(\[0-9\.\]\+\)\/i\);\n\s*const originPrice = originMatch \? parseFloat\(originMatch\[1\]\) : 0;\n\s*const execPrice = priceMatchChoch \? parseFloat\(priceMatchChoch\[1\]\) : 0;/,
  `const originPrice = p.origin !== undefined ? p.origin : 0;\n      const execPrice = p.currentPrice !== undefined ? p.currentPrice : 0;`
);

code = code.replace(
  /const originMatch = alertText\.match\(\/ORIGIN:\\s\*\(\[0-9\.\]\+\)\/i\);\n\s*const priceMatch = alertText\.match\(\/Precio:\\s\*\(\[0-9\.\]\+\)\/i\);\n\s*const originPrice = originMatch \? parseFloat\(originMatch\[1\]\) : 0;\n\s*const execPrice = priceMatch \? parseFloat\(priceMatch\[1\]\) : 0;/,
  `const originPrice = p.origin !== undefined ? p.origin : 0;\n      const execPrice = p.currentPrice !== undefined ? p.currentPrice : 0;`
);

// VWAP replacements
code = code.replace(/const vwapUnder = upperText\.includes\('VWAP UNDER'\);/g, 'const vwapUnder = !!p.vwapUnder;');
code = code.replace(/const vwapOver = upperText\.includes\('VWAP OVER'\);/g, 'const vwapOver = !!p.vwapOver;');

fs.writeFileSync('jarvis-os/src/services/backtestEngine.ts', code);
console.log("Done");
