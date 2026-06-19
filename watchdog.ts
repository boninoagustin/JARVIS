import { db } from './src/db/memory.ts';

console.log("Watchdog started...");

db.collection('app_commands').onSnapshot((snap) => {
    snap.docChanges().forEach(change => {
        console.log(`[APP_COMMANDS] ${change.type}: ${change.doc.id}`, change.doc.data());
    });
});

db.collection('app_settings').doc('backtesting_status').onSnapshot((snap) => {
    console.log(`[BACKTESTING_STATUS] updated:`, snap.data());
});

// Run for 60 seconds
setTimeout(() => {
    console.log("Watchdog finished.");
    process.exit(0);
}, 60000);
