const admin = require('firebase-admin');
const fs = require('fs');
const { z } = require('zod');

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const SessionSchema = z.object({
    choch5m: z.object({ enabled: z.boolean(), minScore: z.number() }).optional(),
    choch15m: z.object({ enabled: z.boolean(), minScore: z.number() }).optional(),
    bos5m: z.object({ enabled: z.boolean(), minScore: z.number() }).optional(),
    bos15m: z.object({ enabled: z.boolean(), minScore: z.number() }).optional(),
    oteChoch5m: z.object({ enabled: z.boolean(), minScore: z.number(), entryPercent: z.number().optional() }).optional(),
    oteChoch15m: z.object({ enabled: z.boolean(), minScore: z.number(), entryPercent: z.number().optional() }).optional(),
    oteBos5m: z.object({ enabled: z.boolean(), minScore: z.number(), entryPercent: z.number().optional() }).optional(),
    oteBos15m: z.object({ enabled: z.boolean(), minScore: z.number(), entryPercent: z.number().optional() }).optional(),
    maxSellLosses: z.number().optional(),
    maxBuyLosses: z.number().optional(),
});

const AssetSessionConfigSchema = z.object({
    minPointsForBuy: z.coerce.number().optional(),
    minPointsForSell: z.coerce.number().optional(),
    slBufferPercent: z.coerce.number().optional(),
    fixedRR: z.coerce.number().optional(),
    oteEntryPercent: z.coerce.number().optional(),
    entryTrigger: z.enum(['CHOCH', 'OTE', 'BOTH', 'SMART']).optional(),
    enabled: z.boolean().optional(),
    maxSellsPerDay: z.coerce.number().optional(),
    sellScorePenalty: z.coerce.number().optional(),
    maxBuysPerDay: z.coerce.number().optional(),
    buyScorePenalty: z.coerce.number().optional(),
    sessions: z.record(z.string(), SessionSchema).optional()
}).passthrough();

async function test() {
    const tickers = ['BTCUSD', 'EURUSD', 'XAUUSD'];
    for (const t of tickers) {
        const doc = await db.collection('asset_configs').doc(t).get();
        const parsed = AssetSessionConfigSchema.safeParse(doc.data());
        console.log(`${t} parsed success: ${parsed.success}`);
        if (!parsed.success) {
            console.log(parsed.error);
        }
    }
    process.exit(0);
}
test();
