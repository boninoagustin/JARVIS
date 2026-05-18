import { getPresetsForCampaign, getPresetLogs, saveJarvisBestResult, updateCampaignStatus, JarvisBestResult } from '../src/db/campaigns.js';
import { runBacktest } from '../jarvis-os/src/services/backtestEngine.js';

async function metaOptimize(campaignId: string, asset: string, sessionFilter: string) {
    console.log(`[META-OPT] Starting Meta-Optimization for Campaign: ${campaignId}`);
    
    // Update campaign status
    await updateCampaignStatus(campaignId, 'running');

    const presets = await getPresetsForCampaign(campaignId);
    if (presets.length === 0) {
        console.error(`[META-OPT] No presets found for campaign ${campaignId}`);
        await updateCampaignStatus(campaignId, 'failed');
        process.exit(1);
    }

    console.log(`[META-OPT] Found ${presets.length} presets to evaluate.`);

    let overallBestPresetId: string | undefined = undefined;
    let overallBestPnl = -Infinity;

    // Optimization Grid Space
    const slOptions = [0, 0.05, 0.1, 0.2];
    const rrOptions = [1.5, 2.0, 2.5, 3.0, 4.0];
    const oteOptions = [50, 62, 79];
    const scoreOptions = [5, 8, 12, 15, 20];
    const triggerOptions: Array<'CHOCH' | 'OTE' | 'BOTH'> = ['CHOCH', 'OTE', 'BOTH'];

    for (const preset of presets) {
        console.log(`\n---------------------------------------------------`);
        console.log(`[META-OPT] Optimizing Preset: ${preset.id}`);

        // Fetch logs
        const logs = new Map<string, string[]>();
        const tfs = ['3', '15', '60', '240'];
        for (const tf of tfs) {
            console.log(`[META-OPT] Fetching logs for TF ${tf}...`);
            const lines = await getPresetLogs(campaignId, preset.id, tf);
            if (lines.length > 0) {
                logs.set(tf, lines);
                console.log(`[META-OPT] TF ${tf} loaded: ${lines.length} lines`);
            }
        }

        if (logs.size === 0) {
            console.warn(`[META-OPT] Warning: No logs found for preset ${preset.id}. Skipping.`);
            continue;
        }

        let bestPresetPnl = -Infinity;
        let bestPresetResult: JarvisBestResult | null = null;
        let combinationsTested = 0;

        // Grid Search Loop
        for (const sl of slOptions) {
            for (const rr of rrOptions) {
                for (const ote of oteOptions) {
                    for (const score of scoreOptions) {
                        for (const trigger of triggerOptions) {
                            combinationsTested++;
                            
                            const config = {
                                ticker: asset,
                                minBuyPoints: score,
                                minSellPoints: score,
                                slBufferPercent: sl,
                                fixedRR: rr,
                                oteEntryPercent: ote,
                                entryTrigger: trigger
                            };

                            const res = runBacktest(logs, config);

                            // Apply session filter if applicable
                            const filteredTrades = sessionFilter === 'ALL'
                                ? res.trades
                                : res.trades.filter(t => {
                                    // Session filtering logic (Argentina time)
                                    const d = new Date(t.timestamp);
                                    const timeStr = d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false, hour: 'numeric', minute: 'numeric' });
                                    const [hStr, mStr] = timeStr.split(':');
                                    const h = parseInt(hStr);
                                    const m = parseInt(mStr || '0');
                                    const timeDecimal = h + m / 60;
                                    
                                    let session = 'OFF';
                                    if (timeDecimal >= 21 || timeDecimal < 6) session = 'ASIA';
                                    else if (timeDecimal >= 4 && timeDecimal < 13) session = 'LONDON';
                                    else if (timeDecimal >= 10.5 && timeDecimal < 17) session = 'NY';
                                    
                                    return session === sessionFilter;
                                });

                            const closed = filteredTrades.filter(t => t.result && t.result !== 'TIMEOUT');
                            if (closed.length === 0) continue;

                            const pnl = closed.reduce((acc, t) => acc + (t.pnl || 0), 0);
                            
                            if (pnl > bestPresetPnl) {
                                bestPresetPnl = pnl;
                                const wins = closed.filter(t => t.result === 'WIN').length;
                                const winRate = (wins / closed.length) * 100;
                                const rMultipleTotal = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0);
                                
                                bestPresetResult = {
                                    winRate,
                                    rMultipleTotal,
                                    totalTrades: closed.length,
                                    pnl,
                                    jarvisConfig: config
                                };
                            }
                        }
                    }
                }
            }
        }

        console.log(`[META-OPT] Preset ${preset.id} completed. Combinations tested: ${combinationsTested}`);
        if (bestPresetResult) {
            console.log(`[META-OPT] Best Result for ${preset.id}: PNL=${bestPresetResult.pnl.toFixed(2)}% | WR=${bestPresetResult.winRate.toFixed(1)}% | Trades=${bestPresetResult.totalTrades}`);
            await saveJarvisBestResult(campaignId, preset.id, bestPresetResult);

            if (bestPresetPnl > overallBestPnl) {
                overallBestPnl = bestPresetPnl;
                overallBestPresetId = preset.id;
            }
        } else {
            console.log(`[META-OPT] No profitable combinations found for ${preset.id}.`);
        }
    }

    if (overallBestPresetId) {
        console.log(`\n===================================================`);
        console.log(`[META-OPT] ✅ Optimization Complete!`);
        console.log(`[META-OPT] 🏆 Best SMC Preset: ${overallBestPresetId}`);
        console.log(`[META-OPT] 💰 Max PnL Achieved: ${overallBestPnl.toFixed(2)}%`);
        console.log(`===================================================`);
        await updateCampaignStatus(campaignId, 'completed', overallBestPresetId);
    } else {
        console.log(`[META-OPT] ❌ Optimization completed but no profitable presets were found.`);
        await updateCampaignStatus(campaignId, 'completed');
    }
    
    process.exit(0);
}

const args = process.argv.slice(2);
if (args.length < 3) {
    console.log("Usage: npx tsx scripts/meta-optimize.ts <CampaignID> <Asset> <SessionFilter>");
    console.log("Example: npx tsx scripts/meta-optimize.ts EURUSD_NY_Optimization EURUSD NY");
    process.exit(1);
}

const [campaignId, asset, sessionFilter] = args;

metaOptimize(campaignId, asset, sessionFilter).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
