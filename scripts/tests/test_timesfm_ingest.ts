import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const tree=ts.createSourceFile('SMCBridge.ts',fs.readFileSync('src/engine/smc/SMCBridge.ts','utf8'),ts.ScriptTarget.Latest,true);
const names=new Set(['ingestTimesfmCandle','configureTimesfmIngest']);
const declarations=tree.statements.filter(s=>ts.isFunctionDeclaration(s)&&s.name&&names.has(s.name.text)).map(s=>s.getText(tree)).join('\n');
const calls:any[]=[],notifies:any[]=[];const now=1792160100300;
const sandbox:any={exports:{},TIMESFM_BRIDGE_URL:'http://offline',timesfmIngestTfs:new Set([5,15]),timesfmIngestUrl:'http://offline',Date:class extends Date{static now(){return now;}},normalizeTimesfmTf:(tf:string|number)=>({M5:5,M15:15,H1:60,H4:240,D1:1440,W1:10080,'5':5,'15':15,'60':60} as any)[tf]??null,notifyTimesfmCandleClosed:(a:any)=>notifies.push(a),AbortController,setTimeout:()=>1,clearTimeout:()=>{},fetch:async(url:string,args:any)=>{calls.push({url,body:JSON.parse(args.body)});return {ok:true};}};
vm.runInNewContext(ts.transpileModule(declarations,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText+'\nexports.ingestTimesfmCandle=ingestTimesfmCandle;',sandbox);
async function main(){const ingest=sandbox.exports.ingestTimesfmCandle;
 ingest('EURUSD','M15',{timestamp:1792159200000,close:1.2});await Promise.resolve();
 assert.equal(calls[0].body.ts,1792160100000,'native candle open must become explicit close');
 assert.equal(calls[0].body.contextCloseTimeMs,1792160100000);assert.equal(calls[0].body.tf,15);assert.equal(calls[0].body.schema_version,2);assert.equal(notifies.length,1);
 for(const period of ['H1','H4','D1','W1','unknown'])ingest('EURUSD',period,{timestamp:1792159200000,close:1.2});
 assert.equal(calls.length,1,'only configured TFs ingest');
 ingest('EURUSD','M15',{timestamp:1792160100000,close:1.2});ingest('EURUSD','M15',{timestamp:1792159200000,close:NaN});assert.equal(calls.length,1,'reject forming/future and invalid close');
 sandbox.exports.configureTimesfmIngest({tfMinutes:[60],bridgeUrl:'http://other'});ingest('EURUSD','H1',{timestamp:1792155600000,close:1.2});assert.equal(calls[1].body.ts,1792159200000);assert.equal(calls[1].body.tf,60);assert.equal(calls[1].url,'http://other/ingest');
 console.log('PASS TimesFM native ingest real-function AST: explicit close, configured TF, no future/bad close, notify, custom URL');}
main().catch(e=>{console.error(e);process.exitCode=1;});
