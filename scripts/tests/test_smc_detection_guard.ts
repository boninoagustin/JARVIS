import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';
import ts from 'typescript';import {assertLegacyDetectionSearch} from '../smc_export_context.ts';
const file=path.resolve(import.meta.dirname,'../periodic_opt/smc_detection_search.ts');
const text=fs.readFileSync(file,'utf8');const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
const node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='buildPresetForTf');
assert.ok(node);const js=ts.transpileModule(node!.getText(source)+'\nglobalThis.build=buildPresetForTf;',
 {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
let loaded:any={};const box:any={loadOptimizedPreset:()=>loaded,BASE_PRESET:{'5':'fixture'},TICKER:'FIXTURE',assertLegacyDetectionSearch};
vm.runInNewContext(js,box);
assert.deepEqual(JSON.parse(JSON.stringify(box.build(null,'5'))),{});
loaded={signal_profile:'directional_atr_v1'};assert.throws(()=>box.build(null,'5'),/isolated exporter/);
loaded={};assert.throws(()=>box.build({signal_profile:'directional_atr_v1'},'5'),/isolated exporter/);
assert.throws(()=>box.build({signal_ablation:{sameBarSweeps:false}},'5'),/isolated exporter/);
assert.equal(box.build({pivot_len:8},'5').pivot_len,8);
console.log('Real detection preset builder refuses experimental profiles before legacy search/apply');
