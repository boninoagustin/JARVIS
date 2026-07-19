const fs = require('fs');

// 1. Fix missing imports in backtestEngine.ts
const engineFile = '/home/bon/Descargas/JARVIS/jarvis-os/src/services/backtestEngine.ts';
let code = fs.readFileSync(engineFile, 'utf8');
code = code.replace("import { evaluateImpulseCore, evaluateMacroStretching } from '../engine/AlphaModel';", "import { evaluateImpulseCore, evaluateMacroStretching, isInsideMacroOteZone, calculateDynamicSlBuffer } from '../engine/AlphaModel';");
code = code.replace("state, nowMs, null, ctx)", "state as any, nowMs, null, ctx)");
code = code.replace("state, nowMs, null, ctx)", "state as any, nowMs, null, ctx)");
fs.writeFileSync(engineFile, code);

// 2. Fix import type in AlphaModel.ts
const alphaFile = '/home/bon/Descargas/JARVIS/jarvis-os/src/engine/AlphaModel.ts';
let alphaCode = fs.readFileSync(alphaFile, 'utf8');
alphaCode = alphaCode.replace("import { RadarZone, RadarState }", "import type { RadarZone, RadarState }");
alphaCode = alphaCode.replace("import { ImpulseLeg, ActiveTrade }", "import type { ImpulseLeg, ActiveTrade }");
fs.writeFileSync(alphaFile, alphaCode);

// 3. Fix import type in FrictionModel.ts
const frictionFile = '/home/bon/Descargas/JARVIS/jarvis-os/src/engine/FrictionModel.ts';
let frictionCode = fs.readFileSync(frictionFile, 'utf8');
frictionCode = frictionCode.replace("import { ActiveTrade }", "import type { ActiveTrade }");
fs.writeFileSync(frictionFile, frictionCode);

// 4. Fix import type in StateStore.ts
const stateFile = '/home/bon/Descargas/JARVIS/jarvis-os/src/engine/StateStore.ts';
let stateCode = fs.readFileSync(stateFile, 'utf8');
stateCode = stateCode.replace("import { ActiveTrade, RadarState, AssetSessionConfig, GlobalPortfolioConfig }", "import type { ActiveTrade, RadarState, AssetSessionConfig, GlobalPortfolioConfig }");
fs.writeFileSync(stateFile, stateCode);

