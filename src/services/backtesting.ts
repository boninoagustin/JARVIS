import { executeToolByName } from '../mcp/router.js';
import { db } from '../db/memory.js';
import { processTradingAlert } from '../db/trading.js';

let pollingInterval: NodeJS.Timeout | null = null;
let isBacktesting = false;
let currentSessionId: string | null = null;
let currentSessionThresholds: { buy: number; sell: number } | null = null;

export async function startBacktesting(ticker: string, startDate: string, configNote?: string, minBuyPoints?: number, minSellPoints?: number) {
    if (isBacktesting) {
        await stopBacktesting();
    }

    currentSessionId = `BT_${Date.now()}`;
    currentSessionThresholds = { buy: minBuyPoints || 5, sell: minSellPoints || 5 };
    
    console.log(`[BACKTESTING] Starting session ${currentSessionId} for ${ticker} from ${startDate}. Thresholds: B:${currentSessionThresholds.buy} S:${currentSessionThresholds.sell}`);
    isBacktesting = true;

    try {
        // ... (existing code)
        console.log('[BACKTESTING] Launching/Verifying TradingView with CDP...');
        await executeToolByName('tv_launch', { kill_existing: false });
        
        // Wait a bit for TV to be ready
        await new Promise(r => setTimeout(r, 5000));

        // 1. Set symbol
        await executeToolByName('chart_set_symbol', { symbol: ticker });
        
        // 2. Set timeframe to 3M
        await executeToolByName('chart_set_timeframe', { timeframe: '3' });

        // 3. Start replay at date
        await executeToolByName('replay_start', { date: startDate });

        // 4. Start autoplay at 1x
        await executeToolByName('replay_autoplay', { speed: 1000 });

        // 5. Update status in DB
        if (db) {
            await db.collection('app_settings').doc('backtesting_status').set({
                active: true,
                ticker,
                startDate,
                sessionId: currentSessionId,
                configNote,
                minBuyPoints: currentSessionThresholds.buy,
                minSellPoints: currentSessionThresholds.sell,
                lastUpdate: Date.now()
            });

            // Registrar la sesión en una colección histórica
            await db.collection('backtesting_sessions').doc(currentSessionId).set({
                id: currentSessionId,
                ticker,
                startDate,
                configNote,
                minBuyPoints: currentSessionThresholds.buy,
                minSellPoints: currentSessionThresholds.sell,
                timestamp: Date.now(),
                status: 'running'
            });
        }

        // 6. Start polling console
        startPolling();

        return { success: true };
    } catch (err: any) {
        console.error('[BACKTESTING] Error starting:', err.message);
        isBacktesting = false;
        currentSessionId = null;
        return { success: false, error: err.message };
    }
}

export async function stopBacktesting() {
    console.log(`[BACKTESTING] Stopping session ${currentSessionId}`);
    
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }

    try {
        await executeToolByName('replay_stop', {});
        
        if (db && currentSessionId) {
            await db.collection('app_settings').doc('backtesting_status').set({
                active: false,
                lastUpdate: Date.now()
            });

            await db.collection('backtesting_sessions').doc(currentSessionId).update({
                status: 'completed',
                endTime: Date.now()
            });
        }
        
        isBacktesting = false;
        // Keep currentSessionId for a moment to let polling finish if needed, or null it
        // currentSessionId = null; 
        
        return { success: true };
    } catch (err: any) {
        console.error('[BACKTESTING] Error stopping:', err.message);
        return { success: false, error: err.message };
    }
}

export function getCurrentSessionId() {
    return currentSessionId;
}

export function getCurrentSessionThresholds() {
    return currentSessionThresholds;
}

function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    
    let lastSeenLogs: string[] = [];

    pollingInterval = setInterval(async () => {
        if (!isBacktesting) return;

        try {
            // Get console output (assuming it returns a string with multiple lines)
            // We need to find the indicator name. The user mentioned smc_master_5.1
            const consoleOutput = await executeToolByName('pine_get_console', { study_filter: 'SMC_Master_5.1' });
            
            if (!consoleOutput || consoleOutput.includes('Error')) return;

            const lines = consoleOutput.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            
            for (const line of lines) {
                if (!lastSeenLogs.includes(line)) {
                    console.log(`[BACKTESTING] New log detected: ${line}`);
                    await processTradingAlert(line);
                    lastSeenLogs.push(line);
                }
            }

            // Keep cache reasonable
            if (lastSeenLogs.length > 100) {
                lastSeenLogs = lastSeenLogs.slice(-50);
            }

        } catch (err: any) {
            console.error('[BACKTESTING] Polling error:', err.message);
        }
    }, 2000); // Poll every 2 seconds
}
