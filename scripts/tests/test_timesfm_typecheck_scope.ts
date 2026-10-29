import fs from 'node:fs';import ts from 'typescript';
const tree=ts.createSourceFile('SMCBridge.ts',fs.readFileSync('src/engine/smc/SMCBridge.ts','utf8'),ts.ScriptTarget.Latest,true);
const funcs=new Set(['ingestTimesfmCandle','configureTimesfmIngest']);const vars=new Set(['TIMESFM_BRIDGE_URL','timesfmIngestUrl','timesfmIngestTfs']);
const snippets=tree.statements.filter(s=>ts.isFunctionDeclaration(s)?s.name&&funcs.has(s.name.text):ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>vars.has(d.name.getText(tree)))).map(s=>s.getText(tree)).join('\n');
const virtual='/opt/JARVIS/scripts/tests/__timesfm_smc_scope__.mts';
const source="import { normalizeTimesfmTf } from '../../src/engine/TimesfmFilter.js';\nimport { notifyTimesfmCandleClosed } from '../../src/engine/TimesfmLiveCacheNode.js';\ntype OHLCV = {timestamp:number;close:number};\n"+snippets;
const options={noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,strict:true,esModuleInterop:true,skipLibCheck:true};
const host=ts.createCompilerHost(options),base=host.getSourceFile.bind(host);host.getSourceFile=(file,language,onError,shouldCreate)=>file===virtual?ts.createSourceFile(virtual,source,language,true):base(file,language,onError,shouldCreate);
const program=ts.createProgram([virtual],options,host),diagnostics=ts.getPreEmitDiagnostics(program);if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>process.cwd(),getCanonicalFileName:p=>p,getNewLine:()=> '\n'}));process.exitCode=1;}else console.log('PASS TimesFM SMC ingest declarations scoped strict typecheck (real AST; no trading/ctrader imports)');
