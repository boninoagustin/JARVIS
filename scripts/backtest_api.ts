/**
 * backtest_api.ts — Motor de backtest server-side v2.
 * Usa zonas (SYNC_ZONES), sesiones, y filtros del CSV del SMCEngine.
 * Uso: npx tsx scripts/backtest_api.ts <ticker> <tfs> [config_json] [--optimize]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.join(__dirname, '..', 'logs');

interface KlineEvent { timestamp: number; open: number; high: number; low: number; close: number; volume: number; }
interface ZoneInfo { direction: 'BUY' | 'SELL'; top: number; bottom: number; score: number; }
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
    requireZoneConfluence: boolean;
    sessionMinBuy: Record<string, number>;
    sessionMinSell: Record<string, number>;
}

// ── Sesiones ──────────────────────────────────────────────────────────────────
function getSession(ts: number): string {
    const h = new Date(ts).getUTCHours();
    if (h >= 7 && h < 15) return 'LONDON';
    if (h >= 12 && h < 20) return 'NY';
    if (h >= 0 && h < 8) return 'ASIA';
    return 'OFF';
}

// ── CSV Loader ───────────────────────────────────────────────────────────────
function loadData(ticker: string, tfs: string[]): { candles: KlineEvent[]; events: SmeEvent[]; zones: Map<number, ZoneInfo[]> } {
    const tickerDir = path.join(LOGS_DIR, ticker.toLowerCase(), 'history_exported');
    if (!fs.existsSync(tickerDir)) throw new Error(`No existe: ${tickerDir}`);

    const allCandles: (KlineEvent & { sourceTf: string })[] = [];
    const allEvents: SmeEvent[] = [];
    const zonesByTs = new Map<number, ZoneInfo[]>();

    for (const tf of tfs) {
        const csvFile = path.join(tickerDir, `pine-logs-SMC Master_${tf}.csv`);
        if (!fs.existsSync(csvFile)) throw new Error(`No existe: ${csvFile}`);
        const raw = fs.readFileSync(csvFile, 'utf8');
        const rows: any[] = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true });

        let cur: Partial<KlineEvent> = {};
        for (const row of rows) {
            const msg: string = row.Mensaje || '';
            const pr = msg.match(/Precio:\s*([\d.]+)/);
            const hi = msg.match(/High:\s*([\d.]+)/);
            const lo = msg.match(/Low:\s*([\d.]+)/);
            const tm = msg.match(/TS:\s*(\d+)/);

            if (pr && hi && lo && tm && (msg.startsWith('HEARTBEAT') || msg.startsWith('PING_PRICE'))) {
                const ts = parseInt(tm[1]);
                if (cur.timestamp && cur.timestamp !== ts) {
                    allCandles.push({ ...cur as KlineEvent, sourceTf: tf });
                    cur = {};
                }
                if (!cur.timestamp) {
                    cur = { timestamp: ts, open: parseFloat(pr[1]), high: parseFloat(hi[1]), low: parseFloat(lo[1]), close: parseFloat(pr[1]), volume: 0 };
                } else {
                    cur.high = Math.max(cur.high!, parseFloat(hi[1]));
                    cur.low = Math.min(cur.low!, parseFloat(lo[1]));
                    cur.close = parseFloat(pr[1]);
                }
            }

            // Zonas del SYNC_ZONES
            if (msg.startsWith('SYNC_ZONES') && tm) {
                try {
                    const payloadMatch = msg.match(/Payload:\s*(\[.*\])/);
                    if (payloadMatch) {
                        const zones = JSON.parse(payloadMatch[1]);
                        const ts = parseInt(tm[1]);
                        if (!zonesByTs.has(ts)) zonesByTs.set(ts, []);
                        for (const z of zones) {
                            const dir = (z.d === 'BUY' || z.d === 'SELL') ? z.d : ((z.Direction || z.dir || '').includes('Bull') ? 'BUY' : 'SELL');
                            zonesByTs.get(ts)!.push({
                                direction: dir as 'BUY' | 'SELL',
                                top: z.p ?? z.Top ?? z.top ?? 0,
                                bottom: z.b ?? z.Bottom ?? z.bottom ?? 0,
                                score: z.sc ?? z.Score ?? z.score ?? 0
                            });
                        }
                    }
                } catch {}
            }

            // Eventos
            if (tm) {
                const ts = parseInt(tm[1]);
                if (msg.startsWith('EVENTO_CHOCH')) {
                    const dir = (msg.match(/Dir:\s*(BUY|SELL)/) || [])[1] || 'BUY';
                    allEvents.push({ ts, type: 'CHOCH', direction: dir as 'BUY' | 'SELL', points: 4, tf });
                } else if (msg.startsWith('EVENTO_BOS')) {
                    const dir = (msg.match(/Dir:\s*(BUY|SELL)/) || [])[1] || 'BUY';
                    allEvents.push({ ts, type: 'BOS', direction: dir as 'BUY' | 'SELL', points: 3, tf });
                }
            }
        }
        if (cur.timestamp) allCandles.push({ ...cur as KlineEvent, sourceTf: tf });
    }

    const candleMap = new Map<number, KlineEvent>();
    for (const c of allCandles) {
        const ex = candleMap.get(c.timestamp);
        if (!ex || c.sourceTf === 'M5') {
            candleMap.set(c.timestamp, { timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
        }
    }
    const candles = Array.from(candleMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    // Pre-ordenar keys de zonas para búsqueda binaria
    const sortedZoneTs = Array.from(zonesByTs.keys()).sort((a, b) => a - b);
    return { candles, events: allEvents, zones: zonesByTs, sortedZoneTs };
}

// ── Simulador ────────────────────────────────────────────────────────────────
function findCandle(candles: KlineEvent[], ts: number): KlineEvent {
    let lo = 0, hi = candles.length - 1;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (candles[mid].timestamp <= ts) lo = mid;
        else hi = mid - 1;
    }
    return candles[lo];
}

function getZonesAt(sortedKeys: number[], zones: Map<number, ZoneInfo[]>, ts: number): ZoneInfo[] {
    if (sortedKeys.length === 0) return [];
    let lo = 0, hi = sortedKeys.length - 1;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (sortedKeys[mid] <= ts) lo = mid;
        else hi = mid - 1;
    }
    return sortedKeys[lo] <= ts ? zones.get(sortedKeys[lo]) || [] : [];
}

function simulate(candles: KlineEvent[], events: SmeEvent[], zones: Map<number, ZoneInfo[]>, sortedZoneTs: number[], config: SimConfig): TradeResult[] {
    const trades: TradeResult[] = [];
    let balance = 1000;

    interface OpenTrade {
        dir: string; entry: number; sl: number; tp1: number; tp2: number;
        quantity: number; entryTs: number; bars: number; maxFav: number; maxAdv: number;
        tp1Hit: boolean; slMoved: boolean; partialDone: boolean;
        partialPct: number; slAfterTp1: string; tp15Be: boolean; setup: string;
    }
    const open: OpenTrade[] = [];

    function closeTrade(tr: OpenTrade, c: KlineEvent, nowTs: number): boolean {
        const riskAmt = Math.abs(tr.entry - tr.sl);
        tr.bars = Math.floor((nowTs - tr.entryTs) / 60000);
        tr.maxFav = Math.max(tr.maxFav, tr.dir === 'BUY' ? (c.high - tr.entry) / riskAmt : (tr.entry - c.low) / riskAmt);
        tr.maxAdv = Math.max(tr.maxAdv, tr.dir === 'BUY' ? (tr.entry - c.low) / riskAmt : (c.high - tr.entry) / riskAmt);

        const tp1Hit = tr.dir === 'BUY' ? c.high >= tr.tp1 : c.low <= tr.tp1;
        if (tp1Hit && !tr.tp1Hit) {
            tr.tp1Hit = true;
            if (!tr.partialDone && tr.partialPct > 0) {
                balance += tr.quantity * tr.partialPct * Math.abs(tr.tp1 - tr.entry);
                tr.quantity *= (1 - tr.partialPct);
                tr.partialDone = true;
            }
            if (tr.slAfterTp1 === 'breakeven') { tr.sl = tr.entry; }
            else if (tr.slAfterTp1 === 'midpoint') { tr.sl = (tr.entry + tr.tp1) / 2; }
            if (config.tp15BeEnabled) { tr.sl = tr.entry; }
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
                entryTs: tr.entryTs, exitTs: nowTs, direction: tr.dir, entryPrice: tr.entry, exitPrice,
                slHit, tp1Hit: tr.tp1Hit, tp2Hit,
                rMultiple: Math.round(rMult * 1000) / 1000, bars: tr.bars,
                maxFavorable: Math.round(tr.maxFav * 100) / 100,
                maxAdverse: Math.round(tr.maxAdv * 100) / 100, setup: tr.setup
            });
            return true;
        }
        return false;
    }

    for (const ev of events.sort((a, b) => a.ts - b.ts)) {
        const dir = ev.direction;
        const session = getSession(ev.ts);
        const sessMinBuy = config.sessionMinBuy?.[session] ?? config.minBuyPoints;
        const sessMinSell = config.sessionMinSell?.[session] ?? config.minSellPoints;
        const minPts = dir === 'BUY' ? sessMinBuy : sessMinSell;
        if (ev.points < minPts) continue;

        const c = findCandle(candles, ev.ts);

        // 🆕 Filtro de zona: requiere al menos 1 zona activa que contenga el precio
        if (config.requireZoneConfluence) {
            const activeZones = getZonesAt(sortedZoneTs, zones, ev.ts);
            const hasZone = activeZones.some(z => z.direction === dir && c.close >= z.bottom && c.close <= z.top);
            if (!hasZone) continue;
        }

        const entry = c.close;
        const atr = (c.high - c.low) * (1 + config.slBuffer);
        const sl = dir === 'BUY' ? entry - atr : entry + atr;
        const risk = Math.abs(entry - sl);
        if (risk <= 0) continue;

        const tp2 = dir === 'BUY' ? entry + risk * config.fixedRR : entry - risk * config.fixedRR;
        const tp1 = dir === 'BUY' ? entry + risk : entry - risk;
        const qty = (balance * 0.01) / risk;
        if (qty <= 0 || !isFinite(qty)) continue;

        for (let t = open.length - 1; t >= 0; t--) {
            if (closeTrade(open[t], c, ev.ts)) open.splice(t, 1);
        }

        open.push({
            dir, entry, sl, tp1, tp2, quantity: qty, entryTs: ev.ts, bars: 0, maxFav: 0, maxAdv: 0,
            tp1Hit: false, slMoved: false, partialDone: false,
            partialPct: config.partialClosePct, slAfterTp1: config.slAfterTp1,
            tp15Be: config.tp15BeEnabled, setup: `${ev.type}_${ev.tf}`
        });
    }

    const last = candles[candles.length - 1];
    for (let t = open.length - 1; t >= 0; t--) {
        if (closeTrade(open[t], last, last.timestamp)) open.splice(t, 1);
    }

    return trades;
}

// ── Métricas ─────────────────────────────────────────────────────────────────
function computeMetrics(trades: TradeResult[]) {
    const wins = trades.filter(t => t.rMultiple > 0).length;
    const losses = trades.filter(t => t.rMultiple <= 0).length;
    const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
    const avgR = trades.length > 0 ? totalR / trades.length : 0;
    const wr = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    const grossProfit = trades.filter(t => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
    const grossLoss = Math.abs(trades.filter(t => t.rMultiple <= 0).reduce((s, t) => s + t.rMultiple, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : (trades.length > 0 ? Infinity : 0);
    return {
        totalTrades: trades.length, wins, losses,
        winRate: Math.round(wr * 10) / 10,
        totalR: Math.round(totalR * 100) / 100,
        avgR: Math.round(avgR * 100) / 100,
        profitFactor: Math.round(pf * 100) / 100,
        maxDrawdownPct: 0, sharpe: 0
    };
}

// ── GA Optimizer ─────────────────────────────────────────────────────────────
function geneticOptimize(candles: KlineEvent[], events: SmeEvent[], zones: Map<number, ZoneInfo[]>, sortedZoneTs: number[], base: SimConfig, popSize = 50, gens = 12): SimConfig {
    const bounds: [number, number][] = [[3, 9], [0.0005, 0.008], [1.0, 3.0], [0.2, 0.8]];
    const rand = () => bounds.map(([lo, hi]) => lo + Math.random() * (hi - lo));
    const toCfg = (g: number[]): SimConfig => ({
        ...base, minBuyPoints: Math.round(g[0]), minSellPoints: Math.round(g[0]),
        slBuffer: g[1], fixedRR: Math.round(g[2] * 10) / 10, partialClosePct: Math.round(g[3] * 10) / 10
    });
    let pop = Array.from({ length: popSize }, () => rand());
    for (let gen = 0; gen < gens; gen++) {
        const scored = pop.map(g => {
            const trades = simulate(candles, events, zones, sortedZoneTs, toCfg(g));
            if (trades.length < 5) return { g, fit: -Infinity };
            const m = computeMetrics(trades);
            return { g, fit: m.avgR * (m.winRate / 100) * Math.sqrt(Math.min(trades.length, 50)) };
        });
        scored.sort((a, b) => b.fit - a.fit);
        const elites = scored.slice(0, Math.floor(popSize * 0.2));
        const newPop = elites.map(e => e.g);
        while (newPop.length < popSize) {
            const a = elites[Math.floor(Math.random() * elites.length)].g;
            const b = elites[Math.floor(Math.random() * elites.length)].g;
            const child = a.map((v, i) => {
                if (Math.random() < 0.1) { const r = bounds[i][1] - bounds[i][0]; return Math.max(bounds[i][0], Math.min(bounds[i][1], v + (Math.random() - 0.5) * r * 0.2)); }
                return Math.random() < 0.5 ? v : b[i];
            });
            newPop.push(child);
        }
        pop = newPop;
    }
    return toCfg(pop[0]);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) { console.log(JSON.stringify({ error: 'Uso: backtest_api.ts <ticker> <tfs> [config_json] [--optimize]' })); process.exit(0); }

    const ticker = args[0].toUpperCase();
    const tfs = args[1].split(',');
    const isOptimize = args.includes('--optimize');
    const configJson = args.find(a => a.startsWith('{'));
    const defaults: SimConfig = {
        minBuyPoints: 5, minSellPoints: 5, slBuffer: 0.0015, fixedRR: 1.5,
        entryTrigger: 'SMART', partialClosePct: 0.5, slAfterTp1: 'midpoint',
        tp15BeEnabled: true, atrTrailEnabled: true, structuralTrailEnabled: false,
        spreadPips: 1.5, minRR: 0.75,
        requireZoneConfluence: false,
        sessionMinBuy: {}, sessionMinSell: {}
    };
    const config: SimConfig = configJson ? { ...defaults, ...JSON.parse(configJson) } : defaults;

    const t0 = Date.now();
    const { candles, events, zones, sortedZoneTs } = loadData(ticker, tfs);
    const loadMs = Date.now() - t0;

    let result: any;
    if (isOptimize) {
        const optStart = Date.now();
        const best = geneticOptimize(candles, events, zones, sortedZoneTs, config);
        const optMs = Date.now() - optStart;
        const trades = simulate(candles, events, zones, sortedZoneTs, best);
        result = {
            ticker, timeframes: tfs, mode: 'optimize',
            timings: { loadMs, optimizeMs: optMs, totalMs: loadMs + optMs },
            candles: candles.length, events: events.length, zones: zones.size,
            optimized: { minBuyPoints: best.minBuyPoints, minSellPoints: best.minSellPoints, slBuffer: best.slBuffer, fixedRR: best.fixedRR, partialClosePct: best.partialClosePct },
            metrics: computeMetrics(trades),
            trades: trades.slice(-100)
        };
    } else {
        const simStart = Date.now();
        const trades = simulate(candles, events, zones, sortedZoneTs, config);
        const simMs = Date.now() - simStart;
        result = {
            ticker, timeframes: tfs, mode: 'simulate',
            timings: { loadMs, simulateMs: simMs, totalMs: loadMs + simMs },
            candles: candles.length, events: events.length, zones: zones.size, config,
            metrics: computeMetrics(trades),
            trades: trades.slice(-100).map(t => ({
                id: `bt_${t.entryTs}`, ticker, direction: t.direction,
                timestamp: new Date(t.entryTs).toISOString(),
                entryTs: new Date(t.entryTs).toISOString(), exitTs: new Date(t.exitTs).toISOString(),
                entryPrice: t.entryPrice, exitPrice: t.exitPrice,
                result: t.rMultiple > 0 ? 'WIN' : 'LOSS', rMultiple: t.rMultiple, bars: t.bars, setup: t.setup
            }))
        };
    }
    console.log(JSON.stringify(result));
}

main().catch(e => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
