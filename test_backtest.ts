import { runBacktest } from './jarvis-os/src/services/backtestEngine.ts';

const dummyLogs = new Map<string, string[]>();
dummyLogs.set("240", [
  "2023-01-01 09:00:00 - EVENTO_BOS - BUY - ORIGIN: 1000 - Precio: 1050", // Set 4H bias to BUY
]);
dummyLogs.set("3", [
  "2023-01-01 10:00:00 - EVENTO_CHOCH_3M - BUY - ORIGIN: 1000 - Precio: 1050", // 2 (base) + 5 (bias) = 7 pts >= 5
  "2023-01-01 10:10:00 - HEARTBEAT - Precio: 1050",
  "2023-01-01 10:20:00 - HEARTBEAT - Precio: 1100", // Hits TP1 (since entry=1050, sl=1000, 1R=1100)
  "2023-01-01 10:30:00 - HEARTBEAT - Precio: 1150", // Hits TP2 (2R = 1150)
]);

const config = {
  ticker: "BTCUSD",
  minBuyPoints: 0,
  minSellPoints: 0,
  slBufferPercent: 0,
  fixedRR: 2,
  oteEntryPercent: 50,
  entryTrigger: 'CHOCH' as const
};

const result = runBacktest(dummyLogs, config);

console.log("=== BACKTEST SIMULATION RESULT ===");
result.trades.forEach(t => {
  console.log(`\nTrade ID: ${t.id}`);
  console.log(`Entry: ${t.entryPrice}`);
  console.log(`SL: ${t.slPrice}`);
  console.log(`TP1: ${t.tp1Price}`);
  console.log(`TP2: ${t.tp2Price}`);
  console.log(`TP1 Result: ${t.resultTp1} | R-Multiple TP1: ${t.rMultipleTp1} (Expected $${(t.rMultipleTp1 || 0) * 50} for $50 risk)`);
  console.log(`Final Result: ${t.result} | Final R-Multiple: ${t.rMultiple} (Expected $${(t.rMultiple || 0) * 50} for $50 risk)`);
});
