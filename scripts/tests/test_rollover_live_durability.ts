import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const text=fs.readFileSync('src/db/trading.ts','utf8'),ast=ts.createSourceFile('trading.ts',text,ts.ScriptTarget.Latest,true);
const selected=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&['persistLiveRolloverRecord'].includes(n.name?.text??'')).map(n=>n.getText(ast)).join('\n');
const fill={schema:1,ticker:'EURUSD',positionId:'42',positionKey:'42:123',entryPrice:100,initialSlPrice:90,initialRiskPrice:10};
const identity={ticker:'EURUSD',tradeId:'T1',positionKey:'42:123'};const latch={tradeId:'T1',periodKey:'p',originalSlPrice:90,widenedSlPrice:87,initialRiskPrice:10,extraRiskR:.3,status:'CONFIRMED'};
const trade:any={tradeId:'T1',journalId:'INDEPENDENT',ticker:'EURUSD',ctraderPositionId:'42',rolloverFill:fill,rolloverTriageState:{pending:null,widenReference:null}};
const docs=new Map<string,any>([['active_trades/T1',{ctraderPositionId:'42'}],['trade_journal/INDEPENDENT',{ctraderPositionId:'42'}],['trade_journal/T1',{sentinel:true}]]);let fail='',reads=0;
const snap=(key:string)=>({exists:docs.has(key),data:()=>structuredClone(docs.get(key))});
const db={collection:(c:string)=>({doc:(id:string)=>({key:c+'/'+id,get:async()=>{reads++;if(fail==='read')throw Error('read');return snap(c+'/'+id);}})}),runTransaction:async(fn:any)=>{const writes:any[]=[];await fn({get:async(r:any)=>snap(r.key),update:(r:any,f:any)=>{if(fail===r.key)throw Error('write');writes.push([r.key,f]);}});for(const [k,v]of writes)docs.set(k,{...docs.get(k),...structuredClone(v)});}};
const code=ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const api=vm.runInNewContext(code+'\n({persist:typeof persistLiveRolloverRecord === "function"?persistLiveRolloverRecord:undefined})',{exports:{},db,structuredClone,JSON});
assert.equal(typeof api.persist,'function','active+journal transactional readback missing');
const write={identity,state:{pending:latch,widenReference:latch},protection:{status:'OPEN',identity,stopLossPrice:87}};
for(const failure of ['active_trades/T1','trade_journal/INDEPENDENT','read']){fail=failure;await assert.rejects(api.persist('T1',trade,write,'CONFIRMED'));assert.equal(trade.rolloverTriageDurable,undefined);}
fail='';await api.persist('T1',trade,write,'CONFIRMED');assert.ok(reads>=2);assert.equal(docs.get('trade_journal/T1').sentinel,true);assert.equal(docs.get('trade_journal/INDEPENDENT').rolloverTriageState.widenReference.widenedSlPrice,87);assert.equal(trade.rolloverTriageDurable,true);
const clear={...write,state:{pending:null,widenReference:latch}};await api.persist('T1',trade,clear,'CLEAR');assert.equal(docs.get('active_trades/T1').rolloverTriageState.pending,null);assert.equal(docs.get('trade_journal/INDEPENDENT').rolloverTriageState.widenReference.widenedSlPrice,87);
docs.get('active_trades/T1').rolloverFill={...fill,positionKey:'42:OTHER'};await assert.rejects(api.persist('T1',trade,clear,'CLEAR'));
console.log('ROLLOVER_LIVE_DURABILITY: PASS');
