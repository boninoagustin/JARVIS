import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('src/services/ctrader.ts', 'utf8');
const ast = ts.createSourceFile('ctrader.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'getVerifiedAccountCurrency');
assert.ok(declaration, 'live accounting needs verified currency export, not the display USD fallback');
const api: any = {};
const context: any = {exports: api, accountCurrency:'EUR', executionAccountCurrencyVerified:false};
vm.runInNewContext(ts.transpileModule(declaration!.getText(ast), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, context);
assert.equal(api.getVerifiedAccountCurrency(), null);
context.executionAccountCurrencyVerified = true;
assert.equal(api.getVerifiedAccountCurrency(), 'EUR');
context.accountCurrency = 'USD'; context.executionAccountCurrencyVerified = false;
assert.equal(api.getVerifiedAccountCurrency(), null);
console.log('PASS production currency boundary only exposes broker-verified deposit currency');
