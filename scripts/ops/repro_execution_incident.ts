// Actual installed SDK, fake socket only. No broker connection or live order.
import {CTraderConnection,CTraderTrading,PayloadType} from 'ctrader-ts';
import {decodeMessage,encodeMessage} from '../../node_modules/ctrader-ts/dist/src/protocol/codec.js';
import {authorizedBrokerRequest,validateOrderLevels} from '../../src/engine/OrderSafety.js';
const connection:any=new CTraderConnection({host:'OFFLINE.invalid',requestTimeoutMs:2000});
const writes:any[]=[];
connection.socket={destroyed:false,write(frame:Buffer){const decoded=decodeMessage(frame.subarray(4));writes.push(decoded);queueMicrotask(()=>connection.handleData(encodeMessage(PayloadType.APP_AUTH_RES,{ctidTraderAccountId:1},decoded.clientMsgId)));return true;}};
const trading=new CTraderTrading({request:(type:number,payload:any)=>authorizedBrokerRequest(connection,type,payload,()=>null)} as any,1);
await connection.request(PayloadType.TRADER_REQ,{ctidTraderAccountId:1});
const lastReadAgoMs=Date.now()-connection.lastRequestSentAt;
let error:any;
try{await trading.marketRangeOrder({symbolId:1,tradeSide:1,volume:100,baseSlippagePrice:100,slippageInPoints:1,label:'OFFLINE_ONLY',stopLoss:90});}catch(e){error=e;}
console.log(JSON.stringify({case:'order immediately after routine account read',lastReadAgoMs,actualError:error?.message,brokerNotSubmitted:error?.brokerNotSubmitted,recordedPayloads:writes.map(w=>w.payloadType)},null,2));
const cases=[{direction:'SELL' as const,entry:0.9842671,sl:0.98491,tp1:0.9823,tp2:0.98331},{direction:'SELL' as const,entry:4017.7846,sl:4028.46,tp1:3988.76,tp2:4001.7715},{direction:'BUY' as const,entry:101.9148,sl:101.54012,tp1:102.61,tp2:102.47682}];
console.log(JSON.stringify(cases.map(levels=>({...levels,reproduced:validateOrderLevels(levels.direction,levels.entry,levels.sl,levels.tp1,levels.tp2)})),null,2));
