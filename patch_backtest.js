const fs = require('fs');
const file = '/home/bon/Descargas/JARVIS/jarvis-os/src/services/backtestEngine.ts';
let code = fs.readFileSync(file, 'utf8');

// 1. Add imports
const imports = `import { evaluateImpulseCore, evaluateMacroStretching } from '../engine/AlphaModel';
import { evaluateNetTrade } from '../engine/FrictionModel';
`;
code = code.replace("import {\n  emptyState", imports + "import {\n  emptyState");

// 2. Remove functions
code = code.replace(/export function calculateDynamicSlBuffer[\s\S]*?return originPrice \* \(bufferConfig \/ 100\);\n}/, '');
code = code.replace(/function isInsideMacroOteZone[\s\S]*?return price >= oteBtm && price <= oteTop;\n  }\n}/, '');
code = code.replace(/function evaluateMacroStretching[\s\S]*?return leg;\n}/, '');
code = code.replace(/function evaluateImpulse\([\s\S]*?oteData:\s*\{\n\s*tradeId,\s*direction:\s*leg.dir,\s*\n\s*entryPrice:\s*entryLevel,\s*\n\s*stopLoss:\s*adjustedSL.toFixed\(decimals\),\s*\n\s*tp1:\s*tp1.toFixed\(decimals\),\s*\n\s*tp2:\s*tp2.toFixed\(decimals\),\s*\n\s*points:\s*totalPoints,\s*\n\s*events:\s*activeScore.events,\s*\n\s*tf:\s*tfFormatted,\n\s*oteEntryUsed:\s*activeOteEntryPercent\n\s*\}\n\s*\};\n\s*\}\n\s*return\s*\{\s*updatedLeg:\s*leg\s*\};\n\s*\}/, '');

// The regex for evaluateImpulse might be brittle. Let's do it by slicing line numbers.
