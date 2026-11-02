import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync('src/db/trading.ts','utf8');
const ast=ts.createSourceFile('trading.ts',source,ts.ScriptTarget.Latest,true);
function extract(names:string[]) {return ast.statements.filter(n=>(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text??''))||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>names.includes(d.name.getText(ast))))).map(n=>n.getText(ast)).join('\n');}
const code=ts.transpileModule(extract(['captureRolloverVerifiedFill']),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const api=vm.runInNewContext(code+'\n({capture:typeof captureRolloverVerifiedFill === "function"?captureRolloverVerifiedFill:undefined})',{exports:{},structuredClone});
assert.equal(typeof api.capture,'function','verified broker fill capture is missing');
const trade:any={tradeId:'T1',ticker:'EURUSD',direction:'BUY',ctraderPositionId:'42',entryPrice:999,slPrice:999};
const policy={profile:'rollover_triage_v1',triage:{maxExtraRiskR:.3}};
const row={positionId:42,price:100,stopLoss:90,tradeData:{tradeSide:1,openTimestamp:123,volume:100}};
assert.equal(api.capture(trade,row,policy,200),true);
assert.equal(trade.rolloverFill.entryPrice,100);assert.equal(trade.rolloverFill.initialSlPrice,90);assert.equal(trade.rolloverFill.initialRiskPrice,10);
row.stopLoss=95;policy.triage.maxExtraRiskR=.1;
assert.equal(api.capture(trade,row,policy,300),false);assert.equal(trade.rolloverFill.initialRiskPrice,10);assert.equal(trade.rolloverFill.policy.triage.maxExtraRiskR,.3);
for(const bad of [{...row,positionId:43},{...row,stopLoss:101},{...row,tradeData:{...row.tradeData,tradeSide:2}},{...row,tradeData:{...row.tradeData,openTimestamp:undefined}}]) {
 const unknown={tradeId:'T2',ticker:'EURUSD',direction:'BUY',ctraderPositionId:'42'};
 assert.equal(api.capture(unknown,bad,policy,200),false);
}
console.log('ROLLOVER_LIVE_CAPTURE: PASS');
