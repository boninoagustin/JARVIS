// bias_gate_ab.ts — A/B: base vs biasGateStrict (bloquear entradas con 4H y 1H en contra).
// Uso: npx tsx scripts/bias_gate_ab.ts [ticker...]
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICKERS = process.argv.length > 2 ? process.argv.slice(2).map(t => t.toUpperCase())
    : ['EURUSD', 'GBPUSD', 'AUDCAD', 'USDJPY', 'NZDUSD', 'XAUUSD', 'JP225', 'GBPJPY', 'AUDJPY', 'GER40'];
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

/**
 * 🛡️ ML-GATE para A/B (sep-2026): gate ML con paridad viva en el backtest.
 * trainedAt=0 → el gate juzga TODO el período (equivalente al vivo, que gatea siempre).
 * Sin modelo de producción para el ticker → undefined (gate OFF, legacy).
 */
function buildMLGateAll(ticker: string): { enabled: boolean; modelPath: string; trainedAt: number } | undefined {
    const modelPath = path.join(process.cwd(), 'scripts', 'hyperopt', 'models', `ml_model_${ticker}.json`);
    if (!fs.existsSync(modelPath)) {
        console.warn(`[ML-GATE] ⚠️ sin modelo para ${ticker} — gate OFF`);
        return undefined;
    }
    console.warn(`[ML-GATE] ✅ gate ON para ${ticker} (${path.basename(modelPath)}, ventana completa)`);
    return { enabled: true, modelPath, trainedAt: 0 };
}

function fmt(name: string, m: any): string {
    return `${name.padEnd(8)} | ${String(m.n).padEnd(5)} | ${String(m.wr).padEnd(4)} | ${String(m.avgR).padEnd(6)} | ${String(m.totalR).padEnd(7)} | ${String(m.maxDD).padEnd(6)} | ${(m.pf === Infinity ? '∞' : String(m.pf)).padEnd(5)} | ${String(m.tp1pct).padEnd(6)} | ${m.big}`;
}

async function runTicker(ticker: string) {
    const snap = await db.collection('asset_configs').doc(ticker).get();
    const fb = snap.exists ? (snap.data() || {}) : {};
    const dir = path.join('/opt/JARVIS', 'logs', ticker.toLowerCase(), 'history_exported');
    const logs = new Map<string, string[]>();
    // 🛡️ sep-2026: cargar los 5 TFs (igual que el hyperopt semanal) — el gate de bias
    // necesita los bias de 4H/1H que solo existen si H1/H4 se procesan.
    for (const tf of ['M5', 'M15', 'H1', 'H4', 'D1']) {
        const f = path.join(dir, `pine-logs-SMC Master_${tf}.csv`);
        if (fs.existsSync(f)) logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim()));
    }
    if (logs.size === 0) { console.log(`${ticker}: sin CSVs`); return; }
    const prepared = await prepareEntries(logs);

    const strict = baseConfig(fb, ticker);
    strict.biasGateStrict = true; // gate 4H+1H AGAINST → bloqueo (A/B previo: neutro)
    const oteOnly = baseConfig(fb, ticker);
    (oteOnly as any).smartOteOnly = true; // experimento: forzar OTE puro (solo referencia A/B)
    const asiaStrict = baseConfig(fb, ticker);
    (asiaStrict as any).smartAsiaStrict = true; // 🆕 sep-2026: en ASIA exigir R:R >= 2.0 (directa)
    const biasFresh = baseConfig(fb, ticker);
    (biasFresh as any).smartBiasFreshGuard = true; // 🆕 sep-2026: bias 4H/1H recién cambiado → OTE
    const baseML = baseConfig(fb, ticker);
    (baseML as any).mlGate = buildMLGateAll(ticker); // 🛡️ sep-2026: gate ML con paridad viva (solo OTE, ventana completa)

    const variants: [string, any][] = [
        ['base', baseConfig(fb, ticker)],
        ['baseML', baseML],
        ['strict', strict],
        ['asiaStrict', asiaStrict],
        ['biasFresh', biasFresh],
        ['oteOnly', oteOnly],
    ];

    console.log(`\n${ticker}`);
    console.log('var      | n     | WR%  | avgR   | totalR  | maxDD | PF    | tp1%   | >1.5R');
    for (const [name, cfg] of variants) {
        const res: any = runBacktest(logs, cfg, undefined, prepared);
        console.log(fmt(name, metrics(res.trades ?? [])));
    }
}

(async () => {
    for (const t of TICKERS) {
        try { await runTicker(t); } catch (e: any) { console.log(`${t}: ERROR ${e.message}`); }
    }
    process.exit(0);
})();
