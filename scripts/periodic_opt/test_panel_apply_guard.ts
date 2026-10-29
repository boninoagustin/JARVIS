// Real panel apply handlers, isolated from React/Firebase by AST extraction.
// Artificial report fixtures verify zero writes, not strategy performance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import path from 'node:path';

const filename = 'jarvis-os/src/components/PeriodicOptPanel.tsx';
const text = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations: Record<string, string> = {};
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations[node.name.text] = `const ${node.getText(ast)};`;
  ts.forEachChild(node, visit);
}
visit(ast);
const source = ['WEEKLY_PANEL_APPLICATION_ENABLED', 'prepareApply', 'confirmApply'].filter(k => declarations[k]).map(k => declarations[k]).join('\n');
const compiled = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
// Retiring the unsafe implementation is stronger than a switch: even an
// accidental edit to the old flag must not restore fragment reconstruction.
const forcedEnabled = ts.transpileModule(source.replace('const WEEKLY_PANEL_APPLICATION_ENABLED = false', 'const WEEKLY_PANEL_APPLICATION_ENABLED = true'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
for (const method of ['prepareApply', 'confirmApply']) {
  const calls: string[] = [];
  const context = vm.createContext({
    reports: [{ ticker: 'EURUSD', best_config: { fixedRR: 1.5 } }], report: { ticker: 'EURUSD', best_config: { fixedRR: 1.5 } },
    confirming: { ticker: 'EURUSD' }, db: {}, doc: () => ({}),
    getDoc: async () => { calls.push('read'); return { exists: () => true, data: () => ({ fixedRR: 2 }) }; },
    setDoc: async () => { calls.push('write'); }, toast: () => {}, setConfirming: () => {}, setApplying: () => {},
    APPLY_FIELDS: [{ src: 'fixedRR', dst: 'fixedRR', label: 'RR', fmt: String }], fetchReports: () => {}, console,
  });
  vm.runInContext(forcedEnabled, context);
  await vm.runInContext(method === 'prepareApply' ? 'prepareApply(report)' : 'confirmApply()', context);
  assert.deepEqual(calls, [], `${method}: retired legacy flag cannot restore unsafe reads/writes`);
}
for (const metadata of [{}, {apply_eligible:false,certificate:{version:1}}, {apply_eligible:true,certificate:{version:1}}]) {
  for (const method of ['prepareApply', 'confirmApply']) {
    const calls: string[] = [];
    const report = {ticker:'EURUSD',best_config:{fixedRR:1.5},...metadata};
    const context = vm.createContext({
      reports:[report], report, confirming:{ticker:'EURUSD'}, db:{},
      doc:() => ({}), getDoc:async()=>{calls.push('read');return{exists:()=>true,data:()=>({fixedRR:2})};},
      setDoc:async()=>{calls.push('write');}, toast:()=>{},
      setConfirming:(value: any)=>{if (value !== null) calls.push('confirmation');}, setApplying:()=>{}, fetchReports:()=>{},
      APPLY_FIELDS:[{src:'fixedRR',dst:'fixedRR',label:'RR',fmt:String}], console,
    });
    vm.runInContext(compiled, context, {filename});
    await vm.runInContext(method === 'prepareApply' ? 'prepareApply(report)' : 'confirmApply()', context);
    assert.deepEqual(calls, [], `${method} cannot reconstruct/apply an uncertified or protocol-v1 payload in the legacy panel`);
  }
}
// Inspect actual JSX, not a source-text regex that can pass on dead text.
const weeklyButtons: ts.Node[] = [];
function inspectJsx(node: ts.Node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'button') {
    const click = node.openingElement.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'onClick');
    const identifiers: string[] = [];
    function collect(n: ts.Node) {
      if (ts.isIdentifier(n)) identifiers.push(n.text);
      ts.forEachChild(n, collect);
    }
    if (click) collect(click);
    if (identifiers.includes('prepareApply') || identifiers.includes('confirmApply')) weeklyButtons.push(node);
    const disabled = node.openingElement.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'disabled');
    assert.ok(!(disabled && node.getText(ast).includes('SÓLO PROPUESTA') && node.getText(ast).includes('#00e676')),
      'weekly proposal must not appear as a green disabled application button');
  }
  ts.forEachChild(node, inspectJsx);
}
inspectJsx(ast);
assert.equal(weeklyButtons.length, 0, 'legacy partial-merge handlers must have no JSX button entrypoint');
console.log('PASS: legacy handlers stay inert, including forced-enable mutation; JSX exposes no legacy apply button');

// Execute only pure panel helpers/JSX, never import Firebase or mount effects.
const helpers = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text !== 'PeriodicOptPanel');
const helperSource = helpers.map(n => n.getText(ast)).join('\n');
const panelRequire = createRequire(path.resolve('jarvis-os/package.json'));
const helperContext = vm.createContext({ require: panelRequire, exports: {} });
vm.runInContext(ts.transpileModule(helperSource, {
  fileName: filename,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, helperContext);
assert.equal(vm.runInContext('typeof weeklyOperationalStatus', helperContext), 'function', 'panel needs a tested lifecycle status helper');
function status(report: any, autoState: any = {}, config: any = {}, stateError: string | null = null) {
  Object.assign(helperContext, { report, autoState, config, stateError });
  return vm.runInContext('weeklyOperationalStatus(report, autoState, config, stateError)', helperContext);
}
const recommend = { ticker: 'EURUSD', timestamp: 2000, status: 'RECOMMEND' };
assert.match(status(recommend).applicationLabel, /Recomendada.*aplicación automática pendiente/);
const { renderToStaticMarkup } = panelRequire('react-dom/server');
const { createElement } = panelRequire('react');
const Status = vm.runInContext('WeeklyOperationalStatus', helperContext);
const markup = renderToStaticMarkup(createElement(Status, { report: recommend }));
assert.match(markup, /aplicación automática pendiente/);
assert.doesNotMatch(markup, /<button/);
console.log('PASS: recommended lifecycle status renders as information, not an action');

const appliedAt = 1792972800000;
for (const [applicationStatus, expected] of [
  ['APPLIED', /Aplicada automáticamente/],
  ['UNCHANGED', /Se conserva la configuración válida anterior/],
  ['BLOCKED', /Aplicación bloqueada/],
  ['ROLLED_BACK', /Restaurada la configuración válida anterior/],
  ['ERROR', /Error de aplicación/],
  ['FUTURE_STATUS', /Estado de aplicación desconocido/],
] as const) {
  const view = status({ ...recommend, application: { status: applicationStatus, reason: 'Motivo verificable', at: appliedAt } });
  assert.match(view.applicationLabel, expected, applicationStatus);
  assert.equal(view.reason, 'Motivo verificable');
}
assert.match(status({ ...recommend, status: 'HOLD' }).applicationLabel, /Se conserva/);
assert.match(status({ ...recommend, status: 'ERROR' }).applicationLabel, /sin información/);
const appliedState = { applied: { EURUSD: { at: appliedAt, report_timestamp: 2000, applied_asset_fingerprint: 'state-fingerprint' } } };
const metadata = { autotune: { report_timestamp: 1000, applied_at_ms: appliedAt, asset_fingerprint: 'current-fingerprint', tracking_id: 'track-1' }, updatedBy: 'weekly_autotune' };
assert.match(status(recommend, appliedState, metadata).applicationLabel, /Aplicada automáticamente/);
assert.equal(status(recommend, appliedState, metadata).appliedAt, appliedAt);
assert.equal(status(recommend, appliedState, metadata).version, 'current-fingerprint', 'current asset metadata is authoritative for config version');
assert.equal(status(recommend, appliedState, metadata).trackingId, 'track-1');
assert.equal(status({...recommend,final_asset_config:{enabled:true,fixedRR:2},final_asset_fingerprint:'exact-evaluated-version'},appliedState,{currentSnapshot:{fixedRR:2,enabled:true}}).version,'exact-evaluated-version','show the actual loaded asset version without adding metadata to evaluated payload');
assert.match(status({...recommend,final_asset_config:{enabled:true,fixedRR:2}},appliedState,{currentSnapshot:{enabled:true,fixedRR:3}}).version,/diferente/,'manual config changes must not masquerade as the evaluated version');
assert.match(status(recommend, { applied: { EURUSD: { ...appliedState.applied.EURUSD, report_timestamp: 1000 } } }).applicationLabel,
  /aplicación automática pendiente/, 'prior applied config is not application of this new report');
assert.match(status(recommend, { latest: { EURUSD: { status: 'BLOCKED', reason: 'Anterior', report_timestamp: 1000 } } }).applicationLabel,
  /aplicación automática pendiente/, 'a prior report mirror must not override a new recommendation');
const mirror = { latest: { EURUSD: { status: 'ROLLED_BACK', reason: 'Revisión posterior', report_timestamp: 2000, at: appliedAt } } };
assert.match(status({ ...recommend, application: { status: 'APPLIED' } }, mirror).applicationLabel, /Restaurada/,
  'same-report status mirror survives replaced/stale report documents');
assert.match(status({ ...recommend, appliedAt }).applicationLabel, /legado/, 'legacy appliedAt must not claim automatic application');
assert.equal(status(recommend).version, 'Sin versión informada');
const appliedHtml = renderToStaticMarkup(createElement(Status, {
  report: { ...recommend, application: { status: 'APPLIED', at: appliedAt, reason: 'Verificado en almacenamiento' } },
  autoState: appliedState, config: metadata,
}));
for (const expected of ['current-fingerprint', 'track-1', 'Verificado en almacenamiento', new Date(appliedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })]) {
  assert.ok(appliedHtml.includes(expected), `render must show ${expected}`);
}
assert.match(appliedHtml, /sin confirmación de recepción del bot/);
console.log('PASS: application lifecycle, report correlation, current config metadata and real JSX rendering');

for (const [followupStatus, expected] of [
  ['PENDING', /Seguimiento posterior pendiente \(PENDING\)/],
  ['KEEP', /Seguimiento posterior: conservar \(KEEP\)/],
  ['ROLLBACK', /Seguimiento posterior: revertir \(ROLLBACK\)/],
  ['FUTURE_REVIEW', /Seguimiento posterior: estado desconocido/],
] as const) {
  const report = { ...recommend, followup: { status: followupStatus, reason: 'Ventana observada' } };
  const view = status(report);
  assert.match(view.followupLabel, expected);
  assert.equal(view.followupReason, 'Ventana observada');
  const html = renderToStaticMarkup(createElement(Status, { report }));
  assert.match(html, expected);
  assert.match(html, /Ventana observada/);
}
assert.equal(status(recommend).followupLabel, 'Seguimiento posterior: sin información');
assert.equal(status({...recommend,followup:{status:'PENDING',reason:'future_interval_not_yet_available'}}).followupReason,
  'Todavía no hay datos posteriores a la aplicación para comparar. La optimización ya está aplicada.');
const historicalState = { applied: { EURUSD: { ...appliedState.applied.EURUSD, report_timestamp: 1000,
  followup: { status: 'PENDING', reason: 'Faltan operaciones nuevas' } } } };
const historicalView = status(recommend, historicalState);
assert.match(historicalView.applicationLabel, /aplicación automática pendiente/);
assert.match(historicalView.followupLabel, /PENDING/);
assert.equal(historicalView.followupReportTimestamp, 1000);
assert.equal(historicalView.registeredVersion, 'state-fingerprint');
const priorReview = { latest: { EURUSD: { report_timestamp: 1000, status: 'APPLIED', followup: { status: 'KEEP', reason: 'Revisión conservada' } } } };
assert.match(status(recommend, priorReview).followupLabel, /KEEP/, 'review history survives report refresh without stApplied');
const historyHtml = renderToStaticMarkup(createElement(Status, { report: recommend, autoState: historicalState }));
assert.match(historyHtml, /aplicación anterior/);
assert.match(historyHtml, /state-fingerprint/);
assert.match(status({ ...recommend, followup: { status: 'PENDING' } }, priorReview).followupLabel, /PENDING/,
  'a prior review must not override explicit current-report followup');
assert.match(status(recommend, { latest: { EURUSD: { report_timestamp: 2000, followup: { status: 'ROLLBACK' } } } }).followupLabel, /ROLLBACK/);
console.log('PASS: prospective PENDING/KEEP/ROLLBACK, unknown statuses and prior-application review history');

assert.match(status(recommend, {}, {}, 'No se pudo consultar el estado automático').applicationLabel, /Estado automático no disponible/);
const unavailableHtml = renderToStaticMarkup(createElement(Status, { report: recommend, stateError: 'Lectura denegada' }));
assert.match(unavailableHtml, /Lectura denegada/);
assert.doesNotMatch(unavailableHtml, /aplicación automática pendiente/);

// Exercise the real Refresh fetch function against recording read-only boundaries.
assert.ok(declarations.fetchReports);
let generation = 0;
let failAuto = false;
let failConfig = false;
let reportRows: any[] = [];
let stateRows: any = null;
let configRows: any = null;
let stateError: string | null = null;
const reads: string[] = [];
const fakeDoc = (id: string, data: any) => ({ id, exists: () => true, data: () => data });
const fetchContext = vm.createContext({
  db: {}, collection: (_db: any, name: string) => name, doc: (_db: any, ...parts: string[]) => parts.join('/'),
  getDocs: async (name: string) => {
    reads.push(name);
    if (name === 'asset_configs' && failConfig) throw new Error('config denied');
    const docs = name === 'opt_reports' ? [fakeDoc('EURUSD', { ...recommend, timestamp: generation }), fakeDoc('UNRELATED', {})]
      : [fakeDoc('EURUSD', { autotune: { asset_fingerprint: `version-${generation}` } })];
    return { docs, forEach: (fn: any) => docs.forEach(fn) };
  },
  getDoc: async (name: string) => {
    reads.push(name);
    if (failAuto) throw new Error('auto denied');
    return fakeDoc('auto_state', { latest: { EURUSD: { report_timestamp: generation, status: 'APPLIED' } } });
  },
  setReports: (rows: any[]) => { reportRows = rows; }, setAutoState: (rows: any) => { stateRows = rows; },
  setConfigMetadata: (rows: any) => { configRows = rows; }, setStateError: (error: string | null) => { stateError = error; },
  setLoading: () => {}, toast: () => {}, console: { error: () => {} },
});
vm.runInContext(ts.transpileModule(declarations.fetchReports, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, fetchContext);
for (generation of [2000, 3000]) {
  reads.length = 0;
  await vm.runInContext('fetchReports()', fetchContext);
  assert.ok(reads.includes('optimization_config/auto_state'), 'Refresh must reread auto_state, not just reports');
  assert.ok(reads.includes('asset_configs'), 'Refresh must reread current config metadata');
  assert.equal(reportRows.length, 1);
  assert.equal(reportRows[0].timestamp, generation);
  assert.equal(stateRows.latest.EURUSD.report_timestamp, generation);
  assert.equal(configRows.EURUSD.autotune.asset_fingerprint, `version-${generation}`);
  assert.equal(stateError, null);
}
failAuto = true;
await vm.runInContext('fetchReports()', fetchContext);
assert.equal(reportRows.length, 1, 'auto_state permission failure must not discard valid reports');
assert.equal(Object.keys(stateRows).length, 0, 'failed refresh must not silently retain stale automatic state');
assert.match(stateError!, /estado automático/);
failAuto = false;
failConfig = true;
await vm.runInContext('fetchReports()', fetchContext);
assert.equal(Object.keys(configRows).length, 0, 'failed metadata refresh must clear stale current versions');
assert.match(stateError!, /configuración/);
console.log('PASS: Refresh reloads reports + auto_state + config versions; partial read failures are explicit');

// Render the real panel without mounting effects or importing Firebase.
const panelFunction = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'PeriodicOptPanel')!;
const panelSource = panelFunction.getText(ast).replace('export default ', '');
let hook = 0;
const fullPanelContext = vm.createContext({
  require: panelRequire, exports: {},
  useState: (initial: any) => {
    const initialState = [
      [{ ...recommend, appliedAt }],
      { latest: { EURUSD: { status: 'BLOCKED', report_timestamp: 2000, reason: 'Falta certificado', followup: { status: 'PENDING' } } } },
      { EURUSD: metadata }, null, false,
    ];
    const index = hook++;
    return [index < initialState.length ? initialState[index] : initial, () => {}];
  },
  useEffect: () => {}, useToast: () => ({ toast: () => {} }),
  Rocket: () => null, RefreshCw: () => null, Clock: () => null, HeartPulse: () => null,
});
vm.runInContext(ts.transpileModule(`${helperSource}\nconst WEEKLY_PANEL_APPLICATION_ENABLED = false;\nconst fmtR = (v) => String(v);\n${panelSource}`, {
  fileName: filename,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, fullPanelContext);
const fullHtml = renderToStaticMarkup(createElement(vm.runInContext('PeriodicOptPanel', fullPanelContext)));
for (const expected of [/Aplicación bloqueada/, /Falta certificado/, /current-fingerprint/, /PENDING/]) assert.match(fullHtml, expected);
assert.doesNotMatch(fullHtml, /✓ APLICADA/, 'legacy report appliedAt cannot contradict automatic BLOCKED status');
assert.doesNotMatch(fullHtml, /botón verde|se aplica con el botón de abajo|modal de confirmación/, 'weekly copy must not point at removed manual actions');
console.log('PASS: real panel wires automatic state/config metadata without conflicting legacy application claims');

let scoutPf: ts.Expression | undefined;
function findScoutPf(n: ts.Node) {
  if (ts.isJsxExpression(n) && n.expression && n.expression.getText(ast).includes('row.win84?.pf') && n.expression.getText(ast).includes('toFixed')) scoutPf = n.expression;
  ts.forEachChild(n, findScoutPf);
}
findScoutPf(ast);
assert.ok(scoutPf);
const pfCode = ts.transpileModule(`(${scoutPf!.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
assert.equal(vm.runInNewContext(pfCode, { row: {} }), '—', 'unavailable scout PF remains a dash, not an invalid toFixed call');
assert.equal(vm.runInNewContext(pfCode, { row: { win84: { pf: 1.234 } } }), '1.23');

assert.equal(status({ ...recommend, appliedAt, application: { status: 'BLOCKED' } }, appliedState, metadata).appliedAt,
  undefined, 'a missing blocked event date must not borrow the previous application date');
assert.match(status({ ticker: 'EURUSD', status: 'RECOMMEND' }, {}, { autotune: { asset_fingerprint: 'legacy-meta' } }).applicationLabel,
  /aplicación automática pendiente/, 'missing report timestamps are not proof of matching application');
console.log('PASS: missing event dates and report timestamps never manufacture application evidence');
