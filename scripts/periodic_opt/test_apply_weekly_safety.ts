// Execute the real CLI main, with every IO boundary recording and forbidden.
// The legacy entry is retired; all permitted writes are covered by
// test_weekly_rollout.ts (including rollback/readback/races/active trades).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const file=process.env.TEST_APPLY_SOURCE??'scripts/periodic_opt/apply_weekly.ts';
const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
const selected=ast.statements.filter(n=>ts.isVariableStatement(n)||ts.isFunctionDeclaration(n));
const compiled=ts.transpileModule(selected.map(n=>n.getText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
let cases=0;
for(const args of [[],['--dry-run'],['--rollback','EURUSD','2026-10-01'],['--rollback','EURUSD','2026-10-01','--dry-run']]) {
 const calls:string[]=[];
 const denied=(name:string)=>{calls.push(name);throw new Error('FORBIDDEN_IO:'+name);};
 const context=vm.createContext({path,process:{argv:['node',file,...args]},
  fs:new Proxy({},{get:(_target,key)=>()=>denied('fs.'+String(key))}),
  admin:new Proxy({},{get:(_target,key)=>denied('admin.'+String(key))}),console});
 vm.runInContext(compiled,context,{filename:file});
 await assert.rejects(vm.runInContext('main()',context),/Ruta legacy deshabilitada/);
 assert.deepEqual(calls,[],'legacy entry must reject BEFORE credentials, broker, DB, backup or filesystem IO');
 cases++;
}
console.log(`PASS: ${cases} legacy CLI modes reject before all IO; only explicit weekly lifecycle is permitted`);
