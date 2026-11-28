// asset_scout.ts — 🔭 Buscador de activos (fase 1 del sábado, sep-2026, aprobado por Bon).
// Para cada candidato del universo (sin cripto — Funding Pips no lo permite; sin los activos
// ya en active_tickers salvo --ticker explícito): descarga velas en un workspace aislado fuera
// de /opt/JARVIS/logs, exporta eventos SMC con --output-dir aislado, corre UN backtest sonda
// y emite veredicto. JAMÁS muta ni trunca /opt/JARVIS/logs/<ticker>/{history,history_exported}
// ni altera active_tickers mientras exista un ciclo semanal inconcluso.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFileSync } from './history_lock.js';

const REPO = '/opt/JARVIS';

const argVal = (name: string, argv = process.argv): string | undefined => {
    const i = argv.findIndex((a) => a === name || a.startsWith(name + '='));
    if (i === -1) return undefined;
    const a = argv[i];
    return a.startsWith(name + '=') ? a.slice(name.length + 1) : argv[i + 1];
};

export const UNIVERSE: Array<{ ticker: string; symbol: string; cat: string }> = [
    { ticker: 'EURGBP', symbol: 'EURGBP', cat: 'FX' },
    { ticker: 'AUDUSD', symbol: 'AUDUSD', cat: 'FX' },
    { ticker: 'USDCHF', symbol: 'USDCHF', cat: 'FX' },
    { ticker: 'EURCHF', symbol: 'EURCHF', cat: 'FX' },
    { ticker: 'CHFJPY', symbol: 'CHFJPY', cat: 'FX' },
    { ticker: 'EURAUD', symbol: 'EURAUD', cat: 'FX' },
    { ticker: 'CADJPY', symbol: 'CADJPY', cat: 'FX' },
    { ticker: 'GBPAUD', symbol: 'GBPAUD', cat: 'FX' },
    { ticker: 'EURCAD', symbol: 'EURCAD', cat: 'FX' },
    { ticker: 'GBPCAD', symbol: 'GBPCAD', cat: 'FX' },
    { ticker: 'AUDCHF', symbol: 'AUDCHF', cat: 'FX' },
    { ticker: 'GBPNZD', symbol: 'GBPNZD', cat: 'FX' },
    { ticker: 'CADCHF', symbol: 'CADCHF', cat: 'FX' },
    { ticker: 'GBPCHF', symbol: 'GBPCHF', cat: 'FX' },
    { ticker: 'NZDCHF', symbol: 'NZDCHF', cat: 'FX' },
    { ticker: 'NZDCAD', symbol: 'NZDCAD', cat: 'FX' },
    { ticker: 'EURNZD', symbol: 'EURNZD', cat: 'FX' },
    { ticker: 'AUDNZD', symbol: 'AUDNZD', cat: 'FX' },
    { ticker: 'NZDJPY', symbol: 'NZDJPY', cat: 'FX' },
    { ticker: 'XAGUSD', symbol: 'XAGUSD', cat: 'METAL' },
    { ticker: 'XPTUSD', symbol: 'XPTUSD', cat: 'METAL' },
    { ticker: 'XPDUSD', symbol: 'XPDUSD', cat: 'METAL' },
    { ticker: 'USOIL', symbol: 'XTIUSD', cat: 'ENERGY' },
    { ticker: 'XBRUSD', symbol: 'XBRUSD', cat: 'ENERGY' },
    { ticker: 'NATGAS', symbol: 'NAT.GAS', cat: 'ENERGY' },
    { ticker: 'US30', symbol: 'US 30', cat: 'INDEX' },
    { ticker: 'USTECH100', symbol: 'US TECH 100', cat: 'INDEX' },
    { ticker: 'FRA40', symbol: 'FRANCE 40', cat: 'INDEX' },
    { ticker: 'UK100', symbol: 'UK 100', cat: 'INDEX' },
    { ticker: 'SPAIN35', symbol: 'SPAIN 35', cat: 'INDEX' },
    { ticker: 'NL25', symbol: 'NETHERLANDS 25', cat: 'INDEX' },
    { ticker: 'ITALY40', symbol: 'ITALY 40', cat: 'INDEX' },
    { ticker: 'EUROPE50', symbol: 'EUROPE 50', cat: 'INDEX' },
    { ticker: 'AUSTRALIA200', symbol: 'AUSTRALIA 200', cat: 'INDEX' },
];

const TFS = ['M5', 'M15', 'H1', 'H4', 'D1'];
const WINDOW_DAYS = 84;

export function selectScoutCandidates(
    universe: typeof UNIVERSE,
    activeTickers: readonly string[],
    onlyTicker = '',
    limit = 0,
) {
    const activeSet = new Set(activeTickers.map((t) => String(t).trim().toUpperCase()));
    const filtered = universe.filter((u) => (onlyTicker ? u.ticker === onlyTicker : !activeSet.has(u.ticker)));
    return limit > 0 ? filtered.slice(0, limit) : filtered;
}

export function canMutateActiveRoster(
    stateDir = process.env.MARK_DIR || '/var/lib/jarvis',
    summaryPath = path.join(REPO, 'scripts/periodic_opt/opt_out/weekly_selection_summary.json'),
    progressPath = path.join(REPO, 'scripts/periodic_opt/opt_out/weekly_progress.json'),
): { ok: boolean; reason: string } {
    const r = spawnSync('python3', [
        path.join(REPO, 'scripts/periodic_opt/weekly_cycle_state.py'),
        'plan',
        '--state-dir', stateDir,
        '--summary', summaryPath,
        '--progress', progressPath,
    ], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) {
        return { ok: false, reason: `weekly_cycle_state inválido: ${(r.stderr || r.stdout || '').trim()}` };
    }
    try {
        const parsed = JSON.parse(r.stdout);
        if (parsed.action === 'new' || parsed.action === 'skip') {
            return { ok: true, reason: `plan=${parsed.action}` };
        }
        return { ok: false, reason: `ciclo semanal inconcluso (plan=${parsed.action})` };
    } catch (e: any) {
        return { ok: false, reason: `respuesta ilegible de weekly_cycle_state: ${e?.message}` };
    }
}

async function main() {
    const MONTHS = Number(argVal('--from-days') || 180);
    const LIMIT = Number(argVal('--limit') || 0);
    const ONLY = (argVal('--ticker') || '').toUpperCase();
    const SKIP_FETCH = process.argv.includes('--skip-fetch');

    const adminModule = await import('firebase-admin');
    const admin: any = (adminModule as any).default ?? adminModule;
    const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
    const db = admin.firestore();

    const atSnap = await db.collection('optimization_config').doc('active_tickers').get();
    const activeTickers: string[] = atSnap.exists && Array.isArray(atSnap.data()?.tickers) ? atSnap.data()!.tickers : [];
    const universe = selectScoutCandidates(UNIVERSE, activeTickers, ONLY, LIMIT);
    console.log(`🔭 Asset Scout — ${universe.length} candidatos nuevos (${activeTickers.length} ya en active_tickers omitidos, ${MONTHS}d, ventana ${WINDOW_DAYS}d)${SKIP_FETCH ? ' [skip-fetch]' : ''}`);

    // Workspace 100% aislado fuera de /opt/JARVIS para jamás tocar logs productivos ni violar assertResearchDestination.
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-asset-scout-'));
    try {
        let ctClient: any = null;
        if (!SKIP_FETCH && universe.length > 0) {
            const ctraderMod = await import('../src/services/ctrader.js');
            const connected = await ctraderMod.connectCTrader();
            if (!connected) { console.error('❌ No se pudo conectar a cTrader'); process.exit(1); }
            console.log('✅ cTrader conectado (workspace aislado)');
            ctClient = (await import('../src/services/ctrader.js')).ctClient ?? ctraderMod.ctClient;
        }

        const { runBacktest, prepareEntries } = await import('../jarvis-os/src/services/backtestEngine.js');
        const results: any[] = [];

        for (const u of universe) {
            const t0 = Date.now();
            console.log(`\n━━━ ${u.ticker} (${u.cat}) ━━━`);
            const rawDir = path.join(workRoot, u.ticker.toLowerCase(), 'history');
            const expDir = path.join(workRoot, u.ticker.toLowerCase(), 'history_exported');
            try {
                if (!SKIP_FETCH) {
                    await fetchAllIsolated(u, ctClient, rawDir, MONTHS);
                } else {
                    const fallbackRaw = path.join(REPO, 'logs', u.ticker.toLowerCase(), 'history');
                    fs.mkdirSync(rawDir, { recursive: true });
                    for (const tf of TFS) {
                        const src = path.join(fallbackRaw, `history_${tf}.csv`);
                        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(rawDir, `history_${tf}.csv`));
                    }
                }
                console.log(`  [export] export_smc_csv ${u.ticker} (isolated)...`);
                execFileSync(`${REPO}/node_modules/.bin/tsx`, [
                    path.join(REPO, 'scripts/export_smc_csv.ts'),
                    u.ticker,
                    '--input-dir', rawDir,
                    '--output-dir', expDir,
                    '--quiet',
                ], { cwd: REPO, stdio: 'inherit', timeout: 600000 });

                const logs = loadLogsFromDir(expDir);
                if (!logs.has('M5') && !logs.has('M15')) {
                    results.push({ ticker: u.ticker, cat: u.cat, error: 'sin CSVs exportados' });
                    continue;
                }
                const prepared = await prepareEntries(logs);
                const cfg = buildProbeConfig(u.ticker);
                const res = runBacktest(logs, cfg, undefined, prepared);
                const all = res.trades || [];
                const cut = (all.length ? Math.max(...all.map((t: any) => t.timestamp).filter((x: any) => Number.isFinite(x))) : Date.now()) - WINDOW_DAYS * 86400000;
                const win = all.filter((t: any) => t.timestamp >= cut);
                const mFull = metrics(all);
                const m84 = metrics(win);
                const verdict = m84.n >= 10 ? (m84.pf >= 1.3 && m84.exp > 0 ? 'PASS' : m84.pf >= 1.1 ? 'MARGINAL' : 'FAIL') : 'INSUF_DATA';
                const row = {
                    ticker: u.ticker, cat: u.cat, symbol: u.symbol,
                    full: mFull, win84: m84, verdict, costSec: Math.round((Date.now() - t0) / 1000),
                };
                results.push(row);
                console.log(`  ${row.ticker}: full n=${mFull.n} net=${mFull.netR.toFixed(1)}R PF=${mFull.pf.toFixed(2)} | 84d n=${m84.n} net=${m84.netR.toFixed(1)}R PF=${m84.pf.toFixed(2)} DD=${m84.maxDD.toFixed(1)}R → ${verdict}`);
            } catch (e: any) {
                results.push({ ticker: u.ticker, cat: u.cat, error: String(e?.message || e).slice(0, 200) });
                console.log(`  ❌ ${u.ticker}: ${String(e?.message || e).slice(0, 160)}`);
            }
        }

        const rosterGate = canMutateActiveRoster();
        const passes = results.filter((r: any) => r.verdict === 'PASS').map((r: any) => r.ticker);
        const out: any = {
            generatedAt: new Date().toISOString(),
            windowDays: WINDOW_DAYS,
            isolatedWorkspace: true,
            skippedAlreadyActive: activeTickers.length,
            universe: universe.map((u) => u.ticker),
            results,
            autoPromoDeferredReason: passes.length > 0 && !rosterGate.ok ? rosterGate.reason : null,
        };
        const outDir = path.join(REPO, 'scripts', 'periodic_opt', 'reports');
        const outPath = path.join(outDir, 'asset_scout.json');
        atomicWriteFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

        await db.collection('opt_reports').doc('ASSET_SCOUT').set(out);
        console.log(`\n✅ → ${outPath} + opt_reports/ASSET_SCOUT (${results.length} resultados)`);

        if (passes.length > 0) {
            if (!rosterGate.ok) {
                console.log(`⏸ Auto-promoción diferida (${rosterGate.reason}): ${passes.join(', ')}`);
            } else {
                try {
                    const atRef = db.collection('optimization_config').doc('active_tickers');
                    const freshSnap = await atRef.get();
                    const cur: string[] = freshSnap.exists && Array.isArray(freshSnap.data()?.tickers) ? freshSnap.data()!.tickers : [];
                    const merged = [...new Set([...cur, ...passes])];
                    await atRef.set({ tickers: merged, updatedAt: new Date().toISOString(), source: 'asset_scout_auto_promo' }, { merge: true });
                    console.log(`🚀 Auto-promoción PASS → active_tickers: ${passes.join(', ')} (${merged.length} total)`);
                } catch (e: any) {
                    console.error(`⚠️ Auto-promoción falló (no bloquea el reporte): ${String(e?.message || e).slice(0, 150)}`);
                }
            }
        }
    } finally {
        fs.rmSync(workRoot, { recursive: true, force: true });
    }
    process.exit(0);
}

async function fetchAllIsolated(u: { ticker: string; symbol: string }, ctClient: any, outDir: string, days: number) {
    const { TrendbarPeriod } = await import('ctrader-ts');
    const from = Date.now() - days * 86400000;
    const to = Date.now();
    fs.mkdirSync(outDir, { recursive: true });
    for (const tf of TFS) {
        const period = (TrendbarPeriod as any)[tf];
        const info = await ctClient.getSymbolInfo(u.symbol);
        if (!info || !info.symbolId) throw new Error(`Símbolo no encontrado: ${u.symbol}`);
        let cur = from;
        const candles: any[] = [];
        const chunkMs = 30 * 86400000;
        while (cur < to) {
            const curTo = Math.min(cur + chunkMs, to);
            const res = await ctClient.raw.market.getTrendbars({ symbolId: info.symbolId, period, fromTimestamp: cur, toTimestamp: curTo });
            if (res && res.trendbars) {
                const divider = 100000;
                for (const tb of res.trendbars) {
                    const lowRaw = tb.low || 0;
                    candles.push({
                        timestamp: (tb.utcTimestampInMinutes || 0) * 60000,
                        open: (lowRaw + (tb.deltaOpen || 0)) / divider,
                        high: (lowRaw + (tb.deltaHigh || 0)) / divider,
                        low: lowRaw / divider,
                        close: (lowRaw + (tb.deltaClose || 0)) / divider,
                        volume: tb.volume || 0,
                    });
                }
            }
            cur = curTo;
            await new Promise((r) => setTimeout(r, 200));
        }
        const uniq = new Map<number, any>();
        candles.forEach((c) => uniq.set(c.timestamp, c));
        const sorted = Array.from(uniq.values()).sort((a: any, b: any) => a.timestamp - b.timestamp);
        if (!sorted.length) throw new Error(`Sin velas descargadas para ${u.ticker} ${tf}`);
        const csv = ['timestamp,open,high,low,close,volume', ...sorted.map((c: any) => `${c.timestamp},${c.open},${c.high},${c.low},${c.close},${c.volume}`)];
        atomicWriteFileSync(path.join(outDir, `history_${tf}.csv`), csv.join('\n') + '\n');
        console.log(`  [fetch-isolated] ${tf}: ${sorted.length} velas`);
    }
}

function loadLogsFromDir(dir: string): Map<string, string[]> {
    const logs = new Map<string, string[]>();
    if (!fs.existsSync(dir)) return logs;
    for (const tf of TFS) {
        const f = path.join(dir, `pine-logs-SMC Master_${tf}.csv`);
        if (!fs.existsSync(f)) continue;
        logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim().length > 0));
    }
    return logs;
}

function buildProbeConfig(ticker: string): any {
    const sessions: any = {};
    for (const s of ['ASIA', 'LONDON', 'NY', 'OFF']) {
        sessions[s] = {};
        for (const t of ['choch5m', 'bos5m', 'choch15m', 'bos15m', 'oteChoch5m', 'oteBos5m', 'oteChoch15m', 'oteBos15m'])
            sessions[s][t] = { enabled: true, minScore: 4 };
    }
    return {
        ticker,
        entryTrigger: 'SMART',
        minBuyPoints: 4,
        minSellPoints: 4,
        slBufferPercent: 0.1,
        fixedRR: 2.0,
        oteEntryPercent: 50,
        spreadPips: 0,
        commissionPerLot: 0,
        sessions,
        enabled: true,
    };
}

function metrics(trades: any[]) {
    const n = trades.length;
    let wins = 0, grossWin = 0, grossLoss = 0, netR = 0, maxDD = 0, dd = 0;
    for (const t of trades) {
        const r = Number(t.rMultiple);
        if (!Number.isFinite(r)) continue;
        netR += r;
        if (r > 0) { wins++; grossWin += r; } else grossLoss += Math.abs(r);
        dd = Math.min(0, dd + r);
        maxDD = Math.min(maxDD, dd);
    }
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
    return { n, wr: n ? +(100 * wins / n).toFixed(1) : 0, netR: +netR.toFixed(2), pf: +pf.toFixed(2), exp: n ? +(netR / n).toFixed(3) : 0, maxDD: +(-maxDD).toFixed(2) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}
