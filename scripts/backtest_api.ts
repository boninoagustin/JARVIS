/**
 * backtest_api.ts — Motor de backtesting server-side para Kronos.
 *
 * Modos:
 *   npx tsx scripts/backtest_api.ts <ticker> <tfs> [config_json]          → simular
 *   npx tsx scripts/backtest_api.ts <ticker> <tfs> [config_json] --optimize → GA auto-tune
 *
 * Cachea CSVs en memoria. Thread-safe (un request a la vez, rate-limit en Kronos).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.join(__dirname, '..', 'logs');

// ── Tipos ────────────────────────────────────────────────────────────────────
interface KlineEvent { timestamp: number; open: number; high: number; low: number; close: number; volume: number; }
interface SmeEvent { ts: number; type: string; direction: 'BUY' | 'SELL'; points: number; tf: string; }
interface TradeResult {
    entryTs: number; exitTs: number; direction: string; entryPrice: number; exitPrice: number;
    slHit: boolean; tp1Hit: boolean; tp2Hit: boolean; rMultiple: number; bars: number;
    maxFavorable: number; maxAdverse: number; setup: string;
}
interface SimConfig {
    minBuyPoints: number; minSellPoints: number; slBuffer: number; fixedRR: number;
    entryTrigger: string; partialClosePct: number; slAfterTp1: string;
    tp15BeEnabled: boolean; atrTrailEnabled: boolean; structuralTrailEnabled: boolean;
    spreadPips: number; minRR: number;
}
interface TriggerGenome {
    enabled: boolean; minScore: number; slBuff: number; tp2: number;
    partialClosePct: number; slAfterTp1: string; tp15BeEnabled: boolean;
    atrTrailEnabled: boolean; structuralTrailEnabled: boolean;
    entryPercent: number; minimal_roi: Record<string, number>;
}

// ── CSV Cache ────────────────────────────────────────────────────────────────
const csvCache = new Map<string, { candles: KlineEvent[]; events: SmeEvent[] }>();

function loadFromCache(ticker: string, tfs: string[]): { candles: KlineEvent[]; events: SmeEvent[] } {
    const key = `${ticker}:${tfs.sort().join(',')}`;
    if (csvCache.has(key)) return csvCache.get(key)!;

    const tickerDir = path.join(LOGS_DIR, ticker.toLowerCase(), 'history_exported');
    if (!fs.existsSync(tickerDir)) throw new Error(`No existe: ${tickerDir}`);

    let allCandles: (KlineEvent & { sourceTf: string })[] = [];
    const allEvents: SmeEvent[] = [];

    for (const tf of tfs) {
        const csvFile = path.join(tickerDir, `pine-logs-SMC Master_${tf}.csv`);
        if (!fs.existsSync(csvFile)) throw new Error(`No existe: ${csvFile}`);
        const raw = fs.readFileSync(csvFile, 'utf8');
        const rows: any[] = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true });

        // Parsear velas y eventos
        let currentCandle: Partial<KlineEvent> = {};
        for (const row of rows) {
            const msg: string = row.Mensaje || '';

            // HEARTBEAT / PING_PRICE → datos de vela
            const pr = msg.match(/Precio:\s*([\d.]+)/);
            const hi = msg.match(/High:\s*([\d.]+)/);
            const lo = msg.match(/Low:\s*([\d.]+)/);
            const tsMatch = msg.match(/TS:\s*(\d+)/);

            if (pr && hi && lo && tsMatch && (msg.startsWith('HEARTBEAT') || msg.startsWith('PING_PRICE'))) {
                const ts = parseInt(tsMatch[1]);
                if (currentCandle.timestamp && currentCandle.timestamp !== ts) {
                    allCandles.push({ ...currentCandle as KlineEvent, sourceTf: tf });
                    currentCandle = {};
                }
                if (!currentCandle.timestamp) {
                    currentCandle = { timestamp: ts, open: parseFloat(pr[1]), high: parseFloat(hi[1]), low: parseFloat(lo[1]), close: parseFloat(pr[1]), volume: 0 };
                } else {
                    currentCandle.high = Math.max(currentCandle.high!, parseFloat(hi[1]));
                    currentCandle.low = Math.min(currentCandle.low!, parseFloat(lo[1]));
                    currentCandle.close = parseFloat(pr[1]);
                }
            }

            // Eventos — cada línea de evento tiene su propio TS
            if (tsMatch) {
                const ts = parseInt(tsMatch[1]);
                if (msg.startsWith('EVENTO_CHOCH')) {
                    const dirMatch = msg.match(/Dir:\s*(BUY|SELL)/);
                    const dir = (dirMatch ? dirMatch[1] : 'BUY') as 'BUY' | 'SELL';
                    allEvents.push({ ts, type: 'CHOCH', direction: dir, points: 4, tf });
                } else if (msg.startsWith('EVENTO_BOS')) {
                    const dirMatch = msg.match(/Dir:\s*(BUY|SELL)/);
                    const dir = (dirMatch ? dirMatch[1] : 'BUY') as 'BUY' | 'SELL';
                    allEvents.push({ ts, type: 'BOS', direction: dir, points: 3, tf });
                }
            }
        }
        if (currentCandle.timestamp) allCandles.push({ ...currentCandle as KlineEvent, sourceTf: tf });
    }

    // Unificar velas por timestamp
    const candleMap = new Map<number, KlineEvent>();
    for (const c of allCandles) {
        const ex = candleMap.get(c.timestamp);
        if (!ex || c.sourceTf === 'M5' || c.sourceTf === 'M15') {
            candleMap.set(c.timestamp, { timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
        }
    }
    const candles = Array.from(candleMap.values()).sort((a, b) => a.timestamp - b.timestamp);

    return { candles, events: allEvents };
}

// ── Simulador ────────────────────────────────────────────────────────────────
function simulate(candles: KlineEvent[], events: SmeEvent[], config: SimConfig): { trades: TradeResult[]; equity: number[] } {
    const trades: TradeResult[] = [];
    const equity: number[] = [1000];

    if (events.length === 0) return { trades, equity };
    const openTrades: any[] = [];
    let balance = 1000;
    const riskPerTrade = 0.01;

    // Ordenar eventos cronológicamente
    events.sort((a, b) => a.ts - b.ts);
    let eventIdx = 0;

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const nextTs = i + 1 < candles.length ? candles[i + 1].timestamp : c.timestamp + 300000;

        // Procesar eventos que ocurren en esta vela (entre ts de esta vela y la siguiente)
        while (eventIdx < events.length && events[eventIdx].ts < nextTs) {
            const ev = events[eventIdx];
            eventIdx++;
            const dir = ev.direction;
            const minPts = dir === 'BUY' ? config.minBuyPoints : config.minSellPoints;
            if (ev.points < minPts) continue;

            const entry = c.close;
            const atr = (c.high - c.low) * (1 + config.slBuffer);
            const sl = dir === 'BUY' ? entry - atr : entry + atr;
            const risk = Math.abs(entry - sl);
            if (risk <= 0) continue;

            const tp2 = dir === 'BUY' ? entry + risk * config.fixedRR : entry - risk * config.fixedRR;
            const tp1 = dir === 'BUY' ? entry + risk * 1.0 : entry - risk * 1.0;
            const quantity = (balance * riskPerTrade) / risk;
            if (quantity <= 0 || !isFinite(quantity)) continue;

            openTrades.push({
                dir, entry, sl, tp1, tp2, quantity,
                entryTs: c.timestamp, bars: 0, maxFav: 0, maxAdv: 0,
                tp1Hit: false, slMoved: false, partialDone: false,
                partialPct: config.partialClosePct, slAfterTp1: config.slAfterTp1,
                tp15Be: config.tp15BeEnabled, atrTrail: config.atrTrailEnabled,
                setup: `${ev.type}_${ev.tf}`
            });
        }

        // Gestionar trades abiertos
        for (let t = openTrades.length - 1; t >= 0; t--) {
            const tr = openTrades[t];
            tr.bars++;
            const riskAmt = Math.abs(tr.entry - tr.sl);

            // Max favorable/adverse
            const fav = tr.dir === 'BUY' ? (c.high - tr.entry) / riskAmt : (tr.entry - c.low) / riskAmt;
            const adv = tr.dir === 'BUY' ? (tr.entry - c.low) / riskAmt : (c.high - tr.entry) / riskAmt;
            tr.maxFav = Math.max(tr.maxFav, fav);
            tr.maxAdv = Math.max(tr.maxAdv, adv);

            // TP1
            const tp1Hit = tr.dir === 'BUY' ? c.high >= tr.tp1 : c.low <= tr.tp1;
            if (tp1Hit && !tr.tp1Hit) {
                tr.tp1Hit = true;
                if (!tr.partialDone && tr.partialPct > 0) {
                    balance += tr.quantity * tr.partialPct * Math.abs(tr.tp1 - tr.entry);
                    tr.quantity *= (1 - tr.partialPct);
                    tr.partialDone = true;
                }
                if (tr.slAfterTp1 === 'breakeven') { tr.sl = tr.entry; tr.slMoved = true; }
                else if (tr.slAfterTp1 === 'midpoint') { tr.sl = (tr.entry + tr.tp1) / 2; tr.slMoved = true; }
                if (tr.tp15Be) { tr.sl = tr.entry; tr.slMoved = true; }
            }

            const slHit = tr.dir === 'BUY' ? c.low <= tr.sl : c.high >= tr.sl;
            const tp2Hit = tr.dir === 'BUY' ? c.high >= tr.tp2 : c.low <= tr.tp2;

            if (slHit || tp2Hit) {
                const exitPrice = slHit ? tr.sl : tr.tp2;
                const pnl = tr.quantity * Math.abs(exitPrice - tr.entry) * (slHit && !tr.tp1Hit ? -1 : 1);
                balance += pnl;

                let rMult: number;
                if (slHit && !tr.tp1Hit) rMult = -1;
                else if (slHit && tr.tp1Hit) rMult = tr.partialPct * 1 + (1 - tr.partialPct) * -1;
                else rMult = config.fixedRR;

                trades.push({
                    entryTs: tr.entryTs, exitTs: c.timestamp,
                    direction: tr.dir, entryPrice: tr.entry, exitPrice,
                    slHit, tp1Hit: tr.tp1Hit, tp2Hit,
                    rMultiple: Math.round(rMult * 1000) / 1000,
                    bars: tr.bars,
                    maxFavorable: Math.round(tr.maxFav * 100) / 100,
                    maxAdverse: Math.round(tr.maxAdv * 100) / 100,
                    setup: tr.setup
                });
                openTrades.splice(t, 1);
            }
        }

        equity.push(balance + openTrades.reduce((s, tr) => {
            const ur = tr.dir === 'BUY' ? tr.quantity * Math.max(0, c.close - tr.entry) : tr.quantity * Math.max(0, tr.entry - c.close);
            return s + ur;
        }, 0));
    }

    return { trades, equity };
}

// ── Métricas ─────────────────────────────────────────────────────────────────
function computeMetrics(trades: TradeResult[], equity: number[]) {
    const wins = trades.filter(t => t.rMultiple > 0).length;
    const losses = trades.filter(t => t.rMultiple <= 0).length;
    const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
    const avgR = trades.length > 0 ? totalR / trades.length : 0;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    const maxDD = computeMaxDrawdown(equity);
    const sharpe = computeSharpe(equity);
    const grossProfit = trades.filter(t => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
    const grossLoss = Math.abs(trades.filter(t => t.rMultiple <= 0).reduce((s, t) => s + t.rMultiple, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (trades.length > 0 ? Infinity : 0);

    return {
        totalTrades: trades.length, wins, losses,
        winRate: Math.round(winRate * 10) / 10,
        totalR: Math.round(totalR * 100) / 100,
        avgR: Math.round(avgR * 100) / 100,
        profitFactor: Math.round(profitFactor * 100) / 100,
        maxDrawdownPct: Math.round(maxDD * 100) / 100,
        sharpe: Math.round(sharpe * 100) / 100,
    };
}

// ── GA Optimizer ─────────────────────────────────────────────────────────────
function geneticOptimize(
    candles: KlineEvent[], events: SmeEvent[],
    baseConfig: SimConfig,
    populationSize = 50, generations = 12
): { best: SimConfig; fitness: number } {
    // Genoma: [minScore, slBuff, tp2, partialClosePct]
    const bounds = [
        [3, 9],        // minScore
        [0.0005, 0.008], // slBuff
        [1.0, 3.0],    // tp2 (fixedRR override)
        [0.2, 0.8],    // partialClosePct
    ];

    const randomGenome = () => bounds.map(([lo, hi]) => lo + Math.random() * (hi - lo));
    const toConfig = (g: number[]): SimConfig => ({
        ...baseConfig,
        minBuyPoints: Math.round(g[0]), minSellPoints: Math.round(g[0]),
        slBuffer: g[1], fixedRR: Math.round(g[2] * 10) / 10, partialClosePct: Math.round(g[3] * 10) / 10,
    });

    let population = Array.from({ length: populationSize }, () => randomGenome());

    for (let gen = 0; gen < generations; gen++) {
        // Evaluar
        const scored = population.map(g => {
            const cfg = toConfig(g);
            const { trades } = simulate(candles, events, cfg);
            if (trades.length < 5) return { genome: g, fitness: -Infinity };
            const m = computeMetrics(trades, []);
            // Fitness = avgR × winRate × sqrt(trades) penalizado si muy pocos trades
            return { genome: g, fitness: m.avgR * (m.winRate / 100) * Math.sqrt(Math.min(trades.length, 50)) };
        });

        scored.sort((a, b) => b.fitness - a.fitness);
        const elites = scored.slice(0, Math.floor(populationSize * 0.2));

        // Nueva generación
        const newPop = elites.map(e => e.genome);
        while (newPop.length < populationSize) {
            const a = elites[Math.floor(Math.random() * elites.length)].genome;
            const b = elites[Math.floor(Math.random() * elites.length)].genome;
            const child = a.map((v, i) => {
                const x = Math.random() < 0.5 ? v : b[i];
                // Mutación: 10% de probabilidad, ±10% del rango
                if (Math.random() < 0.1) {
                    const rng = bounds[i][1] - bounds[i][0];
                    return Math.max(bounds[i][0], Math.min(bounds[i][1], x + (Math.random() - 0.5) * rng * 0.2));
                }
                return x;
            });
            newPop.push(child);
        }
        population = newPop;
    }

    const best = toConfig(population[0]);
    const { trades } = simulate(candles, events, best);
    const m = computeMetrics(trades, []);
    const fitness = m.avgR * (m.winRate / 100) * Math.sqrt(Math.min(trades.length, 50));

    return { best, fitness };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function computeMaxDrawdown(equity: number[]): number {
    let peak = equity[0], maxDD = 0;
    for (const v of equity) { if (v > peak) peak = v; const dd = (peak - v) / peak; if (dd > maxDD) maxDD = dd; }
    return maxDD;
}

function computeSharpe(equity: number[]): number {
    if (equity.length < 2) return 0;
    const rets = equity.slice(1).map((v, i) => (v - equity[i]) / equity[i]);
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
    return variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252 * 78) : 0;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log(JSON.stringify({ error: 'Uso: backtest_api.ts <ticker> <tfs> [config_json] [--optimize]' }));
        process.exit(0);
    }

    const ticker = args[0].toUpperCase();
    const tfs = args[1].split(',');
    const isOptimize = args.includes('--optimize');
    const configJson = args.find(a => a.startsWith('{'));
    const defaultConfig: SimConfig = {
        minBuyPoints: 5, minSellPoints: 5, slBuffer: 0.0015, fixedRR: 1.5,
        entryTrigger: 'SMART', partialClosePct: 0.5, slAfterTp1: 'midpoint',
        tp15BeEnabled: true, atrTrailEnabled: true, structuralTrailEnabled: false,
        spreadPips: 1.5, minRR: 0.75
    };
    const config: SimConfig = configJson
        ? { ...defaultConfig, ...JSON.parse(configJson) }
        : defaultConfig;

    const startTs = Date.now();
    const { candles, events } = loadFromCache(ticker, tfs);
    const loadMs = Date.now() - startTs;

    let result: any;

    if (isOptimize) {
        const optStart = Date.now();
        const { best, fitness } = geneticOptimize(candles, events, config);
        const optMs = Date.now() - optStart;
        const { trades, equity } = simulate(candles, events, best);
        const metrics = computeMetrics(trades, equity);

        result = {
            ticker, timeframes: tfs, mode: 'optimize',
            timings: { loadMs, optimizeMs: optMs, totalMs: loadMs + optMs },
            candles: candles.length, events: events.length,
            optimized: {
                minBuyPoints: best.minBuyPoints, minSellPoints: best.minSellPoints,
                slBuffer: best.slBuffer, fixedRR: best.fixedRR,
                partialClosePct: best.partialClosePct, fitness: Math.round(fitness * 100) / 100
            },
            metrics,
            equity: equity.filter((_, i) => i % Math.max(1, Math.floor(equity.length / 500)) === 0),
            trades: trades.slice(-100).map(t => ({
                id: `bt_${t.entryTs}`, ticker, direction: t.direction,
                entryTs: new Date(t.entryTs).toISOString(), exitTs: new Date(t.exitTs).toISOString(),
                entryPrice: t.entryPrice, exitPrice: t.exitPrice,
                result: t.rMultiple > 0 ? 'WIN' : 'LOSS',
                rMultiple: t.rMultiple, bars: t.bars, setup: t.setup
            }))
        };
    } else {
        const simStart = Date.now();
        const { trades, equity } = simulate(candles, events, config);
        const simMs = Date.now() - simStart;
        const metrics = computeMetrics(trades, equity);

        result = {
            ticker, timeframes: tfs, mode: 'simulate',
            timings: { loadMs, simulateMs: simMs, totalMs: loadMs + simMs },
            candles: candles.length, events: events.length,
            config,
            metrics,
            equity: equity.filter((_, i) => i % Math.max(1, Math.floor(equity.length / 500)) === 0),
            trades: trades.slice(-100).map(t => ({
                id: `bt_${t.entryTs}`, ticker, direction: t.direction,
                entryTs: new Date(t.entryTs).toISOString(), exitTs: new Date(t.exitTs).toISOString(),
                entryPrice: t.entryPrice, exitPrice: t.exitPrice,
                result: t.rMultiple > 0 ? 'WIN' : 'LOSS',
                rMultiple: t.rMultiple, bars: t.bars, setup: t.setup
            }))
        };
    }

    console.log(JSON.stringify(result));
}

main().catch(e => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
