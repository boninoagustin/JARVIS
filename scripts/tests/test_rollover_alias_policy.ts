import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { getRolloverAssetClass, getRolloverSpreadReference } from '../../src/engine/RolloverSpreadReference.js';
const file='src/db/trading.ts',text=fs.readFileSync(file,'utf8');
const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
const names=['rolloverPipSize','rolloverMinFloat','rolloverBeBuffer'];
const code=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text??'')).map(n=>n.getText(ast)).join('\n');
const compiled=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const api=vm.runInNewContext(compiled+'\n({'+names.join(',')+'})',{getRolloverAssetClass,getRolloverSpreadReference});
for(const ticker of ['NL25','NETHERLANDS 25']){assert.equal(api.rolloverPipSize(ticker),1,'index alias containing ETH must not become crypto');assert.equal(api.rolloverMinFloat(ticker,100),5);assert.equal(api.rolloverBeBuffer(ticker),5);}
for(const ticker of ['BTCUSD','ETHUSD']){assert.equal(api.rolloverPipSize(ticker),0);assert.equal(api.rolloverMinFloat(ticker,100),100*.005);assert.equal(api.rolloverBeBuffer(ticker),0);}
assert.equal(api.rolloverPipSize('EURUSD'),.0001);assert.equal(api.rolloverPipSize('USDJPY'),.01);assert.equal(api.rolloverPipSize('USOIL'),.01);
console.log('ROLLOVER_ALIAS_POLICY: PASS');
