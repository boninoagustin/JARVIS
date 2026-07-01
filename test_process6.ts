import fs from 'fs';
let code = fs.readFileSync('./src/db/trading.ts', 'utf-8');

// Inject console logs
code = code.replace(/if \(!alertText\) return;/, 'if (!alertText) { console.log("ret 1"); return; }');
code = code.replace(/if \(parts.length < 5\) return;/, 'if (parts.length < 5) { console.log("ret 2"); return; }');
code = code.replace(/if \(!\['NAS100'.*?return;/, 'if (!["NAS100", "US30", "GER40", "BTCUSD", "ETHUSD", "SOLUSD", "EURUSD", "GBPUSD", "XAUUSD"].includes(ticker)) { console.log("ret 3 - ticker:", ticker); return; }');
code = code.replace(/if \(globalKillswitches\['GLOBAL_SYSTEM'\]\)/, 'console.log("Killswitch check"); if (globalKillswitches["GLOBAL_SYSTEM"])');

fs.writeFileSync('./src/db/trading_debug.ts', code);
