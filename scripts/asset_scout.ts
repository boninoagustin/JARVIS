// asset_scout.ts — 🔭 Buscador de activos (fase 1 del sábado, sep-2026, aprobado por Bon).
// Para cada candidato del universo (sin cripto — Funding Pips no lo permite; sin los activos
// ya en el loop dominical): descarga velas (6 meses, M5→D1), exporta eventos SMC con preset
// genérico, corre UN backtest del motor real con config sonda y emite veredicto.
// NO opera nada, NO activa nada: escribe reports/asset_scout.json y lo sube a Firestore
// (opt_reports/ASSET_SCOUT) para que el panel muestre el ranking y Bon decida promover.
//
// Uso:
//   npx tsx scripts/asset_scout.ts                       # universo completo (sábado)
//   npx tsx scripts/asset_scout.ts --ticker EURAUD       # un solo candidato
//   npx tsx scripts/asset_scout.ts --limit 5             # primeros N (test)
//   npx tsx scripts/asset_scout.ts --skip-fetch          # usa velas ya descargadas
//   npx tsx scripts/asset_scout.ts --from-days 180       # ventana de historia (default 180)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = '/opt/JARVIS';
// Flags: acepta --x=v y --x v
const argVal = (name: string): string | undefined => {
    const i = process.argv.findIndex(a => a === name || a.startsWith(name + '='));
    if (i === -1) return undefined;
    const a = process.argv[i];
    return a.startsWith(name + '=') ? a.slice(name.length + 1) : process.argv[i + 1];
};
const MONTHS = Number(argVal('--from-days') || 180);
const LIMIT = Number(argVal('--limit') || 0);
const ONLY = (argVal('--ticker') || '').toUpperCase();
const SKIP_FETCH = process.argv.includes('--skip-fetch');

// ─── Universo candidato ─────────────────────────────────────────────────────
// Sin cripto (Funding Pips no lo permite). Sin los 11 ya en el loop dominical.
// symbol = nombre en cTrader (la cuenta usa "US 500", "GERMANY 40", "NAT.GAS", etc.)
const UNIVERSE: Array<{ ticker: string; symbol: string; cat: string }> = [
    // FX crosses (los majors ya están en el loop o se evalúan igual: EURGBP/AUDUSD/USDCHF)
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
    // Metales
    { ticker: 'XAGUSD', symbol: 'XAGUSD', cat: 'METAL' },
    { ticker: 'XPTUSD', symbol: 'XPTUSD', cat: 'METAL' },
    { ticker: 'XPDUSD', symbol: 'XPDUSD', cat: 'METAL' },
    // Energías
    { ticker: 'USOIL', symbol: 'XTIUSD', cat: 'ENERGY' },
    { ticker: 'XBRUSD', symbol: 'XBRUSD', cat: 'ENERGY' },
    { ticker: 'NATGAS', symbol: 'NAT.GAS', cat: 'ENERGY' },
    // Índices
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

async function main() {
    const universe = UNIVERSE.filter(u => !ONLY || u.ticker === ONLY).slice(0, LIMIT || UNIVERSE.length);
    console.log(`🔭 Asset Scout — ${universe.length} candidatos (${MONTHS} días, ventana señales ${WINDOW_DAYS}d)${SKIP_FETCH ? ' [skip-fetch]' : ''}`);

    const ctraderMod = await import('../src/services/ctrader.js');
    if (!SKIP_FETCH) {
        const connected = await ctraderMod.connectCTrader();
        if (!connected) { console.error('❌ No se pudo conectar a cTrader'); process.exit(1); }
        console.log('✅ cTrader conectado (segunda sesión — el bot se reconecta solo si cae)');
    }
    // ⚠️ Acceder ctClient DESPUÉS de connect: connectCTrader re-asigna el export;
    // destructuring previo captura el binding viejo (null).
    const ctClient = ctraderMod.ctClient;

    const { runBacktest, prepareEntries } = await import('../jarvis-os/src/services/backtestEngine');
    const results: any[] = [];

    for (const u of universe) {
        const t0 = Date.now();
        console.log(`\n━━━ ${u.ticker} (${u.cat}) ━━━`);
        try {
            // 1. Descargar velas (6 meses × 5 TFs en chunks de 30 días)
            if (!SKIP_FETCH) {
                await fetchAll(u, ctClient);
            }
            // 2. Exportar eventos SMC (preset genérico — no hay preset optimizado para candidatos)
            console.log(`  [export] export_smc_csv ${u.ticker}...`);
            // ⚠️ stdio inherit: con pipe, el output del export llena el buffer → ENOBUFS
            execSync(`npx tsx scripts/export_smc_csv.ts ${u.ticker}`, { cwd: REPO, stdio: 'inherit', timeout: 600000 });
            // 3. Backtest del motor real con config sonda
            const logs = loadLogs(u.ticker);
            if (!logs.has('M5') && !logs.has('M15')) {
                results.push({ ticker: u.ticker, cat: u.cat, error: 'sin CSVs exportados' });
                continue;
            }
            const prepared = await prepareEntries(logs);
            const cfg = buildProbeConfig(u.ticker);
            const res = runBacktest(logs, cfg, undefined, prepared);
            const all = res.trades || [];
            const cut = (all.length ? Math.max(...all.map(t => (t as any).timestamp).filter((x: any) => Number.isFinite(x))) : Date.now()) - WINDOW_DAYS * 86400000;
            const win = all.filter(t => (t as any).timestamp >= cut);
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

    const out = { generatedAt: new Date().toISOString(), windowDays: WINDOW_DAYS, universe: universe.map(u => u.ticker), results };
    const outDir = path.join(REPO, 'scripts', 'periodic_opt', 'reports');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'asset_scout.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

    // Subir a Firestore (opt_reports/ASSET_SCOUT) — igual que push_reports
    const adminModule = await import('firebase-admin');
    const admin: any = (adminModule as any).default ?? adminModule;
    const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
    const db = admin.firestore();
    await db.collection('opt_reports').doc('ASSET_SCOUT').set(out);
    console.log(`\n✅ → ${outPath} + opt_reports/ASSET_SCOUT (${results.length} resultados)`);

    // 🆕 27-sep-2026 (decisión de Bon): auto-promoción de PASS.
    // PASS (n≥10, PF≥1.3, exp>0) → merge en optimization_config/active_tickers para que
    // el dominical siguiente lo optimice y proponga activarlo. MARGINAL/FAIL/INSUF_DATA
    // quedan manuales (el panel puede promoverlos con ⚡ PROMOVER).
    const passes = results.filter((r: any) => r.verdict === 'PASS').map((r: any) => r.ticker);
    if (passes.length > 0) {
        try {
            const atRef = db.collection('optimization_config').doc('active_tickers');
            const atSnap = await atRef.get();
            const cur: string[] = atSnap.exists && Array.isArray(atSnap.data()?.tickers) ? atSnap.data().tickers : [];
            const merged = [...new Set([...cur, ...passes])];
            await atRef.set({ tickers: merged, updatedAt: new Date().toISOString(), source: 'asset_scout_auto_promo' }, { merge: true });
            console.log(`🚀 Auto-promoción PASS → active_tickers: ${passes.join(', ')} (${merged.length} total)`);
        } catch (e: any) {
            console.error(`⚠️ Auto-promoción falló (no bloquea el reporte): ${String(e?.message || e).slice(0, 150)}`);
        }
    }
    process.exit(0);
}

// ─── Descarga de velas (formato idéntico a fetch_history.ts) ────────────────
async function fetchAll(u: { ticker: string; symbol: string }, ctClient: any) {
    const { TrendbarPeriod } = await import('ctrader-ts');
    const from = Date.now() - MONTHS * 86400000;
    const to = Date.now();
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
            await new Promise(r => setTimeout(r, 200));
        }
        const uniq = new Map<number, any>();
        candles.forEach(c => uniq.set(c.timestamp, c));
        const sorted = Array.from(uniq.values()).sort((a: any, b: any) => a.timestamp - b.timestamp);
        const outDir = path.join(REPO, 'logs', u.ticker.toLowerCase(), 'history');
        fs.mkdirSync(outDir, { recursive: true });
        const csv = ['timestamp,open,high,low,close,volume', ...sorted.map((c: any) => `${c.timestamp},${c.open},${c.high},${c.low},${c.close},${c.volume}`)];
        fs.writeFileSync(path.join(outDir, `history_${tf}.csv`), csv.join('\n'));
        console.log(`  [fetch] ${tf}: ${sorted.length} velas`);
    }
}

function loadLogs(ticker: string): Map<string, string[]> {
    const dir = path.join(REPO, 'logs', ticker.toLowerCase(), 'history_exported');
    const logs = new Map<string, string[]>();
    if (!fs.existsSync(dir)) return logs;
    for (const tf of TFS) {
        const f = path.join(dir, `pine-logs-SMC Master_${tf}.csv`);
        if (!fs.existsSync(f)) continue;
        logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim().length > 0));
    }
    return logs;
}

// Config sonda: todo encendido, minScore 4, gestión defaults (igual que la corrida B del paso 8)
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
        spreadPips: 0,        // → cae en fricción default por clase de activo (FrictionModel)
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

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
