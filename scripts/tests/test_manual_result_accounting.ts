import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync('src/services/journal.ts','utf8');
const ast=ts.createSourceFile('journal.ts',source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='recordResult')!;
async function run(existing:any){
    const writes:any[]=[];let invalidations=0;const api:any={};
    const db={collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>existing}),update:async(fields:any)=>writes.push(fields)})})};
    vm.runInNewContext(ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
        exports:api,db,JOURNAL_COLLECTION:'trade_journal',console:{log(){},warn(){},error(){}},Date,
        require:(id:string)=>id.includes('PortfolioModel')?{invalidateRiskCache:()=>{invalidations++;}}:(()=>{throw new Error(id);})(),
    });
    const ok=await api.recordResult('J1','WIN',1.5);return{ok,writes,invalidations};
}
for(const existing of [{ctraderPositionId:'P1',result:'LOSS',ctrader_real_pnl:-20,rMultiple:-.2,riskAccountingStatus:'VERIFIED'},{ctraderStatus:'EXECUTED'},{executionIncidentPending:true}]){
    const r=await run(existing);assert.equal(r.ok,false,'manual percent result cannot overwrite executed or uncertain broker accounting');assert.equal(r.writes.length,0);
}
const nonBroker=await run({ticker:'EURUSD'});
assert.equal(nonBroker.ok,true);
assert.equal(nonBroker.writes[0].riskAccountingStatus,'UNVERIFIED');
assert.equal(nonBroker.writes[0].rMultiple,null);
assert.equal(nonBroker.writes[0].closedAtSource,'unknown','wall clock is not a broker execution timestamp');
assert.equal(nonBroker.invalidations,1);
console.log('PASS manual result writer cannot overwrite broker or uncertain result; non-broker annotations carry unknown accounting');
