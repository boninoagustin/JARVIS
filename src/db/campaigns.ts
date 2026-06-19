import { db } from './memory.js';

export interface SMCParameters {
    [key: string]: any;
}

export interface JarvisBestResult {
    winRate: number;
    rMultipleTotal: number;
    totalTrades: number;
    pnl: number;
    jarvisConfig: {
        slBufferPercent: number;
        fixedRR: number;
        oteEntryPercent: number;
        entryTrigger: 'CHOCH' | 'OTE' | 'BOTH';
        minBuyPoints: number;
        minSellPoints: number;
    };
}

export interface SMCPresetConfig {
    id: string; // e.g. "Preset_A"
    parameters: SMCParameters;
    logsUploaded: boolean;
    jarvisBestResult?: JarvisBestResult;
    updatedAt: number;
}

export interface BacktestCampaign {
    id: string; // e.g. "EURUSD_NY_Optimization"
    asset: string; // "EURUSD"
    session: string; // "NY"
    createdAt: number;
    status: 'pending' | 'running' | 'completed' | 'failed';
    bestPresetId?: string;
}

/**
 * Creates a new Meta-Optimization Campaign.
 */
export async function createCampaign(campaign: BacktestCampaign): Promise<void> {
    if (!db) throw new Error("Database not initialized");
    await db.collection('backtest_campaigns').doc(campaign.id).set(campaign);
}

/**
 * Adds or updates a Preset Configuration within a Campaign.
 */
export async function setPreset(campaignId: string, preset: SMCPresetConfig): Promise<void> {
    if (!db) throw new Error("Database not initialized");
    await db.collection('backtest_campaigns').doc(campaignId)
        .collection('smc_configs').doc(preset.id).set(preset);
}

/**
 * Fetches all active/past Campaigns.
 */
export async function getCampaigns(): Promise<BacktestCampaign[]> {
    if (!db) throw new Error("Database not initialized");
    const snap = await db.collection('backtest_campaigns').orderBy('createdAt', 'desc').get();
    const campaigns: BacktestCampaign[] = [];
    snap.forEach((doc: any) => campaigns.push(doc.data() as BacktestCampaign));
    return campaigns;
}

/**
 * Fetches all Presets for a given Campaign.
 */
export async function getPresetsForCampaign(campaignId: string): Promise<SMCPresetConfig[]> {
    if (!db) throw new Error("Database not initialized");
    const snap = await db.collection('backtest_campaigns').doc(campaignId)
        .collection('smc_configs').orderBy('updatedAt', 'desc').get();
    const presets: SMCPresetConfig[] = [];
    snap.forEach((doc: any) => presets.push(doc.data() as SMCPresetConfig));
    return presets;
}

/**
 * Updates a preset with the best JARVIS execution result.
 */
export async function saveJarvisBestResult(campaignId: string, presetId: string, result: JarvisBestResult): Promise<void> {
    if (!db) throw new Error("Database not initialized");
    await db.collection('backtest_campaigns').doc(campaignId)
        .collection('smc_configs').doc(presetId).update({
            jarvisBestResult: result,
            updatedAt: Date.now()
        });
}

/**
 * Updates the overall status of the Campaign.
 */
export async function updateCampaignStatus(campaignId: string, status: BacktestCampaign['status'], bestPresetId?: string): Promise<void> {
    if (!db) throw new Error("Database not initialized");
    const updateData: any = { status };
    if (bestPresetId) updateData.bestPresetId = bestPresetId;
    await db.collection('backtest_campaigns').doc(campaignId).update(updateData);
}

/**
 * Uploads chunked logs to Firestore for a specific preset
 */
export async function uploadPresetLogs(campaignId: string, presetId: string, tf: string, lines: string[]): Promise<void> {
    if (!db) throw new Error("Database not initialized");
    const docRef = db.collection('backtest_campaign_logs').doc(`${campaignId}_${presetId}_${tf}`);
    
    // Chunking to avoid Firestore document limits (1MB max, but we chunk at 2000 lines approx)
    const chunkSize = 2000;
    const totalChunks = Math.ceil(lines.length / chunkSize);
    let totalBytes = 0;
    
    for (const line of lines) {
        totalBytes += new TextEncoder().encode(line).length;
    }

    await docRef.set({
        campaignId,
        presetId,
        tf,
        chunked: true,
        totalChunks,
        totalBytes,
        uploadedAt: Date.now()
    });

    for (let i = 0; i < totalChunks; i++) {
        const chunkLines = lines.slice(i * chunkSize, (i + 1) * chunkSize);
        await docRef.collection('chunks').doc(`chunk_${i}`).set({
            index: i,
            lines: chunkLines
        });
    }
}

/**
 * Retrieves the logs for a given preset
 */
export async function getPresetLogs(campaignId: string, presetId: string, tf: string): Promise<string[]> {
    if (!db) throw new Error("Database not initialized");
    const docSnap = await db.collection('backtest_campaign_logs').doc(`${campaignId}_${presetId}_${tf}`).get();
    
    if (!docSnap.exists) return [];
    
    const chunksSnap = await db.collection('backtest_campaign_logs').doc(`${campaignId}_${presetId}_${tf}`)
        .collection('chunks').orderBy('index', 'asc').get();
        
    const allLines: string[] = [];
    chunksSnap.forEach((chunkDoc: any) => {
        const chunk = chunkDoc.data();
        if (chunk && Array.isArray(chunk.lines)) {
            allLines.push(...chunk.lines);
        }
    });
    
    return allLines;
}
