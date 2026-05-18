import * as fs from 'fs';
import * as path from 'path';
import { createCampaign, setPreset, uploadPresetLogs, BacktestCampaign, SMCPresetConfig } from '../src/db/campaigns.js';

// Helper to determine TF from filename
function getTfFromFilename(filename: string): string | null {
    const name = filename.toLowerCase();
    if (name.includes('3m') || name.includes('3')) return '3';
    if (name.includes('15m') || name.includes('15')) return '15';
    if (name.includes('1h') || name.includes('60')) return '60';
    if (name.includes('4h') || name.includes('240')) return '240';
    return null; // Ignore unknown files
}

async function uploadCampaign(campaignId: string, asset: string, session: string, basePath: string) {
    if (!fs.existsSync(basePath)) {
        console.error(`Error: Directory ${basePath} does not exist.`);
        process.exit(1);
    }

    const campaign: BacktestCampaign = {
        id: campaignId,
        asset,
        session,
        createdAt: Date.now(),
        status: 'pending'
    };

    console.log(`[UPLOAD] Creating Campaign: ${campaignId} (${asset} - ${session})`);
    await createCampaign(campaign);

    const presets = fs.readdirSync(basePath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    if (presets.length === 0) {
        console.error(`[UPLOAD] No preset directories found in ${basePath}.`);
        process.exit(1);
    }

    for (const presetName of presets) {
        console.log(`\n[UPLOAD] Processing Preset: ${presetName}`);
        
        const presetConfig: SMCPresetConfig = {
            id: presetName,
            parameters: {}, // You could optionally read a config.json here if you have one
            logsUploaded: true,
            updatedAt: Date.now()
        };

        await setPreset(campaignId, presetConfig);

        const presetPath = path.join(basePath, presetName);
        const files = fs.readdirSync(presetPath).filter(f => f.endsWith('.csv'));

        if (files.length === 0) {
            console.warn(`[UPLOAD] No CSV logs found in ${presetPath}`);
            continue;
        }

        for (const file of files) {
            const tf = getTfFromFilename(file);
            if (!tf) {
                console.warn(`[UPLOAD] Skipping unknown file format: ${file}`);
                continue;
            }

            const filePath = path.join(presetPath, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            console.log(`[UPLOAD] Uploading ${lines.length} lines for ${presetName} - TF ${tf}`);
            await uploadPresetLogs(campaignId, presetName, tf, lines);
        }
        console.log(`[UPLOAD] Preset ${presetName} successfully uploaded.`);
    }

    console.log(`\n[UPLOAD] ✅ Campaign ${campaignId} upload complete!`);
    process.exit(0);
}

// Simple CLI arguments handler
const args = process.argv.slice(2);
if (args.length < 4) {
    console.log("Usage: npx tsx scripts/upload-campaign.ts <CampaignID> <Asset> <Session> <DirectoryPath>");
    console.log("Example: npx tsx scripts/upload-campaign.ts EURUSD_NY_Optimization EURUSD NY ./backtesting_data/EURUSD");
    process.exit(1);
}

const [campaignId, asset, session, basePath] = args;

uploadCampaign(campaignId, asset, session, basePath).catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
