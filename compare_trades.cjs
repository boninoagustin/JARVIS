const fs = require('fs');
const pine = JSON.parse(fs.readFileSync('logs/jarvis_bt_EURUSD_1785278616505.json', 'utf8'));
const smc = JSON.parse(fs.readFileSync('logs/jarvis_bt_EURUSD_1785278577579.json', 'utf8'));

const pineTrades = pine.trades.map(t => ({ ts: new Date(t.timestamp).toISOString(), dir: t.direction, ev: t.events.join(','), p: t.entryPrice, result: t.result, grade: t.grade }));
const smcTrades = smc.trades.map(t => ({ ts: new Date(t.timestamp).toISOString(), dir: t.direction, ev: t.events.join(','), p: t.entryPrice, result: t.result, grade: t.grade }));

console.log("Pine Trades: " + pineTrades.length);
console.log("SMC Trades: " + smcTrades.length);

const pineTs = new Set(pineTrades.map(t => t.ts));
const smcTs = new Set(smcTrades.map(t => t.ts));

console.log("\nTrades in Pine but NOT in SMC:");
pineTrades.filter(t => !smcTs.has(t.ts)).forEach(t => console.log(`  ${t.ts} ${t.dir} @ ${t.p} [${t.ev}] (${t.result}) Grade:${t.grade}`));

console.log("\nTrades in SMC but NOT in Pine:");
smcTrades.filter(t => !pineTs.has(t.ts)).forEach(t => console.log(`  ${t.ts} ${t.dir} @ ${t.p} [${t.ev}] (${t.result}) Grade:${t.grade}`));
