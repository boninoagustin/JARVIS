import assert from 'node:assert/strict';
import { CTraderConnection, CTraderTrading, PayloadType } from 'ctrader-ts';
import * as safety from '../../src/engine/OrderSafety.js';
import { decodeMessage, encodeMessage } from '../../node_modules/ctrader-ts/dist/src/protocol/codec.js';

// Real installed SDK queue, retry loop, protobuf codec and response correlation.
// Only the TLS socket is replaced; this suite never connects to a broker.
const dispatch=(safety as any).authorizedBrokerRequest??((c:any,t:number,p:any,check:()=>string|null)=>{const b=check();if(b)throw new Error(b);return c.request(t,p);});
function wire(rejectFirst=false) {
    const c:any=new CTraderConnection({host:'OFFLINE.invalid',requestTimeoutMs:2000});const writes:any[]=[];
    c.socket={destroyed:false,write(frame:Buffer){const m=decodeMessage(frame.subarray(4));writes.push(m);
        queueMicrotask(()=>c.handleData(encodeMessage(rejectFirst&&writes.length===1?PayloadType.OA_ERROR_RES:PayloadType.APP_AUTH_RES,
            rejectFirst&&writes.length===1?{ctidTraderAccountId:1,errorCode:'REQUEST_FREQUENCY_EXCEEDED',description:'test'}:{ctidTraderAccountId:1},m.clientMsgId)));return true;}};
    const adapter:any={request:(t:number,p:any)=>dispatch(c,t,p,()=>null)};
    const trading=new CTraderTrading(adapter,1);
    return {c,writes,trading,adapter};
}
const order={symbolId:1,tradeSide:1,volume:100,baseSlippagePrice:100,slippageInPoints:1,label:'offline',stopLoss:90};
const cases:[string,()=>Promise<void>][]=[
 ['SDK queued write cannot outlive its authorization',async()=>{
    const h=wire();h.c.inFlightRequests=5;
    const result=h.trading.marketRangeOrder(order).then(()=>null,e=>e);
    const now=Date.now;try{Date.now=()=>now()+60000;h.c.inFlightRequests=0;h.c.drainQueue();const error=await result;
        assert.ok(error,'queued authorization must not become a delayed broker write');assert.equal(h.writes.length,0);
    }finally{Date.now=now;}
 }],
 ['SDK rate-limit retry never resubmits the same authorized order',async()=>{
    const h=wire(true);const delay=(CTraderConnection as any).INITIAL_RETRY_DELAY_MS;(CTraderConnection as any).INITIAL_RETRY_DELAY_MS=1;
    try{const error=await h.trading.marketRangeOrder(order).then(()=>null,e=>e);assert.ok(error,'broker rate-limit retry must require new authorization, not silently resend');assert.equal(h.writes.length,1);}finally{(CTraderConnection as any).INITIAL_RETRY_DELAY_MS=delay;}
 }],
 ['actual dispatch revalidates and leaves unrelated readonly requests intact',async()=>{
    const h=wire();let checks=0;
    h.adapter.request=(t:number,p:any)=>dispatch(h.c,t,p,()=>++checks===1?null:'BLOCKED_ACCOUNT_STATE');
    const error=await h.trading.marketRangeOrder(order).then(()=>null,e=>e);assert.ok(error,'admission alone is not dispatch authorization');assert.equal(h.writes.length,0);
    await h.c.request(PayloadType.TRADER_REQ,{ctidTraderAccountId:1});assert.equal(h.writes.length,1);assert.equal(checks,2);assert.equal(h.c.inFlightRequests,0);
 }],
 ['concurrent scoped authorizations do not replace one another',async()=>{
    const h=wire();
    const first=h.trading.marketRangeOrder(order);const second=h.trading.marketRangeOrder({...order,label:'other'}).then(()=>null,e=>e);
    await first;assert.ok(await second,'second write must not queue behind the first');assert.equal(h.writes.length,1);assert.equal(h.c.inFlightRequests,0);
 }],
 ['preparation waits outside SDK queue and rechecks authorization while waiting',async()=>{
    const h=wire();h.c.lastRequestSentAt=Date.now();let checks=0;
    const denied=await safety.prepareBrokerDispatch(h.c,async()=>++checks>=2?'BLOCKED_ACCOUNT_STATE':null);
    assert.equal(denied,'BLOCKED_ACCOUNT_STATE');assert.ok(checks>=2);
    assert.equal(h.writes.length,0);assert.equal(h.c.requestQueue.length,0);
 }],
 ['busy dispatcher times out without ever enqueuing a mutation',async()=>{
    const h=wire();h.c.inFlightRequests=5;const started=performance.now();
    const denied=await safety.prepareBrokerDispatch(h.c,async()=>null,40);
    assert.match(denied!,/timed out before submission/);assert.ok(performance.now()-started<500);
    assert.equal(h.writes.length,0);assert.equal(h.c.requestQueue.length,0);
    h.c.inFlightRequests=0;h.c.drainQueue();assert.equal(h.writes.length,0,'nothing remains to send after timeout');
 }],
 ['saturated concurrency cannot spin authorization checks every millisecond',async()=>{
    const h=wire();h.c.inFlightRequests=5;let checks=0;
    const denied=await safety.prepareBrokerDispatch(h.c,async()=>{checks++;return null;},100);
    assert.match(denied!,/timed out/);assert.ok(checks<=8,`busy admission rechecked ${checks} times in 100ms`);
    assert.equal(h.writes.length,0);
 }],
 ['slow authorization cannot admit a ready dispatcher past its deadline',async()=>{
    const h=wire();const started=performance.now();
    const denied=await safety.prepareBrokerDispatch(h.c,async()=>{await new Promise(r=>setTimeout(r,60));return null;},20);
    assert.match(denied!,/timed out before submission/);assert.ok(performance.now()-started<250);
    assert.equal(h.writes.length,0);assert.equal(h.c.requestQueue.length,0);
 }],
 ['unresolved authorization cannot leave preparation pending indefinitely',async()=>{
    const h=wire();
    const denied=await Promise.race([safety.prepareBrokerDispatch(h.c,()=>new Promise(()=>{}),20),new Promise<string>(r=>setTimeout(()=>r('HUNG'),200))]);
    assert.match(denied!,/timed out before submission/);assert.equal(h.writes.length,0);
 }],
 ['unknown SDK state and invalid clock fail closed during preparation',async()=>{
    for(const change of [()=>undefined,()=>NaN,()=>Date.now()+60000]) {
        const h=wire();h.c.lastRequestSentAt=change();
        assert.match((await safety.prepareBrokerDispatch(h.c,async()=>null))!,/BLOCKED_DISPATCH/);
        assert.equal(h.writes.length,0);
    }
 }],
 ['invalid preparation wait bounds cannot admit an order',async()=>{
    for(const bound of [-1,NaN,Infinity,1001]) {
        const h=wire();assert.match((await safety.prepareBrokerDispatch(h.c,async()=>null,bound))!,/invalid admission wait bound/);
        assert.equal(h.writes.length,0);
    }
 }],
];
let failures=0;for(const [name,fn]of cases){try{await fn();console.log('PASS',name);}catch(e){failures++;console.error('FAIL',name,e);}}
assert.equal(failures,0);console.log(`ORDER_SAFETY_DISPATCH: ${cases.length} PASS`);
