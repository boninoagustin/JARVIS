import type { RadarState } from './Types.js';
import type { ExecutionBar, ExecutionObservation, ExecutionQuote, ExecutionTickActivity, ExecutionImpulse, ExecutionFvg, ExecutionMarketSnapshot, ExecutionTfState, ExecutionContextState } from './ExecutionTypes.js';

const MAX_TOKEN = 16 * 1024;
const TF: Record<string,string> = { M5:'5', M15:'15', H1:'60', H4:'240', D1:'D', W1:'W', '5':'5', '15':'15', '60':'60', '240':'240', D:'D', W:'W' };
const DURATION: Record<string,number> = { '5':300000, '15':900000, '60':3600000, '240':14400000, D:86400000, W:604800000 };
const finite = (v:unknown):v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v:unknown):v is number => finite(v) && v > 0;
const time = (v:unknown):v is number => finite(v) && Number.isSafeInteger(v) && v >= 0;
function requireValid(ok:unknown, reason:string):asserts ok { if (!ok) throw new Error(reason); }
function timeframe(v:string):string { requireValid(typeof v === 'string' && Object.hasOwn(TF,v), 'invalid_timeframe'); return TF[v]; }
function validateBar(b:ExecutionBar, tf:string, now:number):ExecutionBar {
    requireValid(b && timeframe(b.tf) === tf, 'bar_timeframe_mismatch');
    requireValid(time(b.openTimeMs) && time(b.closeTimeMs) && time(b.availableAtMs) && b.closeTimeMs-b.openTimeMs===DURATION[tf] && b.openTimeMs<=b.availableAtMs && b.availableAtMs<=now, 'invalid_bar_availability');
    requireValid(typeof b.closed==='boolean' && (!b.closed || b.closeTimeMs<=b.availableAtMs), 'invalid_closed_bar');
    requireValid(b.closed || b.availableAtMs<b.closeTimeMs, 'expired_forming_bar');
    requireValid([b.open,b.high,b.low,b.close].every(positive) && b.high>=b.low && b.high>=Math.max(b.open,b.close) && b.low<=Math.min(b.open,b.close), 'invalid_ohlc');
    return {...b,tf};
}
export function buildExecutionObservation(input:{ticker:string;tf:string;observedAtMs:number;bar?:ExecutionBar;previousClosedBar?:ExecutionBar;breakBar?:ExecutionBar;quote?:ExecutionQuote;tickActivity?:ExecutionTickActivity;impulse?:ExecutionImpulse;fvgs?:ExecutionFvg[]}):ExecutionObservation {
    requireValid(input && typeof input.ticker==='string' && /^[A-Za-z0-9_. /-]{1,64}$/.test(input.ticker), 'invalid_ticker');
    const tf=timeframe(input.tf), now=input.observedAtMs;
    requireValid(time(now), 'invalid_observation_time');
    const result:ExecutionObservation={schema:1,ticker:input.ticker,tf,observedAtMs:now};
    for (const key of ['bar','previousClosedBar','breakBar'] as const) if (input[key]!==undefined) {
        result[key]=validateBar(input[key]!,tf,now);
        requireValid(key==='bar' || result[key]!.closed, 'expected_closed_bar');
    }
    if (result.previousClosedBar && result.bar) requireValid(result.previousClosedBar.closeTimeMs<=result.bar.openTimeMs, 'previous_bar_overlap');
    if (input.quote!==undefined) {
        const q=input.quote;
        requireValid(q && positive(q.bid) && positive(q.ask) && q.bid<=q.ask && time(q.timestampMs) && q.timestampMs<=now && (q.source==='broker'||q.source==='modeled'), 'invalid_quote');
        result.quote={...q};
    }
    if (input.tickActivity!==undefined) {
        const t=input.tickActivity;
        requireValid(t && positive(t.ratio) && ['UP','DOWN','FLAT'].includes(t.direction) && time(t.timestampMs) && t.timestampMs<=now && Number.isSafeInteger(t.sampleCount) && t.sampleCount>0 && t.source==='broker_ticks','invalid_tick_activity');
        result.tickActivity={...t};
    }
    if (input.impulse!==undefined) {
        const i=input.impulse;
        requireValid(i && ['BUY','SELL'].includes(i.direction) && positive(i.origin) && positive(i.extreme) && (i.direction==='BUY'?i.extreme>i.origin:i.extreme<i.origin) && time(i.createdAtMs) && i.createdAtMs<=now,'invalid_impulse');
        result.impulse={...i};
    }
    if (input.fvgs!==undefined) {
        requireValid(Array.isArray(input.fvgs) && input.fvgs.length<=100,'invalid_fvgs');
        result.fvgs=input.fvgs.map(f=>{
            requireValid(f && typeof f.id==='string' && f.id.length>0 && f.id.length<=128 && timeframe(f.tf)===tf && ['BUY','SELL'].includes(f.direction) && positive(f.top) && positive(f.bottom) && f.top>f.bottom && typeof f.active==='boolean' && time(f.createdAtMs) && time(f.availableAtMs) && time(f.impulseCreatedAtMs) && f.impulseCreatedAtMs<=f.createdAtMs && f.createdAtMs<=f.availableAtMs && f.availableAtMs<=now,'invalid_fvg');
            requireValid(result.impulse && f.direction===result.impulse.direction && f.impulseCreatedAtMs===result.impulse.createdAtMs && f.bottom>=Math.min(result.impulse.origin,result.impulse.extreme) && f.top<=Math.max(result.impulse.origin,result.impulse.extreme),'unlinked_fvg');
            return {...f,tf};
        });
    }
    return result;
}
export function appendExecutionEnvelope(text:string,observation:ExecutionObservation):string {
    requireValid(observation.schema===1,'invalid_schema');
    const clean=buildExecutionObservation(observation);
    const bytes=new TextEncoder().encode(JSON.stringify(clean));
    let binary=''; for (const b of bytes) binary+=String.fromCharCode(b);
    const token=btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    requireValid(token.length<=MAX_TOKEN,'envelope_too_large');
    return `${text} | EX1: ${token}`;
}
export function parseExecutionEnvelope(line:string,nowMs:number):{text:string;observation?:ExecutionObservation;reason?:string} {
    const index=line.lastIndexOf(' | EX1:');
    if (index<0) return {text:line};
    const text=line.slice(0,index), token=line.slice(index+7).trim();
    try {
        requireValid(time(nowMs),'invalid_now');
        requireValid(token.length>0 && token.length<=MAX_TOKEN && /^[A-Za-z0-9_-]+$/.test(token),'invalid_envelope');
        const binary=atob(token.replace(/-/g,'+').replace(/_/g,'/'));
        const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0))));
        requireValid(value.schema===1,'invalid_schema');
        const observation=buildExecutionObservation(value);
        requireValid(observation.observedAtMs<=nowMs,'future_observation');
        return {text,observation};
    } catch (e) { return {text,reason:e instanceof Error?e.message:'invalid_envelope'}; }
}

// Retain a compact OHLC fingerprint for every observed close, including older
// duplicates. Plain JSON keeps conflict detection intact across persistence.
type StoredTf = ExecutionTfState & { closedFingerprints?:Record<string,string>; observedAtMs?:number };
function validateAtrState(s:StoredTf):void {
    requireValid(s && finite(s.atrSeed) && s.atrSeed>=0 && Number.isInteger(s.atrSamples) && s.atrSamples>=0 && s.atrSamples<=14
        && (s.atr14===undefined ? s.atrSamples<14 : finite(s.atr14) && s.atr14>=0 && s.atrSamples===14)
        && (s.previousClose===undefined || positive(s.previousClose)), 'invalid_atr_state');
}
function fingerprint(b:ExecutionBar):string { return JSON.stringify([b.tf,b.openTimeMs,b.closeTimeMs,b.open,b.high,b.low,b.close]); }
function ingestClose(s:StoredTf,b:ExecutionBar):void {
    const id=String(b.openTimeMs), hash=fingerprint(b);
    s.closedFingerprints ??= {};
    const known=s.closedFingerprints[id];
    requireValid(known===undefined || known===hash,'conflicting_closed_bar');
    if (known!==undefined || (s.lastClosedBar && b.openTimeMs<=s.lastClosedBar.openTimeMs)) return;
    s.closedFingerprints[id]=hash;
    const contiguous=s.lastClosedBar?.closeTimeMs===b.openTimeMs;
    if (!contiguous) { s.atrSeed=0; s.atrSamples=0; delete s.atr14; }
    if (contiguous && positive(s.previousClose)) {
        const tr=Math.max(b.high-b.low,Math.abs(b.high-s.previousClose),Math.abs(b.low-s.previousClose));
        requireValid(finite(tr) && tr>=0,'nonfinite_atr_true_range');
        if (s.atrSamples<14) {
            const seed=s.atrSeed+tr;
            requireValid(finite(seed),'nonfinite_atr_seed');
            s.atrSeed=seed; s.atrSamples++; if (s.atrSamples===14) s.atr14=seed/14;
        }
        else if (s.atr14!==undefined) {
            const atr=(13*s.atr14+tr)/14;
            requireValid(finite(atr),'nonfinite_atr_recurrence');
            s.atr14=atr;
        }
    }
    s.previousClose=b.close; s.lastClosedBar={...b};
    if (s.currentBar && s.currentBar.openTimeMs<=b.openTimeMs) delete s.currentBar;
}
export function ingestExecutionContext(state:RadarState,observation:ExecutionObservation,nowMs:number):{accepted:boolean;reason:string} {
    try {
        requireValid(time(nowMs) && observation.schema===1,'invalid_schema_or_now');
        const o=buildExecutionObservation(observation);
        requireValid(o.observedAtMs<=nowMs,'future_observation');
        const old=state.executionContext;
        requireValid(!old || old.ticker===o.ticker,'ticker_mismatch');
        // Validate before the JSON copy: JSON would otherwise turn Infinity/NaN
        // into null and a later arithmetic update could silently treat it as zero.
        if (old) for (const stored of Object.values(old.byTf)) validateAtrState(stored);
        // Work on a copy: a conflicting duplicate or derived overflow cannot
        // partially update ATR, quote, or an earlier bar in this observation.
        const next:ExecutionContextState=old?JSON.parse(JSON.stringify(old,(_key,value)=>{
            requireValid(typeof value!=='number' || finite(value),'nonfinite_execution_context');
            return value;
        })):{schema:1,ticker:o.ticker,byTf:{},lastObservedAtMs:o.observedAtMs};
        const s:StoredTf=next.byTf[o.tf]??{atrSeed:0,atrSamples:0};
        const closed=[o.previousClosedBar,o.bar?.closed?o.bar:undefined,o.breakBar].filter((b):b is ExecutionBar=>!!b).sort((a,b)=>a.openTimeMs-b.openTimeMs);
        for (const b of closed) ingestClose(s,b);
        if ((s.observedAtMs??-1)<=o.observedAtMs) {
            if (o.bar && !o.bar.closed && (!s.lastClosedBar || o.bar.openTimeMs>s.lastClosedBar.openTimeMs) && (!s.currentBar || o.bar.openTimeMs>=s.currentBar.openTimeMs)) s.currentBar={...o.bar};
            if (o.breakBar && (!s.breakBar || o.breakBar.openTimeMs>=s.breakBar.openTimeMs)) s.breakBar={...o.breakBar};
            if (o.impulse) { s.impulse={...o.impulse}; s.fvgs=o.fvgs?.map(f=>({...f})); }
            else if (o.fvgs) s.fvgs=o.fvgs.map(f=>({...f}));
            s.observedAtMs=o.observedAtMs;
        }
        if (o.quote && (!next.quote || o.quote.timestampMs>=next.quote.timestampMs)) next.quote={...o.quote};
        if (o.tickActivity && (!next.tickActivity || o.tickActivity.timestampMs>=next.tickActivity.timestampMs)) next.tickActivity={...o.tickActivity};
        next.byTf[o.tf]=s; next.lastObservedAtMs=Math.max(next.lastObservedAtMs,o.observedAtMs);
        state.executionContext=next;
        return {accepted:true,reason:'accepted'};
    } catch(e) { return {accepted:false,reason:e instanceof Error?e.message:'invalid_observation'}; }
}
export function getExecutionSnapshot(state:RadarState,tf:string,nowMs:number):ExecutionMarketSnapshot|undefined {
    try {
        tf=timeframe(tf);
        if (!time(nowMs)) return undefined;
        const c=state.executionContext, s=c?.byTf[tf] as StoredTf|undefined;
        if (!c || !s || c.lastObservedAtMs>nowMs || (s.observedAtMs??0)>nowMs) return undefined;
        validateAtrState(s);
        const latest=s.currentBar??s.lastClosedBar;
        if (!latest || latest.availableAtMs>nowMs || nowMs-latest.availableAtMs>2*DURATION[tf]) return undefined;
        const result:ExecutionMarketSnapshot={ticker:c.ticker,tf,observedAtMs:s.observedAtMs??c.lastObservedAtMs};
        if (s.currentBar && s.currentBar.openTimeMs<=nowMs && nowMs<s.currentBar.closeTimeMs) result.bar={...s.currentBar};
        else if (s.lastClosedBar) result.bar={...s.lastClosedBar};
        if (s.lastClosedBar && s.lastClosedBar.availableAtMs<=nowMs && nowMs-s.lastClosedBar.closeTimeMs<=2*DURATION[tf]) { result.closedBar={...s.lastClosedBar}; if (positive(s.atr14)) result.atr14=s.atr14; }
        if (s.breakBar && s.breakBar.availableAtMs<=nowMs && s.breakBar.openTimeMs===s.lastClosedBar?.openTimeMs) result.breakBar={...s.breakBar};
        if (c.quote && c.quote.timestampMs<=nowMs && nowMs-c.quote.timestampMs<=10000) result.quote={...c.quote};
        if (c.tickActivity && c.tickActivity.timestampMs<=nowMs && nowMs-c.tickActivity.timestampMs<=10000) result.tickActivity={...c.tickActivity};
        if (s.impulse && s.impulse.createdAtMs<=nowMs) result.impulse={...s.impulse};
        if (s.fvgs) result.fvgs=s.fvgs.filter(f=>f.active && f.availableAtMs<=nowMs && f.tf===tf && f.impulseCreatedAtMs===s.impulse?.createdAtMs).map(f=>({...f}));
        return result;
    } catch { return undefined; }
}
