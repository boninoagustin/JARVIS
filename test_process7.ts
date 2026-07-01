import { processTradingAlert } from './src/db/trading.js';
import { db } from './src/db/memory.js';

async function run() {
  if (!db) return;
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log("Processing EVENTO_CHOCH for a fake ticker...");
  await processTradingAlert("EVENTO_CHOCH,US30,5,BUY,20000.0,0.5");
  
  setTimeout(() => process.exit(0), 1000);
}
run();
