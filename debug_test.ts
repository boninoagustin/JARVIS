import { db } from './src/db/memory.js';

async function main() {
  console.log("1. Starting");
  if (db) {
    console.log("2. db is available, trying to set doc...");
    await db.collection('app_settings').doc('backtesting_status').set({
        replaying: true,
        lastUpdate: Date.now()
    });
    console.log("3. Doc set successfully.");
  } else {
    console.log("2. db is null");
  }
  process.exit(0);
}

main().catch(console.error);
