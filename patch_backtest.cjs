const fs = require('fs');
const file = '/home/bon/Descargas/JARVIS/jarvis-os/src/services/backtestEngine.ts';
let lines = fs.readFileSync(file, 'utf8').split('\n');

// Delete lines 99 to 327
lines.splice(98, 229);

// Delete lines 70 to 83 (index 69 to 82)
lines.splice(69, 14);

let code = lines.join('\n');

// 1. Add imports
const imports = `import { evaluateImpulseCore, evaluateMacroStretching } from '../engine/AlphaModel';
import { evaluateNetTrade } from '../engine/FrictionModel';
`;
code = code.replace("import {\n  emptyState", imports + "import {\n  emptyState");

fs.writeFileSync(file, code);
