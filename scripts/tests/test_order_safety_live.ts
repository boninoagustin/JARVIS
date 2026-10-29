import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { CTraderConnection, CTraderTrading, PayloadType } from 'ctrader-ts';
import { decodeMessage, encodeMessage } from '../../node_modules/ctrader-ts/dist/src/protocol/codec.js';

// No service imports: execute the actual production function, isolating network,
// credentials, telemetry and persistence behind a recording in-memory broker.
const file='src/services/ctrader.ts';
const source=fs.readFileSync(file,'utf8');
const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
const selected=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='executeMarketOrder');
assert.equal(selected.length,1);
const body=ts.transpileModule(selected[0].getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const tradeRisk=await import('../../src/engine/TradeRisk.js');
const safety:any=fs.existsSync('src/engine/OrderSafety.ts')?await import('../../src/engine/OrderSafety.js'):{};
export function harness(overrides:any={}) {
    const sent:any[]=[],closed:any[]=[];
    let quote={bid:100,ask:101,ts:Date.now()};
    const info:any={safetyFetchedAtMs:Date.now(),symbolId:1,lotSize:10000,minVolume:100,stepVolume:100,maxVolume:10000000,digits:2,pipPosition:2,baseAssetId:1,quoteAssetId:2,slDistance:0,distanceSetIn:1};
    let position:any;
    const params:any={ticker:'TEST',direction:'BUY',entryPrice:100,slPrice:90,tp1Price:120,tp2Price:130,riskPercent:1,tradeId:'OFFLINE',rolloverEntryBlock:false};
    const ctx:any={...safety,CTraderTrading,PayloadType,createTradeRiskSnapshot:tradeRisk.createTradeRiskSnapshot,exports:{},console:{log(){},warn(){},error(){}},Date,Number,Math,Promise,setTimeout:(fn:any)=>{fn();return 0;},
        config:{CTRADER_RISK_PERCENT:1,CTRADER_MAX_POSITIONS:10,CTRADER_MARKET_RANGE:true,CTRADER_MAX_SLIPPAGE_PIPS:1},
        db:null,isCTraderReady:()=>true,connectCTrader:async()=>true,
        getAccountInfo:async()=>({equity:1000,currency:'USD'}),accountCurrency:'USD',executionAccountCurrencyVerified:true,
        detectAccountCurrency:async()=>{ctx.accountCurrency='USD';ctx.executionAccountCurrencyVerified=true;return 'USD';},
        executionSymbolMetadata:new Map([['TEST',info]]),executionAssetNames:new Map([[1,'BASE'],[2,'USD']]),
        getSymbolInfo:async()=>info,mapToCTraderSymbol:(s:string)=>s,getSymbolDigits:async()=>info.digits,
        calculateLotSize:()=>.04,lastBidAsk:new Map(),getLastBidAsk:()=>quote,
        tickFlow:{getStructuralSpread:()=>0,getSpread:()=>0},
        notifyRolloverVerifiedFill:async()=>{},
        confirmOrderFilled:async()=>({rejected:false,deal:{dealStatus:2,executionPrice:position?.price,volume:position?.tradeData.volume,filledVolume:position?.tradeData.volume,tradeSide:1}}),
        verifyPositionProtection:async()=>true,
        closePosition:async(id:any)=>{closed.push(id);position=undefined;return true;},
    };
    const send=async(payload:any)=>{sent.push(payload);position={positionId:42,price:payload.baseSlippagePrice??quote.ask,stopLoss:payload.stopLoss,takeProfit:payload.takeProfit,tradeData:{symbolId:1,volume:payload.volume,tradeSide:payload.tradeSide}};return {position,deal:{dealStatus:2,executionPrice:position.price}};};
    ctx.ctClient={getState:async()=>({positions:position?[position]:[],orders:[]}),raw:{trading:{marketRangeOrder:send,marketOrder:send}},close:async(id:any)=>{closed.push(id);position=undefined;}};
    ctx.ctClient.connection={inFlightRequests:0,requestQueue:[],lastRequestSentAt:0,
        send:(type:number,payload:any)=>ctx.ctClient.raw.trading.marketRangeOrder(payload),
        request:function(type:number,payload:any){return this.send(type,payload);}};
    Object.assign(ctx,overrides);
    ctx.lastBidAsk.set('TEST',quote);
    vm.runInNewContext(body,ctx);
    return {ctx,params,info,sent,closed,run:()=>ctx.exports.executeMarketOrder(params),quote:(q:any)=>{quote=q;ctx.lastBidAsk.set(params.ticker,q);},position:()=>position,setPosition:(p:any)=>{position=p;}};
}
const cases:[string,()=>Promise<void>][]=[];
function test(name:string,fn:()=>Promise<void>){cases.push([name,fn]);}

test('XPT live ask invalidates TP1 before raw broker write',async()=>{
    const h=harness();Object.assign(h.params,{ticker:'XPTUSD',entryPrice:1632.435,slPrice:1623.25698,tp1Price:1641.61302,tp2Price:1646.20203});
    h.info.digits=5;h.quote({bid:1642,ask:1643.37,ts:Date.now()});
    const r=await h.run();assert.equal(h.sent.length,0,'XPT TP1 below live fill must never be sent');assert.equal(r.success,false);assert.match(r.error,/TARGETS/);
});

test('size on live ask plus bounded slippage, floor broker step',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    h.quote({bid:100,ask:110,ts:Date.now()});h.params.slPrice=80;
    const r=await h.run();assert.equal(r.success,true,r.error);assert.equal(h.sent[0].volume,300,'risk100 / (worst fill110.01 - stop80) floors to 300 cents');
    assert.equal(r.lots,.03,'display lots uses actual broker lotSize');
});

test('EUR deposit uses loss-side inverse bid conversion, not assumed dollars',async()=>{
    const h=harness({accountCurrency:'EUR',getAccountInfo:async()=>({equity:10000,currency:'EUR'})});
    h.params.slPrice=80;h.quote({bid:100,ask:110,ts:Date.now()});
    h.ctx.executionAssetNames.set(3,'EUR');
    h.ctx.executionSymbolMetadata.set('EURUSD',{baseAssetId:3,quoteAssetId:2});
    const quote=h.ctx.getLastBidAsk;
    h.ctx.getLastBidAsk=(ticker:string,now=Date.now())=>ticker==='EURUSD'?{bid:1.2,ask:1.3,ts:now}:quote();
    const r=await h.run();assert.equal(r.success,true,r.error);assert.equal(h.sent[0].volume,300);
    // At risk 150 EUR, rate 1/1.2 permits 500 cents; assuming USD permits 400.
    h.params.riskPercent=1.5;h.sent.length=0;const second=await h.run();assert.equal(second.success,true,second.error);assert.equal(h.sent[0].volume,500,'USD liability costs EUR at inverse bid');
});

test('unverifiable or expired broker metadata fails closed',async()=>{
    for(const bad of [{digits:undefined},{pipPosition:undefined},{quoteAssetId:undefined},{lotSize:undefined},{stepVolume:0},{minVolume:undefined},{maxVolume:undefined},{safetyFetchedAtMs:Date.now()-300001}]) {
        const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});h.params.slPrice=80;Object.assign(h.info,bad);const r=await h.run();
        assert.equal(h.sent.length,0,`must block ${JSON.stringify(bad)}`);assert.equal(r.success,false);
    }
});

test('clean capped rejection never falls back to an unbounded MARKET',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    let capped=0,uncapped=0;
    h.ctx.ctClient.raw.trading.marketRangeOrder=async()=>{capped++;return {errorCode:'NOT_SUPPORTED'};};
    h.ctx.ctClient.raw.trading.marketOrder=async()=>{uncapped++;throw new Error('unbounded sent');};
    const r=await h.run();assert.equal(capped,1);assert.equal(uncapped,0,'reject instead of risking unbounded market slippage');assert.equal(r.success,false);
});

test('actual fill risk or target breach closes once without loosening SL',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    const send=h.ctx.ctClient.raw.trading.marketRangeOrder;
    h.ctx.ctClient.raw.trading.marketRangeOrder=async(p:any)=>{const e=await send(p);e.position.price=140;return e;};
    const r=await h.run();assert.equal(r.success,false,'never report an unsafe fill as successful');assert.equal(h.sent.length,1);assert.equal(h.closed.length,1,'close unsafe actual fill, never change structural stop');
});

test('verified actual fill freezes initial monetary risk, volume and conversion',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    const send=h.ctx.ctClient.raw.trading.marketRangeOrder;
    h.ctx.ctClient.raw.trading.marketRangeOrder=async(p:any)=>{const e=await send(p);e.position.price=101.005;e.position.tradeData.volume=200;return e;};
    const r=await h.run();assert.equal(r.success,true,r.error);assert.ok(r.riskSnapshot,'verified fill must return a frozen monetary risk snapshot');
    const s=r.riskSnapshot;assert.equal(s.entryPrice,101.005);assert.equal(s.filledVolumeCents,200);assert.equal(s.initialSlPrice,90);assert.equal(s.currency,'USD');assert.equal(s.source,'broker_fill');assert.equal(s.riskAmountAccount,Math.abs(101.005-90)*2);assert.equal(r.lots,.02);assert.ok(Object.isFrozen(s));
    h.params.slPrice=100;h.position().stopLoss=100;h.quote({bid:110,ask:111,ts:Date.now()});assert.equal(s.initialSlPrice,90);assert.equal(s.quoteToAccountRate,1);
});

test('known broker commission reserves both sides inside pretrade budget',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    h.info.commissionType=4;h.info.preciseTradingCommissionRate=25*1e8;
    const r=await h.run();assert.equal(r.success,true,r.error);assert.equal(h.sent[0].volume,800,'900 cents would spend risk99.09 plus commission4.5 > budget100');
    assert.equal(r.riskSnapshot.riskAmountAccount,88,'frozen initial risk excludes commissions, denominator is price risk');
});

test('supplied minimumRR survives executable-price revalidation, no invented threshold',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    h.params.minimumRR=3;
    const r=await h.run();assert.equal(h.sent.length,0,'arrival RR 29/11 is below explicitly supplied 3');assert.equal(r.success,false);
});

test('targets must remain directional throughout authorized native fill range',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    h.info.digits=3;h.info.pipPosition=2;h.params.tp1Price=101.001;
    const r=await h.run();assert.equal(h.sent.length,0,'TP1 can be crossed by allowed adverse fill');assert.equal(r.success,false);
});

test('ambiguous send reconciles matching actual position and closes missing protection, never resends',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});let sends=0;
    h.ctx.ctClient.raw.trading.marketRangeOrder=async(p:any)=>{sends++;h.setPosition({positionId:42,price:101,stopLoss:undefined,tradeData:{symbolId:1,tradeSide:1,volume:p.volume,label:'OFFLINE'}});throw new Error('timeout after broker accepted');};
    const r=await h.run();assert.equal(r.success,false);assert.equal(sends,1);assert.equal(h.closed.length,1,'reconcile and close owned unprotected fill after transport ambiguity');
});

test('unverifiable initial account positions fail closed',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    h.ctx.ctClient.getState=async()=>{throw new Error('disconnected state');};
    const r=await h.run();assert.equal(h.sent.length,0,'position count read failure cannot authorize a send');assert.equal(r.success,false);
});

test('JPY-denominated index uses broker base units and direct liability ask',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    Object.assign(h.info,{lotSize:100,digits:1,pipPosition:0,quoteAssetId:3});h.ctx.executionAssetNames.set(3,'JPY');
    h.ctx.executionSymbolMetadata.set('JPYUSD',{baseAssetId:3,quoteAssetId:2});
    Object.assign(h.params,{ticker:'JP225',entryPrice:40000,slPrice:39900,tp1Price:40100,tp2Price:40200});h.quote({bid:40000,ask:40010,ts:Date.now()});
    const get=h.ctx.getLastBidAsk;h.ctx.getLastBidAsk=(ticker:string,now=Date.now())=>ticker==='JPYUSD'?{bid:.0066,ask:.0068,ts:now}:get();
    const r=await h.run();assert.equal(r.success,true,r.error);
    const expected=Math.floor(100/((40010.2-39900)/100*.0068)/100)*100;
    assert.equal(h.sent[0].volume,expected);assert.equal(r.lots,expected/100);assert.equal(r.riskSnapshot.quoteToAccountRate,.0068);
});
test('quote and size refresh after awaited callback before the only broker send',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});h.params.slPrice=80;
    h.params.beforeExecution=async()=>{await Promise.resolve();h.quote({bid:110,ask:115,ts:Date.now()});return null;};
    const r=await h.run();assert.equal(r.success,true,r.error);assert.equal(h.sent.length,1);assert.equal(h.sent[0].baseSlippagePrice,115);assert.equal(h.sent[0].volume,200);
});
test('callback quote can invalidate targets, metadata or currency conversion with zero sends',async()=>{
    for(const kind of ['targets','metadata','conversion']) {
        const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
        h.params.beforeExecution=async()=>{await Promise.resolve();if(kind==='targets')h.quote({bid:121,ask:122,ts:Date.now()});if(kind==='metadata')h.info.safetyFetchedAtMs=Date.now()-300001;if(kind==='conversion')h.ctx.executionAssetNames.set(2,'CHF');return null;};
        const r=await h.run();assert.equal(h.sent.length,0,kind);assert.equal(r.success,false);
    }
});
test('missing stale future or crossed bilateral quotes block, including fallback flag',async()=>{
    for(const q of [null,{bid:100,ask:101,ts:Date.now()-10001},{bid:100,ask:101,ts:Date.now()+60000},{bid:101,ask:100,ts:Date.now()},{bid:NaN,ask:101,ts:Date.now()}]) {
        const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'}),getLastBidAsk:()=>q});
        const r=await h.run();assert.equal(h.sent.length,0);assert.equal(r.success,false);
    }
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});h.ctx.config.CTRADER_MARKET_RANGE=false;
    const r=await h.run();assert.equal(h.sent.length,0);assert.match(r.error,/UNBOUNDED/);
});
test('unverified default USD does not authorize sizing; missing and stale FX reject',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'}),executionAccountCurrencyVerified:false,detectAccountCurrency:async()=> 'USD'});
    const r=await h.run();assert.equal(h.sent.length,0);assert.match(r.error,/CURRENCY/);
    for(const bad of [null,{bid:1.2,ask:1.3,ts:Date.now()-10001}]) {
        const e=harness({getAccountInfo:async()=>({equity:10000,currency:'EUR'}),accountCurrency:'EUR'});
        e.ctx.executionAssetNames.set(3,'EUR');e.ctx.executionSymbolMetadata.set('EURUSD',{baseAssetId:3,quoteAssetId:2});
        const get=e.ctx.getLastBidAsk;e.ctx.getLastBidAsk=(t:string)=>t==='EURUSD'?bad:get();
        const r=await e.run();assert.equal(e.sent.length,0);assert.match(r.error,/CONVERSION/);
    }
});
test('broker max is floored to step, minimum volume is never forced',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});h.info.maxVolume=750;
    const r=await h.run();assert.equal(r.success,true,r.error);assert.equal(h.sent[0].volume,700);
    const small=harness();const blocked=await small.run();assert.equal(small.sent.length,0);assert.match(blocked.error,/MIN_VOLUME/);
});
test('ambiguous no-fill response is explicitly uncertain with no retry or market fallback',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});let attempts=0;
    h.ctx.ctClient.raw.trading.marketRangeOrder=async()=>{attempts++;throw new Error('transport timeout');};
    const r=await h.run();assert.equal(r.success,false);assert.equal(r.executionUncertain,true);assert.equal(attempts,1);assert.equal(h.sent.length,0);
});
test('actual missing SL and wrong volume never produce a successful snapshot',async()=>{
    for(const kind of ['SL','TP','volume']) {
        const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});const send=h.ctx.ctClient.raw.trading.marketRangeOrder;
        h.ctx.ctClient.raw.trading.marketRangeOrder=async(p:any)=>{const e=await send(p);if(kind==='SL')e.position.stopLoss=undefined;else if(kind==='TP')e.position.takeProfit=undefined;else e.position.tradeData.volume=p.volume+100;return e;};
        const r=await h.run();assert.equal(r.success,false);assert.equal(r.riskSnapshot,undefined);assert.equal(h.closed.length,1);
    }
});

test('sub-tick or nonpositive configured cap cannot be rounded past authorization',async()=>{
    for(const cap of [0,-1,.1]) {
        const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});h.ctx.config.CTRADER_MAX_SLIPPAGE_PIPS=cap;
        const r=await h.run();assert.equal(h.sent.length,0,'minimum native tick may not exceed configured cap');assert.equal(r.success,false);
    }
});

test('unverified emergency close returns owned position and explicit uncertainty',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'}),closePosition:async()=>false});const send=h.ctx.ctClient.raw.trading.marketRangeOrder;
    h.ctx.ctClient.raw.trading.marketRangeOrder=async(p:any)=>{const e=await send(p);e.position.stopLoss=undefined;return e;};
    const r=await h.run();assert.equal(r.success,false);assert.equal(r.positionId,'42');assert.equal(r.executionUncertain,true,'never call a rejected close an aborted position');
});

test('local telemetry failure cannot misreport a verified broker fill as rejected',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'}),db:{collection(){throw new Error('offline telemetry');}}});
    const r=await h.run();assert.equal(r.success,true,r.error);assert.ok(r.riskSnapshot);assert.equal(h.sent.length,1);assert.equal(h.closed.length,0);
});

test('partial fill cancels pending remainder and freezes only terminal actual volume',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'}),PayloadType:{CANCEL_ORDER_REQ:2108}});
    let pending=false,cancels=0;const send=h.ctx.ctClient.raw.trading.marketRangeOrder;
    h.ctx.ctClient.raw.trading.marketRangeOrder=async(p:any)=>{const e=await send(p);e.position.tradeData.volume=200;pending=true;return e;};
    h.ctx.ctClient.getState=async()=>({positions:h.position()?[h.position()]:[],orders:pending?[{orderId:123,tradeData:{symbolId:1,label:'OFFLINE'}}]:[]});
    const request=h.ctx.ctClient.connection.request.bind(h.ctx.ctClient.connection);
    h.ctx.ctClient.connection.request=async(type:any,payload:any)=>{if(type===PayloadType.NEW_ORDER_REQ)return request(type,payload);assert.equal(type,2108);assert.equal(payload.orderId,123);cancels++;pending=false;h.position().tradeData.volume=300;return {};};
    const r=await h.run();assert.equal(r.success,true,r.error);assert.equal(cancels,1,'never freeze partial R while remainder can still fill');assert.equal(r.riskSnapshot.filledVolumeCents,300);
});

test('failed protection readback cancels remainder before emergency close and verifies cancellation',async()=>{
    for(const cancellationWorks of [true,false]) {
        const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'}),verifyPositionProtection:async()=>false,PayloadType:{CANCEL_ORDER_REQ:2108}});
        let pending=false,cancels=0;const send=h.ctx.ctClient.raw.trading.marketRangeOrder;
        h.ctx.ctClient.raw.trading.marketRangeOrder=async(p:any)=>{const e=await send(p);pending=true;return e;};
        h.ctx.ctClient.getState=async()=>({positions:h.position()?[h.position()]:[],orders:pending?[{orderId:123,tradeData:{symbolId:1,label:'OFFLINE'}}]:[]});
        const request=h.ctx.ctClient.connection.request.bind(h.ctx.ctClient.connection);
        h.ctx.ctClient.connection.request=async(type:number,payload:any)=>{if(type===PayloadType.NEW_ORDER_REQ)return request(type,payload);cancels++;if(cancellationWorks)pending=false;return {};};
        const r=await h.run();assert.equal(r.success,false);assert.equal(cancels,1,'failed protection must still cancel owned remainder');
        assert.equal(r.executionUncertain,!cancellationWorks,'a closed position alone never proves its remainder gone');assert.equal(h.closed.length,1);
    }
});

test('5 percent override preserves the existing 3 percent live risk ceiling',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});h.params.riskPercent=5;
    const r=await h.run();assert.equal(r.success,true,r.error);assert.equal(r.riskBudgetAccount,300);assert.equal(h.sent[0].volume,2700);
});

test('positive unsupported legacy commission or minimum cannot be certified as zero',async()=>{
    for(const fields of [
        {commissionType:4,commission:250000,minCommissionType:1,minCommissionAsset:'USD',minCommission:500},
        {commissionType:4,commission:250000,preciseTradingCommissionRate:0},
        {minCommission:500,minCommissionType:1},
        {minCommission:500,minCommissionType:1,preciseMinCommission:0},
    ]) {
        const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});Object.assign(h.info,fields);
        const r=await h.run();assert.equal(h.sent.length,0,JSON.stringify(fields));assert.match(r.error,/COST/);
    }
    const rate=(a:string,b:string)=>a===b?1:undefined;
    const c=safety.orderCommission({lotSize:10000,commissionType:4,preciseTradingCommissionRate:25e8,minCommissionType:1,minCommissionAsset:'USD',preciseMinCommission:5e8},101,'USD','USD',rate)!;
    assert.equal(c.perCentAccount,25/10000);assert.equal(c.minSideAccount,5);
    const pct=safety.orderCommission({lotSize:10000,commissionType:3,preciseTradingCommissionRate:100000},200,'USD','USD',rate)!;
    assert.equal(pct.perCentAccount,.02,'1% of two currency units per protocol cent');
});

test('live service uses dispatch authorization rather than bypassing the SDK guard',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'}),authorizedBrokerRequest:async()=>{throw Object.assign(new Error('BLOCKED_DISPATCH: test queue'),{brokerNotSubmitted:true});}});
    const r=await h.run();assert.equal(h.sent.length,0);assert.equal(r.success,false);assert.match(r.error,/DISPATCH/);assert.notEqual(r.executionUncertain,true,'pre-dispatch refusal is not a submitted broker order');
});

test('actual executor waits for SDK read cooldown before one freshly sized order',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    const connection:any=new CTraderConnection({host:'OFFLINE.invalid',requestTimeoutMs:2000});
    const frames:any[]=[];
    connection.socket={destroyed:false,write(frame:Buffer){
        const message=decodeMessage(frame.subarray(4));frames.push(message);
        if(message.payloadType===PayloadType.NEW_ORDER_REQ) {
            void h.ctx.ctClient.raw.trading.marketRangeOrder(message.payload).then((event:any)=>{
                connection.handleData(encodeMessage(PayloadType.EXECUTION_EVENT,{ctidTraderAccountId:1,executionType:3,position:{...event.position,positionStatus:1,swap:0}},message.clientMsgId));
            });
        } else queueMicrotask(()=>connection.handleData(encodeMessage(PayloadType.APP_AUTH_RES,{ctidTraderAccountId:1},message.clientMsgId)));
        return true;
    }};
    h.ctx.ctClient.connection=connection;
    h.ctx.getSymbolInfo=async()=>{await connection.request(PayloadType.TRADER_REQ,{ctidTraderAccountId:1});return h.info;};
    const started=performance.now();
    const result=await h.run();
    assert.equal(result.success,true,result.error);
    assert.equal(frames.filter(f=>f.payloadType===PayloadType.NEW_ORDER_REQ).length,1,'one bounded mutation only');
    assert.ok(performance.now()-started>=40,'routine cooldown must be awaited, never bypassed');
    assert.equal(h.sent.length,1);
    assert.equal(result.riskSnapshot.initialSlPrice,90,'preserve original structural stop');
});

test('executor revokes entry risk during cooldown with no broker mutation',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    h.ctx.ctClient.connection.lastRequestSentAt=Date.now();let checks=0;
    h.params.beforeExecution=async()=>++checks>=2?'BLOCKED_ACCOUNT_STATE: risk changed during admission':null;
    const result=await h.run();assert.equal(result.success,false);assert.match(result.error,/risk changed during admission/);
    assert.equal(h.sent.length,0);assert.equal(h.ctx.ctClient.connection.requestQueue.length,0);
});

test('executor refreshes quote after cooldown and never carries a stale size into SDK',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    h.ctx.ctClient.connection.lastRequestSentAt=Date.now();let checks=0;
    h.params.beforeExecution=async()=>{checks++;if(checks>=2)h.quote({bid:104,ask:105,ts:Date.now()});return null;};
    const result=await h.run();assert.equal(result.success,true,result.error);assert.ok(checks>=2);
    assert.equal(h.sent.length,1);assert.equal(h.sent[0].baseSlippagePrice,105);
    assert.equal(h.sent[0].volume,600,'budget100 / worst-case15.01 floors to 600 cents, not old 900');
    assert.equal(h.sent[0].stopLoss,90,'admission cannot loosen original stop');
});

test('late entry approval after admission timeout cannot resume the actual executor',async()=>{
    const h=harness({getAccountInfo:async()=>({equity:10000,currency:'USD'})});
    h.params.beforeExecution=async()=>{await new Promise(r=>setTimeout(r,1150));return null;};
    const result=await h.run();assert.equal(result.success,false);assert.match(result.error,/admission wait timed out before submission/);
    assert.equal(h.sent.length,0);assert.notEqual(result.executionUncertain,true);
    await new Promise(r=>setTimeout(r,200));assert.equal(h.sent.length,0,'late callback cannot submit a deferred order');
});

let failed=0;
for(const [name,fn] of cases){try{await fn();console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e);}}
assert.equal(failed,0,`${failed} order safety cases failed`);
console.log(`ORDER_SAFETY_LIVE: ${cases.length} PASS`);
