import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseSmcExportArgs,assertResearchDestination,assertFrozenInputIsolation,type SmcExportArgs} from './smc_export_context.js';
import {loadOptimizedPreset,type SMCPresetLoadOptions} from '../src/engine/smc/smc_config.js';
import {resolveSignalPolicy} from '../src/engine/smc/signal_profiles.js';
import {isValidImpulseCandle} from '../src/engine/smc/math/directional_impulse.js';
import { parse } from 'csv-parse';
import { SMCEngine } from '../src/engine/smc/SMCEngine.js';
import { OHLCV, SMCState, OrderBlock } from '../src/engine/smc/types.js';
import type { DivergenceEvent } from '../src/engine/smc/modules/divergence.js';
import type {ExecutionBar,ExecutionObservation,ExecutionImpulse,ExecutionFvg} from '../src/engine/ExecutionTypes.js';
import {buildRolloverFreezeContext,type RolloverRuntimePolicy} from '../src/engine/RolloverRuntimeContext.js';
import {shouldFreezeRolloverObservation} from '../src/engine/RolloverTriagePolicy.js';
import {registerRolloverSchedule,type RolloverSchedule} from '../src/engine/RolloverSpreadGate.js';
import {predictRegime,REGIME_FEATURE_SCHEMA} from '../src/engine/MLRegimeFeatures.js';

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
    constructor(private readonly causal = false) {}
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
        if (this.keys.length === 0 || (this.causal && timestamp < this.keys[0])) return { htfTrend: 'Neutral', wBias: 'Neutral' };
        
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

async function loadHTFContext(inputDir: string, period: string, ticker: string = 'EURUSD', options: SMCPresetLoadOptions = {}, executionContext = false, rolloverPolicy?:RolloverRuntimePolicy, mlRegimeShadow = false): Promise<HTFContextManager> {
    const { loadOptimizedPreset } = await import('../src/engine/smc/smc_config.js');
    const htfPreset = loadOptimizedPreset(ticker, ({'M5':'H1','M15':'H4','M30':'H4','H1':'D1'} as Record<string,string>)[period] ?? period, 'Forex - 5. Ultra Agresivo', options);
    const manager = new HTFContextManager(executionContext || resolveSignalPolicy(htfPreset).experimental);
    const htfMap: Record<string, string> = { 'M5': 'H1', 'M15': 'H4', 'M30': 'H4', 'H1': 'D1' };
    const htfPeriod = htfMap[period];
    if (!htfPeriod) return manager; // No HTF mapping or already high TF
    
    const htfFile = path.join(inputDir, `history_${htfPeriod}.csv`);
    if (!fs.existsSync(htfFile)) {
        console.warn(`[WARN] HTF file ${htfFile} not found for ${period}. Alignment will be skipped.`);
        return manager;
    }
    
    console.log(`[EXPORT] Pre-loading HTF context from ${htfFile}...`);
    // The same frozen preset/profile is used for output and its HTF context.
    const engine = new SMCEngine(htfPreset, htfPeriod);
    const parser = fs.createReadStream(htfFile).pipe(parse({ columns: true, cast: true }));
    
    let w_h = -Infinity;
    let w_l = Infinity;
    let w_h_raw = NaN;
    let w_l_raw = NaN;
    let dayCount = 0;
    let lastHtfTimestamp = -Infinity;
    const experimental = resolveSignalPolicy(htfPreset).experimental || rolloverPolicy?.profile === 'rollover_triage_v1' || mlRegimeShadow;
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
        
        if(experimental&&(!isValidImpulseCandle(candle)||timestamp<=lastHtfTimestamp))
            throw new Error('Invalid or unordered HTF OHLC candle in '+htfFile);
        lastHtfTimestamp=timestamp;
        const freeze = buildRolloverFreezeContext(ticker,timestamp,timestamp+TF_CLOSE_MS[htfPeriod],rolloverPolicy);
        engine.nextCandle(candle,freeze);
        if(shouldFreezeRolloverObservation(timestamp,timestamp+TF_CLOSE_MS[htfPeriod],freeze))continue;
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

async function processHistoryFile(inputFile: string, outputFile: string, ticker: string, period: string, htfManager: HTFContextManager, options: SMCPresetLoadOptions = {}, isolated = false, executionContext = false, rolloverPolicy?:RolloverRuntimePolicy, mlRegimeShadow = false) {
    console.log(`[EXPORT] Processing ${inputFile} for ${period}...`);
    let basePreset = 'Forex - 3. Balanceado';
    if (['H1', 'H4', 'D1', 'W1'].includes(period)) {
        basePreset = 'Forex - 5. Ultra Agresivo';
    }
    const { loadOptimizedPreset } = await import('../src/engine/smc/smc_config.js');
    const configPreset = loadOptimizedPreset(ticker, period, basePreset, options);
    const policy = resolveSignalPolicy(configPreset);
    if (policy.experimental && !isolated) throw new Error('Experimental profile requires isolated output-dir');
    // 🆕 sep-2026 (opción 4 de Bon): override de volumen institucional vía env para
    // validar el gate (JARVIS_DISPL_VOL_MULT=1.5 → re-export con el filtro activo).
    const volMult = Number(process.env.JARVIS_DISPL_VOL_MULT ?? 0);
    if (volMult > 0) (configPreset as any).displ_vol_mult = volMult;
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
    if(policy.experimental || executionContext || rolloverPolicy?.profile === 'rollover_triage_v1' || mlRegimeShadow){
        for(let i=0;i<records.length;i++)if(!isValidImpulseCandle(records[i])||(i>0&&records[i].timestamp<=records[i-1].timestamp))
            throw new Error('Invalid or duplicate OHLC candle in '+inputFile);
    }

    const executionCodec = executionContext ? await import('../src/engine/ExecutionContext.js') : undefined;
    const executionTf = ({M5:'5',M15:'15',H1:'60',H4:'240',D1:'D'} as Record<string,string>)[period];
    if(executionContext && !executionTf)throw new Error('Unsupported execution context timeframe');
    const asExecutionBar = (c:OHLCV):ExecutionBar=>({tf:executionTf,openTimeMs:c.timestamp,closeTimeMs:c.timestamp+TF_CLOSE_MS[period],availableAtMs:c.timestamp+TF_CLOSE_MS[period],open:c.open,high:c.high,low:c.low,close:c.close,closed:true});
    let executionImpulse:ExecutionImpulse|undefined;
    let executionBreakOpen:number|undefined;
    const executionFvgs = new Map<string,ExecutionFvg>();
    const outStream = fs.createWriteStream(outputFile,{flags:isolated?'wx':'w'});
    await new Promise<void>((resolve,reject)=>{outStream.once('open',()=>resolve());outStream.once('error',reject);});
    const eventCounts:Record<string,number> = {};
    let excludedSignalBars=0;
    const mlRegimeShadowPath=mlRegimeShadow?outputFile+'.ml-regime-shadow.v1.jsonl':undefined;
    if(mlRegimeShadowPath){assertResearchDestination(mlRegimeShadowPath,SOURCE_ROOT);assertFrozenInputIsolation(path.dirname(inputFile),mlRegimeShadowPath);}
    const shadowStream=mlRegimeShadowPath?fs.createWriteStream(mlRegimeShadowPath,{flags:'wx'}):undefined;
    if(shadowStream)await new Promise<void>((resolve,reject)=>{shadowStream.once('open',()=>resolve());shadowStream.once('error',reject);});
    outStream.write('Fecha,Mensaje\n');

    const divZones: DivZone[] = [];

    for (let i = 0; i < records.length; i++) {
        const candle = records[i];
        // 🔧 FIX look-ahead: estampar con tiempo de CIERRE (el evento solo se conoce al cierre de la vela)
        const closeTs = candle.timestamp + (TF_CLOSE_MS[period] ?? 0);
        
        const { htfTrend, wBias } = htfManager.getContext(closeTs);
        const freeze=buildRolloverFreezeContext(ticker,candle.timestamp,closeTs,rolloverPolicy);
        // Legacy HTF manager lacks weekly-source interval provenance. With opt-in,
        // omit that interval so the engine holds HTF propagation instead of inventing it.
        engine.setHTFContext(htfTrend, wBias, freeze);
        
        const previousFvgIds = executionContext ? new Set(engine.getState().activeFVGs.map(f=>f.id)) : undefined;
        const events = engine.nextCandle(candle,freeze);
        const excluded=shouldFreezeRolloverObservation(candle.timestamp,closeTs,freeze);
        if(excluded)excludedSignalBars++;
        const state = engine.getState();
        let executionObservation:ExecutionObservation|undefined;
        let executionBreakBar:ExecutionBar|undefined;
        // Build each structural row from its own canonical setup, not the first
        // event in the batch or a previous impulse. The consumers use formatted
        // ORIGIN / Precio / TS (observation close), never wick extrema.
        const observeExecution = (structural?:any):ExecutionObservation|undefined => {
            if(!executionCodec)return undefined;
            if(structural){
                executionImpulse=undefined;
                executionBreakOpen=undefined;
                executionBreakBar=undefined;
                executionFvgs.clear();
                const direction=dirToBot(structural.direction);
                const origin=Number.isFinite(structural.origin)?fmt(structural.origin):NaN,extreme=fmt(candle.close);
                if(Number.isFinite(origin)&&origin>0&&extreme>0&&(direction==='BUY'?extreme>origin:extreme<origin)){
                    executionImpulse={direction,origin,extreme,createdAtMs:closeTs};
                    // A delayed discovery has a new setup ID but no proven ATR
                    // vintage for its old break. Omit rather than relabel this bar.
                    if((structural.breakTimestamp??structural.timestamp)===candle.timestamp){
                        executionBreakOpen=candle.timestamp;
                        executionBreakBar=asExecutionBar(candle);
                    }
                }
            }
            for(const f of state.activeFVGs){
                const known=executionFvgs.get(f.id);
                const linked=executionImpulse&&executionBreakOpen!==undefined
                    &&f.timestamp===executionBreakOpen&&dirToBot(f.direction)===executionImpulse.direction
                    &&!f.mitigated&&!f.is_ifvg&&f.top>f.bottom
                    &&f.bottom>=Math.min(executionImpulse.origin,executionImpulse.extreme)
                    &&f.top<=Math.max(executionImpulse.origin,executionImpulse.extreme);
                if(!linked){executionFvgs.delete(f.id);continue;}
                // FVG timestamp identifies its middle/displacement candle. It
                // belongs to this impulse only if that is the proven break, and
                // the third candle has now made it observable. Adjacency alone
                // does not justify assigning an older FVG to a newly seen setup.
                if(known)executionFvgs.set(f.id,{...known,top:f.top,bottom:f.bottom});
                else if(!previousFvgIds?.has(f.id)&&f.timestamp+TF_CLOSE_MS[period]===executionImpulse!.createdAtMs)
                    executionFvgs.set(f.id,{id:f.id,direction:executionImpulse!.direction,top:f.top,bottom:f.bottom,
                        createdAtMs:executionImpulse!.createdAtMs,availableAtMs:closeTs,impulseCreatedAtMs:executionImpulse!.createdAtMs,active:true,tf:executionTf});
            }
            const activeIds=new Set(state.activeFVGs.map(f=>f.id));
            for(const id of executionFvgs.keys())if(!activeIds.has(id))executionFvgs.delete(id);
            return executionCodec.buildExecutionObservation({ticker,tf:executionTf,observedAtMs:closeTs,bar:asExecutionBar(candle),
                ...(i>0?{previousClosedBar:asExecutionBar(records[i-1])}:{}),...(executionBreakBar?{breakBar:executionBreakBar}:{}),
                ...(executionImpulse?{impulse:executionImpulse,fvgs:[...executionFvgs.values()]}:{})});
        };
        for (const event of events) eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
        const isoLocal = new Date(candle.timestamp - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00');
        const vwapTag = state.vwapStatus ? ` | VWAP: ${state.vwapStatus}` : '';
        const tf = period === 'M15' ? '15' : period === 'H1' ? '60' : period === 'H4' ? '240' : period === 'D1' ? 'D' : period;
        
        if(!excluded)updateDivZones(divZones, candle);

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
                    executionObservation=observeExecution(ev);
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
                if(executionCodec&&executionObservation&&(ev.type==='EVENT_CHOCH'||ev.type==='EVENT_BOS'))alertMsg=executionCodec.appendExecutionEnvelope(alertMsg,executionObservation);
                outStream.write(`${isoLocal},${toCSVCell(alertMsg)}\n`);
            }
        }
        
        const msg = formatSyncZones(period, state, closeTs, divZones);
        const bias = state.currentTrend === 'Bullish' ? 'BUY' : state.currentTrend === 'Bearish' ? 'SELL' : 'NEUTRAL';
        const zoneCount = (state.activeOBs?.length ?? 0) + divZones.length;
        const hbMsg = `HEARTBEAT | TF: ${tf} | Bias: ${bias} | Zones: ${zoneCount}${vwapTag} | Z-Up: 0 | Z-Dn: 0 | TS: ${closeTs}`;
        let pingMsg = `PING_PRICE | TF: ${tf} | Precio: ${fmt(candle.close)} | High: ${fmt(candle.high)} | Low: ${fmt(candle.low)}${vwapTag} | Z-Up: 0 | Z-Dn: 0 | TS: ${closeTs}`;
        
        executionObservation=observeExecution();
        if(executionCodec&&executionObservation)pingMsg=executionCodec.appendExecutionEnvelope(pingMsg,executionObservation);
        outStream.write(`${isoLocal},${toCSVCell(hbMsg)}\n`);
        outStream.write(`${isoLocal},${toCSVCell(pingMsg)}\n`);
        outStream.write(`${isoLocal},${toCSVCell(msg)}\n`);
        if(shadowStream)for(const direction of ['BUY','SELL'] as const){
            // OHLC CSV has no observed Radar momentum, bilateral quote/cost or actual entry/SL.
            const prediction=predictRegime({schema:REGIME_FEATURE_SCHEMA,ticker,tf:TF_MAP[period],direction,nowMs:closeTs});
            shadowStream.write(JSON.stringify({schema:1,ticker,tf:TF_MAP[period],direction,nowMs:closeTs,prediction})+'\n');
        }

        if (i > 0 && i % 10000 === 0) {
            console.log(`  Procesadas ${i} velas...`);
        }
    }

    await new Promise<void>((resolve,reject)=>{outStream.once('error',reject);outStream.end(resolve);});
    if(shadowStream)await new Promise<void>((resolve,reject)=>{shadowStream.once('error',reject);shadowStream.end(resolve);});
    console.log(`[EXPORT] ✅ Finalizado. Guardado en ${outputFile} (${records.length} velas procesadas).`);
    return {timeframe:period,path:outputFile,sha256:shaFile(outputFile),candles:records.length,
        from_ms:records[0]?.timestamp ?? null,to_ms:records.length?records[records.length-1].timestamp+(TF_CLOSE_MS[period]??0):null,
        eventCounts,policy,effectivePreset:engine.getEffectivePreset(),...(rolloverPolicy?{excludedSignalBars}:{}),...(mlRegimeShadowPath?{mlRegimeShadowPath}: {})};
}

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function shaFile(file:string):string { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function jsonObject(file:string):Record<string,unknown> {
    const value:unknown=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('JSON object required: '+file);
    return value as Record<string,unknown>;
}
function presetOptions(args:SmcExportArgs):SMCPresetLoadOptions {
    const overrides:Record<string,unknown>={};
    if(args.profile)overrides.signal_profile=args.profile;
    if(args.ablationFile)overrides.signal_ablation=jsonObject(args.ablationFile);
    if(args.signalOptionsFile){
        const options=jsonObject(args.signalOptionsFile);
        if(Object.keys(options).some(k=>!['signal_impulse','signal_fvg'].includes(k)))throw new Error('Unknown signal option');
        Object.assign(overrides,options);
    }
    return {presetFile:args.presetFile,signalOverrides:Object.keys(overrides).length?overrides:undefined};
}
function sourceHashes(executionContext = false):Record<string,string> {
    const files:string[]=[];
    const walk=(dir:string)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.isFile()&&file.endsWith('.ts'))files.push(file);
    }};
    walk(path.join(SOURCE_ROOT,'src/engine/smc'));
    files.push(path.join(SOURCE_ROOT,'scripts/export_smc_csv.ts'),path.join(SOURCE_ROOT,'scripts/smc_export_context.ts'));
    for(const name of ['RolloverRuntimeContext.ts','RolloverSpreadGate.ts','RolloverTriagePolicy.ts','MLRegimeFeatures.ts','MLModelValidation.ts'])files.push(path.join(SOURCE_ROOT,'src/engine',name));
    if(executionContext)for(const name of ['ExecutionTypes.ts','ExecutionContext.ts'])files.push(path.join(SOURCE_ROOT,'src/engine',name));
    return Object.fromEntries(files.sort().map(file=>[path.relative(SOURCE_ROOT,file),shaFile(file)]));
}
async function main() {
    const args=parseSmcExportArgs(process.argv.slice(2),process.cwd());
    const {ticker,inputDir,outputDir}=args;
    if(args.quiet){const log=console.log.bind(console);console.log=(...items:unknown[])=>{
        if(typeof items[0]==='string'&&(items[0].startsWith('[SMC-ENGINE]')||items[0].startsWith('[SMC-GATES]')))return;
        log(...items);
    };}
    if(!fs.existsSync(inputDir))throw new Error(`Input directory not found: ${inputDir}`);
    if(args.isolated){
        assertResearchDestination(outputDir,SOURCE_ROOT);
        assertFrozenInputIsolation(inputDir,outputDir);
        if(args.manifestPath){
            assertResearchDestination(args.manifestPath,SOURCE_ROOT);
            assertFrozenInputIsolation(inputDir,args.manifestPath);
        }
    }
    const options=presetOptions(args);
    const rolloverPolicy: RolloverRuntimePolicy|undefined=args.rolloverPolicyFile?jsonObject(args.rolloverPolicyFile):undefined;
    if(rolloverPolicy&&(rolloverPolicy.profile!=='rollover_triage_v1'&&rolloverPolicy.profile!=='legacy'))throw new Error('Explicit valid rollover profile required');
    if(rolloverPolicy?.profile==='legacy')rolloverPolicy.freezeSignals=false;
    let archivedSchedule:RolloverSchedule|undefined;
    if(args.rolloverSchedulesFile){
        if(rolloverPolicy?.profile!=='rollover_triage_v1')throw new Error('Archived schedules require experimental rollover policy');
        const file=jsonObject(args.rolloverSchedulesFile);
        archivedSchedule=(file.schedules as Record<string,RolloverSchedule>|undefined)?.[ticker];
        if(file.schema!==1||!archivedSchedule||!registerRolloverSchedule(ticker,archivedSchedule))throw new Error('Invalid archived broker schedule for ticker');
    }
    const files=fs.readdirSync(inputDir).filter(f=>f.endsWith('.csv'));
    const selected=files.map(file=>({file,period:file.match(/history_([A-Z0-9]+)\.csv/)?.[1]}))
        .filter((x):x is {file:string;period:string}=>!!x.period&&(!args.timeframes||args.timeframes.includes(x.period)));
    if(args.timeframes&&args.timeframes.some(tf=>!selected.some(x=>x.period===tf)))throw new Error('Requested timeframe input missing');
    if(args.isolated&&!selected.length)throw new Error('No candle files selected');
    // Validate all targets and all profiles before opening any CSV output.
    for(const {period} of selected){
        const base=['H1','H4','D1','W1'].includes(period)?'Forex - 5. Ultra Agresivo':'Forex - 3. Balanceado';
        const policy=resolveSignalPolicy(loadOptimizedPreset(ticker,period,base,options));
        if(policy.experimental&&!args.isolated)throw new Error('Experimental profile requires isolated output-dir');
        if(args.isolated){
            if(!TF_CLOSE_MS[period])throw new Error('Unsupported isolated export timeframe: '+period);
            const target=path.join(outputDir,`pine-logs-SMC Master_${period}.csv`);
            assertResearchDestination(target,SOURCE_ROOT);
            assertFrozenInputIsolation(inputDir,target);
            if(fs.existsSync(target))throw new Error('Refusing to overwrite isolated output: '+target);
            if(args.mlRegimeShadow){
                const shadow=target+'.ml-regime-shadow.v1.jsonl';
                assertResearchDestination(shadow,SOURCE_ROOT);assertFrozenInputIsolation(inputDir,shadow);
                if(fs.existsSync(shadow))throw new Error('Refusing to overwrite shadow output: '+shadow);
            }
        }
    }
    if(args.manifestPath&&fs.existsSync(args.manifestPath))throw new Error('Refusing to overwrite export manifest');
    const trackedFiles=args.isolated?[...files.map(f=>path.join(inputDir,f)),
        ...[args.presetFile??path.join(process.cwd(),`optimized_preset_${ticker}.json`),args.ablationFile,args.signalOptionsFile,args.rolloverPolicyFile,args.rolloverSchedulesFile].filter((p):p is string=>!!p&&fs.existsSync(p))]:[];
    const inputHashes=Object.fromEntries(trackedFiles.map(p=>[p,shaFile(p)]));
    const sources=args.isolated?sourceHashes(args.executionContext):{};
    fs.mkdirSync(outputDir,{recursive:true});
    const exports:Awaited<ReturnType<typeof processHistoryFile>>[]=[];
    for(const {file,period} of selected){
        const inFile=path.join(inputDir,file),outFile=path.join(outputDir,`pine-logs-SMC Master_${period}.csv`);
        const htfManager=await loadHTFContext(inputDir,period,ticker,options,args.executionContext,rolloverPolicy,args.mlRegimeShadow);
        exports.push(await processHistoryFile(inFile,outFile,ticker,period,htfManager,options,args.isolated,args.executionContext,rolloverPolicy,args.mlRegimeShadow));
    }
    if(args.manifestPath){
        for(const [p,hash] of Object.entries(inputHashes))if(shaFile(p)!==hash)throw new Error('Frozen input changed: '+p);
        if(JSON.stringify(sourceHashes(args.executionContext))!==JSON.stringify(sources))throw new Error('SMC sources changed during isolated export');
        const manifest={version:1,kind:'smc_signal_export_v1',ticker,profile:exports[0].policy.profile,execution_context_version:args.executionContext?1:null,
            apply_eligible:false,changes_production:false,ml_channels:'unchanged_legacy',
            ...(rolloverPolicy||args.mlRegimeShadow?{research_context_version:1,rollover_policy:rolloverPolicy??null,ml_regime_shadow:args.mlRegimeShadow===true}:{}),
            ...(archivedSchedule?{rollover_schedule:archivedSchedule}:{}),
            evidence_role:'retrospective_integration_not_economic_AB',inputHashes,sources,exports};
        fs.mkdirSync(path.dirname(args.manifestPath),{recursive:true});
        fs.writeFileSync(args.manifestPath,JSON.stringify(manifest,null,2),{flag:'wx'});
    }
}

main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
