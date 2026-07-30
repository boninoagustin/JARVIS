import { db } from '../src/db/memory.js';

async function cleanRadarStates() {
    console.log('Fetching radar states...');
    const snapshot = await db.collection('radar_states').get();
    let count = 0;

    for (const doc of snapshot.docs) {
        const data = doc.data();
        let needsUpdate = false;
        
        if (data.scoreBuy?.points > 1000) {
            data.scoreBuy.points = 0;
            data.scoreBuy.events = [];
            needsUpdate = true;
        }
        
        if (data.scoreSell?.points > 1000) {
            data.scoreSell.points = 0;
            data.scoreSell.events = [];
            needsUpdate = true;
        }

        if (needsUpdate) {
            await doc.ref.update({
                scoreBuy: data.scoreBuy,
                scoreSell: data.scoreSell
            });
            console.log(`Cleaned points for ${doc.id}`);
            count++;
        }
    }
    
    console.log(`Done! Cleaned ${count} assets.`);
    process.exit(0);
}

cleanRadarStates().catch(console.error);
