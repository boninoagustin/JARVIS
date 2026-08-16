import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse';
import { SMCEngine } from '../src/engine/smc/SMCEngine.js';
import { OHLCV, SMCState, OrderBlock } from '../src/engine/smc/types.js';
import type { DivergenceEvent } from '../src/engine/smc/modules/divergence.js';

// Utils — format price to 7 decimals for ATR, 5 for prices
function fmtPrice(num: number): number {
    return Number(num.toFixed(5));
}
const fmt = fmtPrice;

const dirToBot = (d: string) => (d === 'Bullish' ? 'BUY' : 'SELL');

// 🔧 FIX look-ahead: duración de cada TF en ms. Los eventos de una vela solo se
// conocen al CIERRE, así que se estampan con timestamp = apertura + duración.
const TF_CLOSE_MS: Record<string, number> = {
    'M5': 5 * 60 * 1000,
    'M15': 15 * 60 * 1000,
    'H1': 60 * 60 * 1000,
    'H4': 4 * 60 * 60 * 1000,
    'D1': 24 * 60 * 60 * 1000,
};

// Pine usaba medallas cortas: PLAT, ORO, PLATA, BRONCE, CHoCH, GOD
// Pero el category del motor viene como "Platino", "Oro", etc.  con posible sufijo " | Legacy+SWP"
// El SMCBridge del bot real usa estos mismos mapeos (ver SMCBridge.ts L38-40)
const MEDAL_MAP: Record<string, string> = {
    'Platino': 'PLAT',
    'Oro': 'ORO',
    'Plata': 'PLATA',
    'Bronce': 'BRONCE',
    'CHoCH': 'CHoCH',
    'GodZone': 'GOD'
};

function obMedal(ob: OrderBlock): string {
    // category puede ser "Plata | Legacy+SWP" o "Platino"
    const parts = ob.category.split(' | ');
    const baseMedal = parts[0];
    const suffix = parts.length > 1 ? ` | ${parts.slice(1).join(' | ')}` : '';
    const mapped = MEDAL_MAP[baseMedal] ?? baseMedal;
    return mapped + suffix;
}

const TF_MAP: Record<string, string> = {
    'M5': '5',
    'M15': '15',
    'M30': '30',
    'H1': '60',
    'H4': '240',
    'D1': '1D',
    'W1': '1W'
};

// ────────────────────────────────────────────────────────────────────────────
// Divergence Zone Buffer  
// Pine mantenía hasta ~5 zonas de divergencia simultáneamente en el SYNC_ZONES.
// Las divergencias no son efímeras como en nuestro engine — permanecen como
// zonas hasta que el precio las cruza (mitiga) o expiran por antigüedad.
// ────────────────────────────────────────────────────────────────────────────
interface DivZone {
    direction: 'Bullish' | 'Bearish';
    top: number;
    bottom: number;
    score: number;
    ageBars: number;
    mitigated: boolean;
}

const MAX_DIV_ZONES = 5;
const MAX_DIV_AGE = 100; // expire after 100 bars

function createDivZone(div: DivergenceEvent & { top?: number; bottom?: number; score?: number }, atr: number): DivZone {
    return {
        direction: div.direction,
        top: div.top ?? (div.price + atr * 0.5),
        bottom: div.bottom ?? (div.price - atr * 0.5),
        score: div.score ?? 1,
        ageBars: 0,
        mitigated: false
    };
}

function updateDivZones(divZones: DivZone[], candle: OHLCV) {
    for (const dz of divZones) {
        dz.ageBars++;
        if (dz.ageBars > MAX_DIV_AGE) { dz.mitigated = true; continue; }
        // Mitigate if price breaks the zone (fails)
        if (dz.direction === 'Bullish' && candle.close < dz.bottom) dz.mitigated = true;
        if (dz.direction === 'Bearish' && candle.close > dz.top) dz.mitigated = true;
    }
}

// ────────────────────────────────────────────────────────────────────────────

function formatSyncZones(
    period: string,
    state: SMCState,
    timestamp: number,
    divZones: DivZone[]
): string {
    const tfMap: Record<string, string> = {
        'M5': '5',
        'M15': '15',
        'M30': '30',
        'H1': '60',
        'H4': '240',
        'D1': 'D',
        'W1': 'W'
    };
    
    const tf = tfMap[period] ?? period;

    const activeOBs = [...(state.activeOBs ?? [])].filter(ob => !ob.mitigated && !ob.hidden);
    const activeBreakers = (state.activeBreakers ?? []).filter(ob => !ob.mitigated && !ob.hidden);
    const atr = Number((state.atr ?? 0).toFixed(10));
    
    const zones: any[] = [];
    
    // OBs normales
    for (const ob of activeOBs) {
        const entry: any = {
            t: tf,
            d: ob.direction === 'Bullish' ? 'BUY' : 'SELL',
            p: fmtPrice(ob.top),
            b: fmtPrice(ob.bottom),
            lv: (ob.direction === 'Bullish' ? ob.top : ob.bottom).toFixed(5),
            md: obMedal(ob),
            sc: ob.score,
            a: atr
        };
        // Pine incluía mg (merge count) cuando la zona era resultado de fusión
        if (ob.merged && ob.merge_count && ob.merge_count > 1) {
            entry.mg = ob.merge_count;
        }
        zones.push(entry);
    }

    // Breakers
    for (const ob of activeBreakers) {
        zones.push({
            t: tf,
            d: ob.direction === 'Bullish' ? 'BUY' : 'SELL',
            p: fmtPrice(ob.top),
            b: fmtPrice(ob.bottom),
            lv: (ob.direction === 'Bullish' ? ob.top : ob.bottom).toFixed(5),
            md: ob.category === 'GodZone' ? 'GOD_BRK' : 'BRK',
            sc: ob.score,
            a: atr
        });
    }

    // Divergences como zonas persistentes (igual que Pine)
    const activeDivs = divZones.filter(dz => !dz.mitigated);
    for (const dz of activeDivs) {
        zones.push({
            t: tf,
            d: dz.direction === 'Bullish' ? 'BUY' : 'SELL',
            p: fmtPrice(dz.top),
            b: fmtPrice(dz.bottom),
            lv: "DIV",
            md: "SMC_DIV",
            sc: dz.score,
            a: atr,
            kz: true
        });
    }

    const trend = state.currentTrend === 'Bullish' ? 'BUY' : state.currentTrend === 'Bearish' ? 'SELL' : 'NEUTRAL';
    
    // Use Weekly Bias from engine context, defaulting to trend if not set.
    const engineAny = state as any;
    const wBiasStr = engineAny.weeklyBias === 'Bullish' ? 'BUY' : engineAny.weeklyBias === 'Bearish' ? 'SELL' : trend;
    
    return `SYNC_ZONES | TF: ${tf} | Trend: ${trend} | WBias: ${wBiasStr} | Payload: ${JSON.stringify(zones.slice(0, 20))} | TS: ${timestamp}`;
}

// CSV cell escaping 
function toCSVCell(val: string): string {
    // Pine CSV always wraps the Mensaje in quotes for consistency, even if no commas exist
    return `"${val.replace(/"/g, '""')}"`;
}

class HTFContextManager {
    private trends = new Map<number, { htfTrend: 'Bullish'|'Bearish'|'Neutral', wBias: 'Bullish'|'Bearish'|'Neutral' }>();
    private keys: number[] = [];
    
    public addData(timestamp: number, htfTrend: 'Bullish'|'Bearish'|'Neutral', wBias: 'Bullish'|'Bearish'|'Neutral') {
        this.trends.set(timestamp, { htfTrend, wBias });
        this.keys.push(timestamp);
    }
    
    public sort() {
        this.keys.sort((a, b) => a - b);
    }

    public getContext(timestamp: number): { htfTrend: 'Bullish'|'Bearish'|'Neutral', wBias: 'Bullish'|'Bearish'|'Neutral' } {
        if (this.keys.length === 0) return { htfTrend: 'Neutral', wBias: 'Neutral' };
        
        let left = 0;
        let right = this.keys.length - 1;
        let best = this.keys[0];
        
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (this.keys[mid] <= timestamp) {
                best = this.keys[mid];
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }
        
        return this.trends.get(best) ?? { htfTrend: 'Neutral', wBias: 'Neutral' };
    }
}

async function loadHTFContext(inputDir: string, period: string, ticker: string = 'EURUSD'): Promise<HTFContextManager> {
    const manager = new HTFContextManager();
    const htfMap: Record<string, string> = { 'M5': 'H1', 'M15': 'H4', 'M30': 'H4', 'H1': 'D1' };
    const htfPeriod = htfMap[period];
    if (!htfPeriod) return manager; // No HTF mapping or already high TF
    
    const htfFile = path.join(inputDir, `history_${htfPeriod}.csv`);
    if (!fs.existsSync(htfFile)) {
        console.warn(`[WARN] HTF file ${htfFile} not found for ${period}. Alignment will be skipped.`);
        return manager;
    }
    
    console.log(`[EXPORT] Pre-loading HTF context from ${htfFile}...`);
    const { loadOptimizedPreset } = await import('../src/engine/smc/smc_config.js');
    const htfPreset = loadOptimizedPreset(ticker, htfPeriod, 'Forex - 5. Ultra Agresivo');
    const engine = new SMCEngine(htfPreset, htfPeriod);
    const parser = fs.createReadStream(htfFile).pipe(parse({ columns: true, cast: true }));
    
    let w_h = -Infinity;
    let w_l = Infinity;
    let w_h_raw = NaN;
    let w_l_raw = NaN;
    let dayCount = 0;
    
    for await (const row of parser) {
        const timestamp = Number(row.timestamp);
        const candle: OHLCV = {
            timestamp,
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            volume: Number(row.volume)
        };
        
        engine.nextCandle(candle);
        const state = engine.getState();
        
        const d = new Date(timestamp);
        if (htfPeriod === 'D1') {
            w_h = Math.max(w_h, candle.high);
            w_l = Math.min(w_l, candle.low);
            dayCount++;
            if (d.getDay() === 5 || dayCount >= 5) {
                w_h_raw = w_h;
                w_l_raw = w_l;
                w_h = -Infinity;
                w_l = Infinity;
                dayCount = 0;
            }
        }
        
        let wBias: 'Bullish'|'Bearish'|'Neutral' = 'Neutral';
        if (!Number.isNaN(w_h_raw) && !Number.isNaN(w_l_raw)) {
            const mid = (w_h_raw + w_l_raw) / 2;
            wBias = candle.close > mid ? 'Bullish' : candle.close < mid ? 'Bearish' : 'Neutral';
        }
        
        manager.addData(timestamp + (TF_CLOSE_MS[htfPeriod] ?? 0), state.simpleTrend ?? 'Neutral', wBias);
    }
    
    manager.sort();
    return manager;
}

async function processHistoryFile(inputFile: string, outputFile: string, ticker: string, period: string, htfManager: HTFContextManager) {
    console.log(`[EXPORT] Processing ${inputFile} for ${period}...`);
    let basePreset = 'Forex - 3. Balanceado';
    if (['H1', 'H4', 'D1', 'W1'].includes(period)) {
        basePreset = 'Forex - 5. Ultra Agresivo';
    }
    const { loadOptimizedPreset } = await import('../src/engine/smc/smc_config.js');
    const configPreset = loadOptimizedPreset(ticker, period, basePreset);
    const engine = new SMCEngine(configPreset, period);
    
    const records: OHLCV[] = [];
    const parser = fs.createReadStream(inputFile).pipe(parse({ columns: true, cast: true }));

    for await (const row of parser) {
        records.push({
            timestamp: Number(row.timestamp),
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            volume: Number(row.volume)
        });
    }

    records.sort((a, b) => a.timestamp - b.timestamp);

    const outStream = fs.createWriteStream(outputFile);
    outStream.write('Fecha,Mensaje\n');

    const divZones: DivZone[] = [];

    for (let i = 0; i < records.length; i++) {
        const candle = records[i];
        // 🔧 FIX look-ahead: estampar con tiempo de CIERRE (el evento solo se conoce al cierre de la vela)
        const closeTs = candle.timestamp + (TF_CLOSE_MS[period] ?? 0);
        
        const { htfTrend, wBias } = htfManager.getContext(closeTs);
        engine.setHTFContext(htfTrend, wBias);
        
        const events = engine.nextCandle(candle);
        const state = engine.getState();
        const isoLocal = new Date(candle.timestamp - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00');
        const vwapTag = state.vwapStatus ? ` | VWAP: ${state.vwapStatus}` : '';
        const tf = period === 'M15' ? '15' : period === 'H1' ? '60' : period === 'H4' ? '240' : period === 'D1' ? 'D' : period;
        
        updateDivZones(divZones, candle);

        const divEvent = events.find((e: any) => e.type === 'EVENT_DIVERGENCE');
        if (divEvent && state.lastDivergence) {
            divZones.push(createDivZone(state.lastDivergence as DivergenceEvent, state.atr ?? 0.0005));
            // Mantener máximo MAX_DIV_ZONES
            while (divZones.filter(dz => !dz.mitigated).length > 2) {
                const oldest = divZones.find(dz => !dz.mitigated);
                if (oldest) oldest.mitigated = true;
            }
        }

        // Limpiar mitigadas del buffer
        const activeCount = divZones.filter(dz => !dz.mitigated).length;
        if (divZones.length > activeCount + 20) {
            // Purge mitigated entries to save memory
            const activeDivs = divZones.filter(dz => !dz.mitigated);
            divZones.length = 0;
            divZones.push(...activeDivs);
        }

        // Output Engine Events
        for (const ev of events) {
            let alertMsg: string | null = null;
            switch (ev.type) {
                case 'EVENT_CHOCH':
                case 'EVENT_BOS': {
                    const prefix = ev.type === 'EVENT_CHOCH' ? 'EVENTO_CHOCH' : 'EVENTO_BOS';
                    const dir = dirToBot(ev.direction);
                    const origin = (ev as any).origin !== undefined ? ` | ORIGIN: ${fmt((ev as any).origin)}` : '';
                    alertMsg = `${prefix} | TF: ${tf} | Dir: ${dir} | Precio: ${fmt(candle.close)}${vwapTag}${origin} | CONFIRMED | TS: ${closeTs}`;
                    break;
                }
                case 'EVENT_SWEEP': {
                    const dir = dirToBot(ev.direction);
                    if (ev.sweepType === 'LIQ_GRAB') {
                        alertMsg = `LIQ_GRAB | TF: ${tf} | Dir: ${dir} | Nivel: ${fmt(ev.price)} | TS: ${closeTs}`;
                    } else {
                        alertMsg = `EVENTO_SWEEP | TF: ${tf} | Dir: ${dir} | Nivel Reclamado | TS: ${closeTs}`;
                    }
                    break;
                }
                case 'EVENT_DIVERGENCE': {
                    const dir = dirToBot(ev.direction);
                    const rsiDiff = ev.divergence?.rsiDiff ? Math.round(ev.divergence.rsiDiff * 10) / 10 : 0;
                    const score = ev.divergence?.score ?? 0;
                    alertMsg = `EVENTO_SMC_DIV | TF: ${tf} | Dir: ${dir} | Score: ${score} | RSI_Diff: ${rsiDiff} | TS: ${closeTs}`;
                    break;
                }
                case 'ZONE_TOUCHED':
                case 'ZONE_BROKEN': {
                    const dir = dirToBot(ev.direction);
                    const medal = MEDAL_MAP[ev.category] ?? ev.category;
                    alertMsg = `${ev.type} | TF: ${tf} | Dir: ${dir} | Medal: ${medal} | Score: ${ev.score} | Top: ${fmt(ev.top)} | Btm: ${fmt(ev.bottom)} | TS: ${closeTs}`;
                    break;
                }
            }
            
            if (alertMsg) {
                outStream.write(`${isoLocal},${toCSVCell(alertMsg)}\n`);
            }
        }
        
        const msg = formatSyncZones(period, state, closeTs, divZones);
        const bias = state.currentTrend === 'Bullish' ? 'BUY' : state.currentTrend === 'Bearish' ? 'SELL' : 'NEUTRAL';
        const zoneCount = (state.activeOBs?.length ?? 0) + divZones.length;
        const hbMsg = `HEARTBEAT | TF: ${tf} | Bias: ${bias} | Zones: ${zoneCount}${vwapTag} | Z-Up: 0 | Z-Dn: 0 | TS: ${closeTs}`;
        const pingMsg = `PING_PRICE | TF: ${tf} | Precio: ${fmt(candle.close)} | High: ${fmt(candle.high)} | Low: ${fmt(candle.low)}${vwapTag} | Z-Up: 0 | Z-Dn: 0 | TS: ${closeTs}`;
        
        outStream.write(`${isoLocal},${toCSVCell(hbMsg)}\n`);
        outStream.write(`${isoLocal},${toCSVCell(pingMsg)}\n`);
        outStream.write(`${isoLocal},${toCSVCell(msg)}\n`);

        if (i > 0 && i % 10000 === 0) {
            console.log(`  Procesadas ${i} velas...`);
        }
    }

    outStream.end();
    console.log(`[EXPORT] ✅ Finalizado. Guardado en ${outputFile} (${records.length} velas procesadas).`);
}

async function main() {
    const ticker = (process.argv[2] || 'EURUSD').toUpperCase();
    const inputDir = path.join(process.cwd(), 'logs', ticker.toLowerCase(), 'history');
    const outputDir = path.join(process.cwd(), 'logs', ticker.toLowerCase(), 'history_exported');
    
    if (!fs.existsSync(inputDir)) {
        console.error(`Input directory not found: ${inputDir}`);
        process.exit(1);
    }

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.csv'));

    for (const file of files) {
        const match = file.match(/history_([A-Z0-9]+)\.csv/);
        if (match) {
            const period = match[1];
            const inFile = path.join(inputDir, file);
            const outFile = path.join(outputDir, `pine-logs-SMC Master_${period}.csv`);
            const htfManager = await loadHTFContext(inputDir, period, ticker);
            await processHistoryFile(inFile, outFile, ticker, period, htfManager);
        }
    }
}

main().catch(console.error);
