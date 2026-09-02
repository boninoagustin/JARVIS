// only_tf_ab.ts — A/B de temporalidades: base (5m+15m) vs solo-5m vs solo-15m.
// Uso: npx tsx scripts/only_tf_ab.ts [ticker...]
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICKERS = process.argv.length > 2 ? process.argv.slice(2).map(t => t.toUpperCase())
    : ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40'];
const TRIGGERS = ['choch5m', 'choch15m', 'bos5m', 'bos15m', 'oteChoch5m', 'oteChoch15m', 'oteBos5m', 'oteBos15m'];

function buildTrigger(c: any): any {
    if (!c) return { enabled: false, minScore: 8 };
    return {
        enabled: c.enabled === true,
        minScore: Number.isFinite(Number(c.minScore)) ? Number(c.minScore) : 8,
        slBuff: Number.isFinite(Number(c.slBuff)) ? Number(c.slBuff) : undefined,
        tp2: Number.isFinite(Number(c.tp2)) ? Number(c.tp2) : undefined,
        entryPercent: Number.isFinite(Number(c.entryPercent)) ? Number(c.entryPercent) : 62,
        partialClosePct: Number.isFinite(Number(c.partialClosePct)) ? Number(c.partialClosePct) : undefined,
        slAfterTp1: c.slAfterTp1,
        tp15BeEnabled: c.tp15BeEnabled === true,
        atrTrailEnabled: c.atrTrailEnabled === true,
        structuralTrailEnabled: c.structuralTrailEnabled === true,
    };
}

function baseConfig(fb: any, ticker: string): any {
    const sessions: any = {};
    for (const [sess, sc0] of Object.entries(fb.sessions || {})) {
        const sc: any = sc0 || {};
        const s: any = {};
        for (const t of TRIGGERS) s[t] = buildTrigger(sc[t]);
        sessions[sess] = s;
    }
    return {
        ticker,
        minBuyPoints: fb.minPointsForBuy ?? 4,
        minSellPoints: fb.minPointsForSell ?? 4,
        oteEntryPercent: fb.oteEntryPercent ?? 50,
        entryTrigger: fb.entryTrigger ?? 'SMART',
        sessions,
        sessionFilter: ['LONDON', 'NY', 'ASIA', 'OFF'],
        minimal_roi: fb.minimal_roi ?? { "0": 0.015, "30": 0.003, "60": 0 },
    };
}

function tfFilter(cfg: any, keep: '5' | '15'): any {
    const c = JSON.parse(JSON.stringify(cfg));
    for (const sess of Object.values(c.sessions) as any[]) {
        for (const t of TRIGGERS) {
            if (sess[t]) {
                const is5 = t.endsWith('5m');
                sess[t].enabled = keep === '5' ? is5 : !is5;
            }
        }
    }
    return c;
}

function metrics(trades: any[]) {
    let wins = 0, totalR = 0, grossWin = 0, grossLoss = 0, be = 0, big = 0, tp1 = 0;
    let peak = 0, cur = 0, maxDD = 0;
    for (const t of trades) {
        const r = t.rMultiple ?? 0;
        totalR += r; cur += r;
        if (r > 0) { wins++; grossWin += r; if (r > 1.5) big++; }
        else if (r < 0) grossLoss += -r;
        else be++;
        if (cur > peak) peak = cur;
        const dd = peak - cur;
        if (dd > maxDD) maxDD = dd;
        if (t.tp1Hit) tp1++;
    }
    const n = trades.length;
    return {
        n, wr: n ? +(100 * wins / n).toFixed(0) : 0,
        avgR: n ? +(totalR / n).toFixed(3) : 0,
        totalR: +totalR.toFixed(1),
        maxDD: +maxDD.toFixed(1),
        pf: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : Infinity,
        tp1pct: n ? +(100 * tp1 / n).toFixed(0) : 0,
        big,
    };
}

function fmt(name: string, m: any): string {
    return `${name.padEnd(8)} | ${String(m.n).padEnd(5)} | ${String(m.wr).padEnd(4)} | ${String(m.avgR).padEnd(6)} | ${String(m.totalR).padEnd(7)} | ${String(m.maxDD).padEnd(6)} | ${(m.pf === Infinity ? '∞' : String(m.pf)).padEnd(5)} | ${String(m.tp1pct).padEnd(6)} | ${m.big}`;
}

async function runTicker(ticker: string) {
    const snap = await db.collection('asset_configs').doc(ticker).get();
    const fb = snap.exists ? (snap.data() || {}) : {};
    const dir = path.join('/opt/JARVIS', 'logs', ticker.toLowerCase(), 'history_exported');
    const logs = new Map<string, string[]>();
    for (const tf of ['M15', 'M5']) {
        const f = path.join(dir, `pine-logs-SMC Master_${tf}.csv`);
        if (fs.existsSync(f)) logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim()));
    }
    if (logs.size === 0) { console.log(`${ticker}: sin CSVs`); return; }
    const prepared = await prepareEntries(logs);

    const variants: [string, any][] = [
        ['base', baseConfig(fb, ticker)],
        ['solo5m', tfFilter(baseConfig(fb, ticker), '5')],
        ['solo15m', tfFilter(baseConfig(fb, ticker), '15')],
    ];

    console.log(`\n${ticker}`);
    console.log('var      | n     | WR%  | avgR   | totalR  | maxDD | PF    | tp1%   | >1.5R');
    for (const [name, cfg] of variants) {
        const res: any = runBacktest(logs, cfg, undefined, prepared);
        console.log(fmt(name, metrics(res.trades ?? [])));
    }
}

async function main() {
    for (const t of TICKERS) await runTicker(t);
    console.log('\nDONE');
    process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
