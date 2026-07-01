import { processTradingAlert } from './src/db/trading.js';
import { db } from './src/db/memory.js';

async function run() {
  if (!db) return;
  // wait a bit for firebase listeners to populate
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log("Processing alert...");
  await processTradingAlert("NAS100,5,EVENTO_CHOCH,SELL,20000.0,0.5");
  
  setTimeout(() => process.exit(0), 1000);
}
run();
