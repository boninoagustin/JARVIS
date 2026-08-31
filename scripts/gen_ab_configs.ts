// gen_ab_configs.ts — genera presets A/B temporales para tickers sin preset hyperopt
// Lee asset_configs de Firestore (config VIVA) y arma {best_config: BacktestConfig}
// con la misma estructura que optimized_preset_<T>_hyperopt.json.
// Uso: npx tsx scripts/gen_ab_configs.ts GBPJPY AUDJPY GER40
import admin from 'firebase-admin';
import fs from 'fs';

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICKERS = (process.argv.length > 2 ? process.argv.slice(2) : ['GBPJPY', 'AUDJPY', 'GER40']).map(t => t.toUpperCase());
const OUT_DIR = 'scripts/timesfm/ab_presets';
const TRIGGERS = ['choch5m', 'choch15m', 'bos5m', 'bos15m', 'oteChoch5m', 'oteChoch15m', 'oteBos5m', 'oteBos15m'];
const SESSIONS = ['LONDON', 'NY', 'ASIA', 'OFF'];

function num(v: any, fb: number): number {
    return Number.isFinite(Number(v)) ? Number(v) : fb;
}

async function main() {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const ticker of TICKERS) {
        const snap = await db.collection('asset_configs').doc(ticker).get();
        if (!snap.exists) { console.log(`⚠️ ${ticker}: sin doc en asset_configs — salteado`); continue; }
        const fb = snap.data() || {};
        const sessions: Record<string, Record<string, unknown>> = {};
        for (const sess of SESSIONS) {
            const sc = (fb.sessions || {})[sess] || {};
            const trigs: Record<string, unknown> = {};
            for (const t of TRIGGERS) {
                const c = sc[t] || {};
                trigs[t] = {
                    enabled: c.enabled !== false && c.enabled !== undefined ? c.enabled : false,
                    minScore: num(c.minScore, 8),
                    slBuff: num(c.slBuff, 0.2),
                    tp2: num(c.tp2, 2),
                    entryPercent: num(c.entryPercent, 50),
                    partialClosePct: num(c.partialClosePct, 0.5),
                    slAfterTp1: c.slAfterTp1 ?? 'midpoint',
                    tp15BeEnabled: c.tp15BeEnabled ?? false,
                    atrTrailEnabled: c.atrTrailEnabled ?? false,
                    structuralTrailEnabled: c.structuralTrailEnabled ?? false,
                    tp1StructuralMinRR: num(c.tp1StructuralMinRR, 1.2),
                };
            }
            sessions[sess] = trigs;
        }
        const best_config: Record<string, unknown> = {
            ticker,
            minBuyPoints: num(fb.minPointsForBuy, 4),
            minSellPoints: num(fb.minPointsForSell, 4),
            minRR: 1.2,
            slBufferPercent: num(fb.slBufferPercent, 0.2),
            fixedRR: num(fb.fixedRR, 2),
            oteEntryPercent: num(fb.oteEntryPercent, 50),
            entryTrigger: fb.entryTrigger ?? 'SMART',
            sessions,
            minimal_roi: fb.minimal_roi ?? { "0": 0.015, "30": 0.005, "60": 0 },
        };
        const preset = {
            study_name: `ab_livecfg_${ticker}`,
            ticker,
            best_config,
        };
        const out = `${OUT_DIR}/optimized_preset_${ticker}_hyperopt.json`;
        fs.writeFileSync(out, JSON.stringify(preset, null, 2));
        console.log(`✅ ${out}`);
    }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
