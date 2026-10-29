import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import admin from 'firebase-admin';

// Frozen-config, same-event-history regression A/B. Not a tick-fill/PnL proof.
const root = '/opt/JARVIS';
const output = path.join(root, 'logs/rollover_safety');
const snapshot = JSON.parse(fs.readFileSync(path.join(output, 'baseline_snapshot.json'), 'utf8'));
const tickers = ['EURUSD', 'AUDJPY', 'GBPUSD', 'XAUUSD'];
const frozenFile = path.join(output, 'frozen_ab_configs.json');
const triggers = ['choch5m', 'choch15m', 'bos5m', 'bos15m', 'oteChoch5m', 'oteChoch15m', 'oteBos5m', 'oteBos15m'];
function trigger(c: any) {
    if (!c) return { enabled: false, minScore: 8 };
    return { enabled: c.enabled === true, minScore: c.minScore ?? 8, slBuff: c.slBuff, tp2: c.tp2,
        entryPercent: c.entryPercent ?? 62, partialClosePct: c.partialClosePct, slAfterTp1: c.slAfterTp1,
        tp15BeEnabled: c.tp15BeEnabled === true, atrTrailEnabled: c.atrTrailEnabled === true,
        structuralTrailEnabled: c.structuralTrailEnabled === true };
}
if (!fs.existsSync(frozenFile)) {
    const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(path.join(root, 'service-account.json'), 'utf8'))) }, 'rollover-ab-readonly');
    try {
        const configs: Record<string, any> = {};
        for (const ticker of tickers) {
            const document = await app.firestore().collection('asset_configs').doc(ticker).get();
            if (!document.exists) throw new Error(`Missing config for ${ticker}`);
            const raw = document.data()!;
            const sessions: Record<string, any> = {};
            for (const [session, value] of Object.entries(raw.sessions ?? {})) sessions[session] = Object.fromEntries(triggers.map(t => [t, trigger((value as any)?.[t])]));
            configs[ticker] = { ticker, minBuyPoints: raw.minPointsForBuy ?? 4, minSellPoints: raw.minPointsForSell ?? 4,
                oteEntryPercent: raw.oteEntryPercent ?? 50, entryTrigger: raw.entryTrigger ?? 'SMART', sessions,
                sessionFilter: ['LONDON', 'NY', 'ASIA', 'OFF'], minimal_roi: raw.minimal_roi ?? { '0': 0.015, '30': 0.003, '60': 0 } };
        }
        fs.writeFileSync(frozenFile, JSON.stringify({ capturedAt: Date.now(), source: 'asset_configs read-only; same config builder as existing entry A/B', configs }, null, 2));
    } finally { await app.delete(); }
}
const frozen = JSON.parse(fs.readFileSync(frozenFile, 'utf8'));
const modules: Record<string, any> = {};
for (const [variant, dir] of [['before', snapshot.root], ['after', root]]) modules[variant] = await import(pathToFileURL(path.join(dir, 'jarvis-os/src/services/backtestEngine.ts')).href);
const { registerRolloverSchedule } = await import('../src/engine/RolloverSpreadGate.js');
const metrics = (trades: any[]) => {
    let r = 0, peak = 0, dd = 0, won = 0;
    for (const trade of trades) { const value = Number.isFinite(trade.rMultiple) ? trade.rMultiple : 0; r += value; peak = Math.max(peak, r); dd = Math.max(dd, peak - r); won += Number(value > 0); }
    return { trades: trades.length, totalR: Number(r.toFixed(6)), maxDD: Number(dd.toFixed(6)), winRate: trades.length ? Number((100 * won / trades.length).toFixed(4)) : null };
};
const results: any[] = [];
const originalLog = console.log;
try {
    console.log = () => {}; // Preserve compact machine output; do not change engine code.
    for (const ticker of tickers) {
        const evidence = JSON.parse(fs.readFileSync(path.join(output, `2026-10-13_${ticker}_ticks.json`), 'utf8'));
        registerRolloverSchedule(ticker, evidence.symbol);
        const logs = new Map<string, string[]>();
        for (const tf of ['M5', 'M15', 'H1', 'H4', 'D1']) {
            const file = path.join(root, 'logs', ticker.toLowerCase(), 'history_exported', `pine-logs-SMC Master_${tf}.csv`);
            if (fs.existsSync(file)) logs.set(tf, fs.readFileSync(file, 'utf8').split('\n').filter(x => x.trim()));
        }
        if (!logs.size) throw new Error(`No history for ${ticker}`);
        const row: any = { ticker, model: 'precomputed_SMC_events_no_Ask_execution', variants: {} };
        for (const variant of ['before', 'after']) {
            const engine = modules[variant];
            const prepared = await engine.prepareEntries(logs);
            row.eventCount = prepared.length;
            row.firstEvent = prepared[0]?.ts ?? null;
            row.lastEvent = prepared[prepared.length - 1]?.ts ?? null;
            for (const enabled of [false, true]) {
                const config = structuredClone(frozen.configs[ticker]);
                config.rolloverEntryBlock = enabled;
                const result = engine.runBacktest(logs, config, undefined, prepared);
                row.variants[`${variant}_${enabled ? 'calendar_block' : 'no_calendar_block'}`] = metrics(result.trades ?? []);
            }
        }
        results.push(row);
    }
} finally { console.log = originalLog; }
const report = { type: 'frozen_config_code_regression_ab', baselineCommit: snapshot.commit, configCapturedAt: frozen.capturedAt,
    limitation: 'Historical event/candle R only. Does not validate triage, rollover stop fills, spread thaw or new SMC detection. New calendar uses current broker metadata, not historical schedule revisions.', results };
fs.writeFileSync(path.join(output, 'frozen_regression_ab.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
