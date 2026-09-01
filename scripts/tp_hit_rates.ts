// tp_hit_rates.ts — tasas de TP1/TP2/BE/R por ticker sobre backtest con config viva (Firestore)
// Uso: npx tsx scripts/tp_hit_rates.ts
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICKERS = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40'];
const TRIGGERS = ['choch5m', 'choch15m', 'bos5m', 'bos15m', 'oteChoch5m', 'oteChoch15m', 'oteBos5m', 'oteBos15m'];

function buildTrigger(c: any, oteDefault = 62): any {
    if (!c) return { enabled: false, minScore: 8 };
    return {
        enabled: c.enabled === true,
        minScore: Number.isFinite(Number(c.minScore)) ? Number(c.minScore) : 8,
        slBuff: Number.isFinite(Number(c.slBuff)) ? Number(c.slBuff) : undefined,
        tp2: Number.isFinite(Number(c.tp2)) ? Number(c.tp2) : undefined,
        entryPercent: Number.isFinite(Number(c.entryPercent)) ? Number(c.entryPercent) : oteDefault,
        partialClosePct: Number.isFinite(Number(c.partialClosePct)) ? Number(c.partialClosePct) : undefined,
        slAfterTp1: c.slAfterTp1,
        tp15BeEnabled: c.tp15BeEnabled === true,
        atrTrailEnabled: c.atrTrailEnabled === true,
        structuralTrailEnabled: c.structuralTrailEnabled === true,
    };
}

async function main() {
    console.log('ticker   | n     | tp1Hit% | tp2Hit% | tp15% | BE%    | mediaR | WR%    | wins>1.5R');
    let tot = { n: 0, tp1: 0, tp2: 0, tp15: 0, be: 0, wins: 0, big: 0, sumR: 0 };
    for (const ticker of TICKERS) {
        const snap = await db.collection('asset_configs').doc(ticker).get();
        const fb = snap.exists ? (snap.data() || {}) : {};
        const sessions: any = {};
        for (const [sess, sc0] of Object.entries(fb.sessions || {})) {
            const sc: any = sc0 || {};
            const s: any = {};
            for (const t of TRIGGERS) s[t] = buildTrigger(sc[t]);
            sessions[sess] = s;
        }
        const config: any = {
            ticker,
            minBuyPoints: fb.minPointsForBuy ?? 4,
            minSellPoints: fb.minPointsForSell ?? 4,
            oteEntryPercent: fb.oteEntryPercent ?? 50,
            entryTrigger: fb.entryTrigger ?? 'SMART',
            sessions,
            sessionFilter: ['LONDON', 'NY', 'ASIA', 'OFF'],
            minimal_roi: fb.minimal_roi ?? { "0": 0.015, "30": 0.003, "60": 0 },
        };
        const dir = path.join('/opt/JARVIS', 'logs', ticker.toLowerCase(), 'history_exported');
        const logs = new Map<string, string[]>();
        for (const tf of ['M15', 'M5']) {
            const f = path.join(dir, `pine-logs-SMC Master_${tf}.csv`);
            if (fs.existsSync(f)) logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim()));
        }
        if (logs.size === 0) { console.log(`${ticker.padEnd(8)} | sin CSVs`); continue; }
        const prepared = await prepareEntries(logs);
        const res: any = runBacktest(logs, config, undefined, prepared);
        const trades: any[] = res.trades ?? [];
        const n = trades.length;
        const tp1 = trades.filter(t => t.tp1Hit).length;
        const tp2 = trades.filter(t => t.tp2Hit).length;
        const tp15 = trades.filter(t => t.tp1_5Hit).length;
        const be = trades.filter(t => Math.abs(t.rMultiple ?? 0) < 0.02).length;
        const wins = trades.filter(t => (t.rMultiple ?? 0) > 0).length;
        const big = trades.filter(t => (t.rMultiple ?? 0) > 1.5).length;
        const sumR = trades.reduce((a, t) => a + (t.rMultiple ?? 0), 0);
        const pct = (x: number) => n ? (100 * x / n).toFixed(0) : '-';
        console.log(`${ticker.padEnd(8)} | ${String(n).padEnd(5)} | ${pct(tp1).padEnd(7)} | ${pct(tp2).padEnd(7)} | ${pct(tp15).padEnd(5)} | ${pct(be).padEnd(6)} | ${(n ? sumR / n : 0).toFixed(3).padEnd(7)} | ${pct(wins).padEnd(6)} | ${big}`);
        tot.n += n; tot.tp1 += tp1; tot.tp2 += tp2; tot.tp15 += tp15; tot.be += be; tot.wins += wins; tot.big += big; tot.sumR += sumR;
    }
    const pct = (x: number) => tot.n ? (100 * x / tot.n).toFixed(0) : '-';
    console.log('─'.repeat(90));
    console.log(`TOTAL    | ${String(tot.n).padEnd(5)} | ${pct(tot.tp1).padEnd(7)} | ${pct(tot.tp2).padEnd(7)} | ${pct(tot.tp15).padEnd(5)} | ${pct(tot.be).padEnd(6)} | ${(tot.sumR / tot.n).toFixed(3).padEnd(7)} | ${pct(tot.wins).padEnd(6)} | ${tot.big}`);
    process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
