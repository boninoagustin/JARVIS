/** Live order safety, independent of strategy/profile and broker I/O. */
import { CTraderError } from 'ctrader-ts';
/** Only explicit admission/trading refusals prove no fill. Server timeouts and
 * unknown API codes retain ambiguity even though they also use CTraderError. */
export function isAuthoritativeBrokerRejection(error:any):boolean {
    return error instanceof CTraderError && new Set(['NOT_ENOUGH_MONEY','INVALID_VOLUME','TRADING_BAD_VOLUME','TRADING_BAD_STOPS',
        'MARKET_CLOSED','SYMBOL_NOT_FOUND','TRADING_DISABLED','NOT_SUPPORTED','REQUEST_FREQUENCY_EXCEEDED','BLOCKED_PAYLOAD_TYPE',
        'OA_AUTH_TOKEN_EXPIRED','ACCOUNT_NOT_AUTHORIZED','CH_CLIENT_AUTH_FAILURE','CH_CLIENT_NOT_AUTHENTICATED',
        'CH_ACCESS_TOKEN_INVALID','OAUTH_TOKEN_INVALIDATED','SERVER_IS_UNDER_MAINTENANCE']).has(error.code);
}
/** Cost of acquiring quote-currency liability in deposit currency. Direct ask,
 * inverse bid: these are NOT liquidation/profit conversion rates. */
export function lossConversionRate(quoteCurrency:string|undefined,accountCurrency:string,assets:Map<number,string>,metadata:Map<string,any>,getQuote:(ticker:string,nowMs:number)=>{bid:number;ask:number;ts:number}|null,nowMs:number):number|undefined {
    if (!quoteCurrency || !accountCurrency) return undefined;
    if (quoteCurrency===accountCurrency) return 1;
    const rates:number[]=[];
    for(const [ticker,meta] of metadata) {
        const base=assets.get(meta.baseAssetId),quote=assets.get(meta.quoteAssetId);
        if (!((base===quoteCurrency&&quote===accountCurrency)||(base===accountCurrency&&quote===quoteCurrency))) continue;
        const q=getQuote(ticker,nowMs);
        if (!q || ![q.bid,q.ask,q.ts].every(Number.isFinite) || q.bid<=0 || q.ask<q.bid || q.ts>nowMs || nowMs-q.ts>10000) continue;
        rates.push(base===quoteCurrency?q.ask:1/q.bid);
    }
    return rates.length?Math.max(...rates):undefined;
}
export function validateBrokerOrderMetadata(meta:any,nowMs:number):string|null {
    if (!meta || ![meta.symbolId,meta.lotSize,meta.minVolume,meta.maxVolume,meta.stepVolume,meta.quoteAssetId].every(v=>Number.isSafeInteger(v)&&v>0)
        || !Number.isInteger(meta.digits)||meta.digits<0||meta.digits>10
        || !Number.isInteger(meta.pipPosition)||meta.pipPosition<0||meta.pipPosition>meta.digits
        || !Number.isFinite(meta.safetyFetchedAtMs)||meta.safetyFetchedAtMs>nowMs||nowMs-meta.safetyFetchedAtMs>300000) return 'BLOCKED_METADATA: missing, invalid or expired broker units';
    return null;
}
export interface OrderCommission { perCentAccount:number; minSideAccount:number; known:boolean }
/** Protocol precise rates only; unknown costs remain explicit, never inferred
 * from a prior exit (which would prevent a first trade on an instrument). */
export function orderCommission(meta:any,maxPrice:number,quoteCurrency:string,accountCurrency:string,rate:(from:string,to:string)=>number|undefined):OrderCommission|undefined {
    let perCentAccount=0,minSideAccount=0;
    const raw=meta.preciseTradingCommissionRate;
    // Official model-messages documents only precise field units (rate 1e8,
    // percentage 1e5; minimum 1e8). Never guess legacy scaling or let a
    // contradictory precise zero erase a documented positive legacy charge.
    for (const [legacy,precise] of [[meta.commission,raw],[meta.minCommission,meta.preciseMinCommission]]) {
        if (legacy!=null && (typeof legacy!=='number'||!Number.isFinite(legacy)||legacy<0)) return undefined;
        if (legacy>0 && !(typeof precise==='number'&&Number.isFinite(precise)&&precise>0)) return undefined;
    }
    const known=typeof raw==='number'&&Number.isFinite(raw)&&raw>=0;
    if (raw!=null && !known) return undefined;
    if (known && raw>0) {
        let amount:number,currency:string;
        switch(meta.commissionType) {
            case 2: amount=raw/1e8/meta.lotSize;currency='USD';break;
            case 4: amount=raw/1e8/meta.lotSize;currency=quoteCurrency;break;
            case 3: amount=raw/1e5/100*maxPrice/100;currency=quoteCurrency;break;
            case 1: {
                const toUsd=rate(quoteCurrency,'USD');if (toUsd===undefined) return undefined;
                amount=raw/1e8*(maxPrice/100*toUsd)/1e6;currency='USD';break;
            }
            default:return undefined;
        }
        const fx=rate(currency,accountCurrency);if(fx===undefined) return undefined;
        perCentAccount=amount*fx;
    }
    if(meta.preciseMinCommission!=null) {
        if(typeof meta.preciseMinCommission!=='number'||!Number.isFinite(meta.preciseMinCommission)||meta.preciseMinCommission<0) return undefined;
        if(meta.preciseMinCommission>0) {
            const currency=meta.minCommissionType===2?quoteCurrency:meta.minCommissionType===1?(meta.minCommissionAsset??'USD'):undefined;
            const fx=currency?rate(currency,accountCurrency):undefined;if(fx===undefined) return undefined;
            minSideAccount=meta.preciseMinCommission/1e8*fx;
        }
    }
    return {perCentAccount,minSideAccount,known};
}
export function sizeOrderVolume(input: {equity:number;riskPercent:number;worstEntry:number;sl:number;rate:number;meta:any;commission?:OrderCommission}): {ok:true;volume:number;budget:number}|{ok:false;error:string} {
    const {equity,riskPercent,worstEntry,sl,rate,meta}=input;
    const positive=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>0;
    if (![equity,riskPercent,worstEntry,sl,rate].every(positive) || riskPercent>100 || !meta || ![meta.lotSize,meta.minVolume,meta.maxVolume,meta.stepVolume].every(n=>Number.isSafeInteger(n)&&n>0) || meta.minVolume>meta.maxVolume) return {ok:false,error:'BLOCKED_METADATA: unverifiable broker units or risk budget'};
    const budget=equity*Math.min(riskPercent,3)/100; // Preserve legacy live hard ceiling, including overrides.
    const perCent=Math.abs(worstEntry-sl)/100*rate;
    if (!positive(perCent)) return {ok:false,error:'BLOCKED_RISK: invalid price risk'};
    // Protocol volume is cents of base units. lotSize only converts display lots;
    // no universal contract size, dollar-per-pip or asset-name heuristics.
    const costs=input.commission??{perCentAccount:0,minSideAccount:0,known:false};
    if (![costs.perCentAccount,costs.minSideAccount].every(n=>Number.isFinite(n)&&n>=0)) return {ok:false,error:'BLOCKED_COST: invalid commission'};
    const maxByRisk=Math.min(budget/(perCent+2*costs.perCentAccount),(budget-2*costs.minSideAccount)/perCent);
    let volume=Math.floor(Math.min(maxByRisk,meta.maxVolume)/meta.stepVolume)*meta.stepVolume;
    if (volume*perCent+2*Math.max(costs.minSideAccount,volume*costs.perCentAccount)>budget) volume-=meta.stepVolume;
    if (!Number.isSafeInteger(volume)||volume<meta.minVolume) return {ok:false,error:'BLOCKED_MIN_VOLUME: never force or round up'};
    return {ok:true,volume,budget};
}

/** Await dispatcher readiness BEFORE freezing the order payload. Nothing is
 * submitted to the SDK queue, and every wakeup rechecks entry authorization.
 * Keep the atomic send guard below: another caller can still win the slot. */
export async function prepareBrokerDispatch(connection:any,revalidate?:()=>Promise<string|null>,maxWaitMs=1000):Promise<string|null> {
    if (!Number.isFinite(maxWaitMs)||maxWaitMs<0||maxWaitMs>1000) return 'BLOCKED_DISPATCH: invalid admission wait bound';
    const started=performance.now();
    const known=()=>connection && Number.isInteger(connection.inFlightRequests)&&connection.inFlightRequests>=0
        && Array.isArray(connection.requestQueue)&&Number.isFinite(connection.lastRequestSentAt)
        && typeof connection.send==='function'&&typeof connection.request==='function';
    const timeout='BLOCKED_DISPATCH: admission wait timed out before submission';
    while (true) {
        if (!known()) return 'BLOCKED_DISPATCH: SDK dispatcher is unverified';
        const callbackBudget=maxWaitMs-(performance.now()-started);
        if (callbackBudget<=0) return timeout;
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {
            const denied=revalidate ? await Promise.race([
                Promise.resolve().then(revalidate),
                new Promise<string>(resolve=>{timer=setTimeout(()=>resolve(timeout),callbackBudget);}),
            ]) : null;
            if (denied) return denied;
        } finally { if (timer!==undefined) clearTimeout(timer); }
        if (!known()) return 'BLOCKED_DISPATCH: SDK dispatcher changed during preparation';
        const remaining=maxWaitMs-(performance.now()-started);
        if (remaining<=0) return timeout;
        const age=Date.now()-connection.lastRequestSentAt;
        if (age<0) return 'BLOCKED_DISPATCH: invalid dispatcher clock';
        if (connection.inFlightRequests<5 && connection.requestQueue.length===0 && age>=50) return null;
        await new Promise(resolve=>setTimeout(resolve,Math.min(remaining,age<50?Math.max(1,Math.min(25,50-age)):25)));
    }
}

/** Per-connection, per-payload guards: no temporary global monkeypatch and no
 * shared current-order callback. Installed SDK 1.0.1 calls send synchronously
 * from requestOnce after queue/rate-limit delays. Reads remain untouched. */
const brokerDispatchGuards = new WeakMap<object, WeakMap<object, () => void>>();
export async function authorizedBrokerRequest(connection:any,payloadType:number,payload:any,validate:()=>string|null,options:{allowQueue?:boolean;authorizationTtlMs?:number;authorizeAtDispatch?:()=>string|null}={}):Promise<any> {
    const blocked=(reason:string)=>Object.assign(new Error(reason),{brokerNotSubmitted:true});
    const initial=validate();if(initial) throw blocked(initial);
    // Atomic admission: this exact SDK would otherwise queue or set a timer.
    // Unknown dispatcher shape is not authorization to perform a live write.
    if (!Number.isInteger(connection.inFlightRequests)||connection.inFlightRequests<0
        || !Array.isArray(connection.requestQueue)||!Number.isFinite(connection.lastRequestSentAt)
        || (!options.allowQueue && (connection.inFlightRequests>=5||connection.requestQueue.length!==0||Date.now()-connection.lastRequestSentAt<50))
        || typeof connection.send!=='function'||typeof connection.request!=='function') throw blocked('BLOCKED_DISPATCH: broker write would queue or SDK dispatcher is unverified');
    let guards=brokerDispatchGuards.get(connection);
    if (!guards) {
        guards=new WeakMap();brokerDispatchGuards.set(connection,guards);
        const send=connection.send;
        connection.send=function(type:number,body:any) {
            guards!.get(body)?.();
            return send.call(this,type,body);
        };
    }
    const authorizedAt=Date.now();let dispatched=false;
    guards.set(payload,()=>{
        if(dispatched) throw new Error('BLOCKED_DISPATCH: automatic order retry forbidden');
        if(Date.now()<authorizedAt||Date.now()-authorizedAt>(options.authorizationTtlMs??1000)) throw blocked('BLOCKED_DISPATCH: authorization expired');
        const reason=validate();if(reason) throw blocked(reason);
        // A consumable capability is distinct from repeatable state validation.
        // Consume it only at the socket boundary, after any SDK queue wait.
        const authorization=options.authorizeAtDispatch?.();if(authorization) throw blocked(authorization);
        dispatched=true;
    });
    try {
        // The installed SDK exposes its queued single-attempt dispatcher. A
        // mutation must surface the first authoritative rejection, not enter the
        // SDK's automatic rate-limit retry loop and lose that evidence.
        return await (typeof connection.requestOnce==='function'
            ? connection.requestOnce(payloadType,payload) : connection.request(payloadType,payload));
    }
    finally { guards.delete(payload); }
}

export function validateOrderLevels(direction: 'BUY' | 'SELL', entry: number, sl: number, tp1: number, tp2?: number, minimumRR?: number): string | null {
    const sign=direction==='BUY'?1:direction==='SELL'?-1:0;
    if (!sign || ![entry,sl,tp1].every(v=>Number.isFinite(v)&&v>0) || (tp2!==undefined && (!Number.isFinite(tp2)||tp2<=0))) return 'BLOCKED_LEVELS: invalid price/direction';
    if (sign*(entry-sl)<=0) return 'BLOCKED_STOPS: wrong side of executable entry';
    if (sign*(tp1-entry)<=0 || (tp2!==undefined && (sign*(tp2-entry)<=0 || sign*(tp2-tp1)<0))) return 'BLOCKED_TARGETS: TP1/TP2 direction or ordering';
    if (minimumRR!==undefined && (!Number.isFinite(minimumRR)||minimumRR<0 || Math.abs((tp2??tp1)-entry)/Math.abs(entry-sl)<minimumRR)) return 'BLOCKED_RR: supplied minimumRR';
    return null;
}
