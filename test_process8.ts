import { processTradingAlert } from './src/db/trading.js';
import { db } from './src/db/memory.js';

async function run() {
  if (!db) {
    console.log("No DB");
    return;
  }
  // Wait 2 seconds for firebase to init
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log("Processing PING_PRICE...");
  try {
      await processTradingAlert("PING_PRICE,NAS100,Precio: 20000.0,High: 20010.0,Low: 19990.0");
      console.log("PING DONE");
      await processTradingAlert("EVENTO_CHOCH,NAS100,5,SELL,20000.0,0.5");
      console.log("CHOCH DONE");
  } catch (e) {
      console.error("ERROR:", e);
  }
  
  setTimeout(() => process.exit(0), 2000);
}
run();
