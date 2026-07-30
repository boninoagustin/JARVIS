const fs = require('fs');
let code = fs.readFileSync('src/db/trading.ts', 'utf8');

// Insert buffering logic after imports
const bufferLogic = `

// 🔄 v7.0: Firestore Write Buffers (Debouncing & Batching)
const dirtyStates = new Map<string, RadarState>();
let stateFlushTimeout: NodeJS.Timeout | null = null;

function scheduleStateSave(ticker: string, state: RadarState) {
    // Shallow clone to capture state at the moment or just keep ref (since JS objects are by ref, state will be the latest)
    dirtyStates.set(ticker, { ...state }); 
    if (!stateFlushTimeout) {
        stateFlushTimeout = setTimeout(() => {
            stateFlushTimeout = null;
            if (dirtyStates.size === 0) return;
            if (!db) return;
            const batch = db.batch();
            let count = 0;
            const toSave = new Map(dirtyStates);
            dirtyStates.clear();
            
            for (const [t, s] of toSave.entries()) {
                const ref = db.collection('radar_states').doc(t);
                batch.set(ref, s, { merge: true });
                count++;
            }
            if (count > 0) {
                batch.commit().catch(e => console.error('[FIREBASE] Error in state batch commit:', e.message));
            }
        }, 1000);
    }
}

let rawSignalsBuffer: any[] = [];
let signalFlushTimeout: NodeJS.Timeout | null = null;

function scheduleRawSignalSave(data: any) {
    rawSignalsBuffer.push(data);
    if (!signalFlushTimeout) {
        signalFlushTimeout = setTimeout(() => {
            signalFlushTimeout = null;
            if (rawSignalsBuffer.length === 0) return;
            if (!db) return;
            
            // Limit to 490 per batch to avoid Firestore limits
            const chunks = [];
            while (rawSignalsBuffer.length > 0) {
                chunks.push(rawSignalsBuffer.splice(0, 490));
            }
            
            for (const chunk of chunks) {
                const batch = db.batch();
                for (const sig of chunk) {
                    const ref = db.collection('raw_signals').doc();
                    batch.set(ref, sig);
                }
                batch.commit().catch(e => console.error('[FIREBASE] Error in signals batch commit:', e.message));
            }
        }, 2000);
    }
}
`;

// Insert the buffering logic
code = code.replace('export const getActiveTradeCount =', bufferLogic + '\nexport const getActiveTradeCount =');

// Replace raw_signals.add
const rawSignalOld = `db.collection('raw_signals').add({
            timestamp: nowMs,
            alertText,
            createdAt: new Date(nowMs).toISOString()
        }).catch(() => {});`;
const rawSignalNew = `scheduleRawSignalSave({
            timestamp: nowMs,
            alertText,
            createdAt: new Date(nowMs).toISOString()
        });`;
code = code.replace(rawSignalOld, rawSignalNew);

// Replace docRef.set calls
code = code.replace(/docRef\.set\(state,\s*\{\s*merge:\s*true\s*\}\)\.catch\([^)]*\);/g, 'scheduleStateSave(ticker, state);');
code = code.replace(/docRef\.set\(state\)\.catch\([^)]*\);/g, 'scheduleStateSave(ticker, state);');

fs.writeFileSync('src/db/trading.ts', code);
console.log('Patch applied successfully.');
