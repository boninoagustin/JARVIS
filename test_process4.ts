import { processTradingAlert } from './src/db/trading.js';
import { db } from './src/db/memory.js';

async function run() {
  if (!db) return;
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log("Processing alert...");
  await processTradingAlert("EVENTO_CHOCH,NAS100,SELL,20000.0,0.5");
  
  setTimeout(() => process.exit(0), 1000);
}
run();
