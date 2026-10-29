/** Node-only opt-in transport. Import and RAM decisions never start work.
 * Lifecycle owner must explicitly configure and forward closed candles. Audit
 * stays at the existing caller; this module neither suppresses nor moves it. */
import {
    fetchLiveTimesfmDecision as fetchLegacy, evaluateTimesfmFilter,
    degradedTimesfmDecision, validateTimesfmForecast, normalizeTimesfmTf,
    timesfmCandleKey,
} from './TimesfmFilter.js';
import type { TimesfmDecision, TimesfmFilterConfig, TimesfmForecast } from './TimesfmFilter.js';

export type LiveTimesfmDecisionArgs = Parameters<typeof fetchLegacy>[0];
export interface TimesfmCacheRegistration { ticker: string; tfMinutes: number; cfg: TimesfmFilterConfig }
export interface TimesfmCacheDependencies {
    now?: () => number;
    fetch?: typeof globalThis.fetch;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (timer: any) => void;
}
interface Entry {
    key: string; ticker: string; tfMinutes: number; cfg: TimesfmFilterConfig;
    now: () => number; fetch: typeof globalThis.fetch;
    schedule: (fn: () => void, ms: number) => unknown; cancel: (timer: any) => void;
    target: number; attempt: number; running: boolean; disposed: boolean;
    timer?: unknown; controller?: AbortController;
    forecast?: TimesfmForecast; receivedAt?: number; lastError?: string;
}
const entries = new Map<string, Entry>();
const MODEL = 'timesfm-2.5-200m-pytorch@f1';
function keyOf(a: TimesfmCacheRegistration): string {
    return JSON.stringify([a.cfg.bridgeUrl.replace(/\/$/, ''),a.ticker.toLowerCase(),a.tfMinutes,a.cfg.liveModelVersion??MODEL,a.cfg.liveSchemaVersion??2]);
}
function discard(e: Entry): void {
    e.disposed=true;
    if(e.timer!==undefined)e.cancel(e.timer);
    e.controller?.abort();
}

/** Starts bounded background refresh explicitly, never from the decision path.
 * Re-registering invalidates pending responses and removes incompatible snapshots. */
export function configureTimesfmLiveCache(args: TimesfmCacheRegistration, deps: TimesfmCacheDependencies = {}): boolean {
    // Remove older registration(s) for this source identity, including model changes.
    const bridge=args.cfg.bridgeUrl.replace(/\/$/,'');
    for(const [key,e] of entries) if(e.ticker===args.ticker.toLowerCase() && e.tfMinutes===args.tfMinutes && e.cfg.bridgeUrl.replace(/\/$/,'')===bridge){discard(e);entries.delete(key);}
    if(!args.cfg.enabled || !['ram','ram_shadow'].includes(args.cfg.liveTransport??'legacy_http'))return false;
    if(normalizeTimesfmTf(args.tfMinutes)!==args.tfMinutes || !/^[A-Za-z0-9_]{1,40}$/.test(args.ticker) || !Number.isFinite(args.cfg.maxForecastAgeMs) || args.cfg.maxForecastAgeMs<0)return false;
    if(!Number.isFinite(args.cfg.latencyBudgetMs) || args.cfg.latencyBudgetMs<=0 || (args.cfg.liveMaxAttempts!==undefined && (!Number.isInteger(args.cfg.liveMaxAttempts) || args.cfg.liveMaxAttempts<1 || args.cfg.liveMaxAttempts>100)) || (args.cfg.liveRetryMs!==undefined && (!Number.isFinite(args.cfg.liveRetryMs) || args.cfg.liveRetryMs<10 || args.cfg.liveRetryMs>60000)))return false;
    const now=deps.now??Date.now;
    const e:Entry={key:keyOf(args),ticker:args.ticker.toLowerCase(),tfMinutes:args.tfMinutes,cfg:{...args.cfg},now,fetch:deps.fetch??globalThis.fetch,schedule:deps.setTimeout??((fn,ms)=>setTimeout(fn,ms)),cancel:deps.clearTimeout??(id=>clearTimeout(id)),target:timesfmCandleKey(now(),args.tfMinutes),attempt:0,running:false,disposed:false};
    entries.set(e.key,e);void refresh(e);return true;
}
function retry(e: Entry): void {
    if(e.disposed || e.attempt >= Math.max(1,Math.min(100,e.cfg.liveMaxAttempts??8)))return;
    const delay=Math.max(10,Math.min(60000,e.cfg.liveRetryMs??500))*Math.min(8,2**Math.max(0,e.attempt-1));
    e.timer=e.schedule(()=>{e.timer=undefined;void refresh(e);},delay);
}
async function refresh(e: Entry): Promise<void> {
    if(e.disposed || e.running)return;
    e.running=true;e.attempt++;
    const requestedTarget=e.target;
    const controller=new AbortController();e.controller=controller;
    const timeout=e.schedule(()=>controller.abort(),Math.max(1,e.cfg.latencyBudgetMs));
    let ready=false;
    try {
        const res=await e.fetch(`${e.cfg.bridgeUrl.replace(/\/$/,'')}/forecast/latest?ticker=${encodeURIComponent(e.ticker)}&tf=${e.tfMinutes}`,{signal:controller.signal,redirect:'error'});
        if(!res.ok)throw Error(`bridge HTTP ${res.status}`);
        const value:unknown=await res.json();const received=e.now();
        const invalid=validateTimesfmForecast(value,{ticker:e.ticker,tfMinutes:e.tfMinutes,nowMs:received,maxAgeMs:e.cfg.maxForecastAgeMs,strict:true,modelVersion:e.cfg.liveModelVersion??MODEL,schemaVersion:e.cfg.liveSchemaVersion??2});
        if(invalid)throw Error(invalid);
        const f=value as TimesfmForecast;
        if(e.disposed || entries.get(e.key)!==e)return;
        // An old in-flight response cannot satisfy a more recent notification.
        if(f.ts<e.target)throw Error('generación aún no disponible');
        if(e.forecast && (f.ts<e.forecast.ts || (f.ts===e.forecast.ts && f.computedAt!<e.forecast.computedAt!)))throw Error('respuesta anterior');
        e.forecast=Object.freeze({...f,point:f.point?Object.freeze([...f.point]) as unknown as number[]:undefined,q10:Object.freeze([...f.q10]) as unknown as number[],q50:Object.freeze([...f.q50]) as unknown as number[],q90:Object.freeze([...f.q90]) as unknown as number[]});
        e.receivedAt=received;e.lastError=undefined;ready=true;
    } catch(err) { if(!e.disposed)e.lastError=err instanceof Error?err.message:String(err); }
    finally {
        e.cancel(timeout);e.running=false;e.controller=undefined;
        if(!e.disposed && (!ready || requestedTarget!==e.target))retry(e);
    }
}
/** Actual closed-bar boundary, not candle open. Unknown/unregistered TFs do nothing. */
export function notifyTimesfmCandleClosed(args: {ticker:string;tfMinutes:number;contextCloseTimeMs:number;bridgeUrl?:string}): void {
    for(const e of entries.values()){
        if(e.ticker!==args.ticker.toLowerCase() || e.tfMinutes!==args.tfMinutes || (args.bridgeUrl && e.cfg.bridgeUrl.replace(/\/$/,'')!==args.bridgeUrl.replace(/\/$/,'')))continue;
        const ts=args.contextCloseTimeMs;
        if(!Number.isSafeInteger(ts) || ts<=e.target || ts>e.now() || ts % (e.tfMinutes*60000)!==0)continue;
        e.target=ts;e.attempt=0;
        if(e.timer!==undefined){e.cancel(e.timer);e.timer=undefined;}
        void refresh(e);
    }
}
/** Synchronous RAM-only decision, even for cold start, stale or malformed input.
 * receivedAt is local observation availability: as-of reads cannot see later data. */
export function readTimesfmRamDecision(args: LiveTimesfmDecisionArgs, nowMs?: number): TimesfmDecision {
    const e=entries.get(keyOf(args));const now=nowMs??e?.now()??Date.now();
    if(!e?.forecast || e.receivedAt===undefined || e.receivedAt>now)return degradedTimesfmDecision('RAM sin forecast disponible');
    const invalid=validateTimesfmForecast(e.forecast,{ticker:args.ticker,tfMinutes:args.tfMinutes,nowMs:now,maxAgeMs:args.cfg.maxForecastAgeMs,strict:true,modelVersion:args.cfg.liveModelVersion??MODEL,schemaVersion:args.cfg.liveSchemaVersion??2});
    if(invalid)return degradedTimesfmDecision(invalid);
    if(!Number.isFinite(args.currentPrice)||!Number.isFinite(args.atr14)||args.atr14<=0||!Number.isFinite(args.smcPoints))return degradedTimesfmDecision('inputs inválidos');
    return evaluateTimesfmFilter(e.forecast,args.signalDir,args.currentPrice,args.atr14,args.smcPoints,args.cfg);
}
/** Drop-in Promise signature for the existing caller. RAM branch evaluates before
 * the Promise is returned and does not register, refresh, audit or touch I/O. */
export async function fetchLiveTimesfmDecision(args: LiveTimesfmDecisionArgs): Promise<TimesfmDecision> {
    if(args.cfg.liveTransport==='ram')return readTimesfmRamDecision(args);
    // ram_shadow deliberately returns the legacy result, with no strategy changes.
    return fetchLegacy(args);
}
export function resetTimesfmLiveCache(): void { for(const e of entries.values())discard(e);entries.clear(); }
export function getTimesfmLiveCacheStatus(): ReadonlyArray<{ticker:string;tfMinutes:number;target:number;forecastTs?:number;receivedAt?:number;running:boolean;attempt:number;lastError?:string}> {
    return [...entries.values()].map(e=>({ticker:e.ticker,tfMinutes:e.tfMinutes,target:e.target,forecastTs:e.forecast?.ts,receivedAt:e.receivedAt,running:e.running,attempt:e.attempt,lastError:e.lastError}));
}
