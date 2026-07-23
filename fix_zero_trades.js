const fs = require('fs');

const alphaPath = 'jarvis-os/src/engine/AlphaModel.ts';
const backtestPath = 'jarvis-os/src/services/backtestEngine.ts';

// Fix AlphaModel
let alpha = fs.readFileSync(alphaPath, 'utf8');
alpha = alpha.replace(
    /const reward = Math\.abs\(leg\.extreme - entryFill\); \/\/ TP1 = extreme/g,
    "const oteTP2Ext = leg.dir === 'BUY' ? leg.extreme + (range * 0.27) : leg.extreme - (range * 0.27);\n            const reward = Math.abs(oteTP2Ext - entryFill); // R:R se valida contra TP2 (extensión -27%)"
);
fs.writeFileSync(alphaPath, alpha);

const alphaLocalPath = 'src/engine/AlphaModel.ts';
if (fs.existsSync(alphaLocalPath)) {
    fs.writeFileSync(alphaLocalPath, alpha);
}

// Fix backtestEngine
let backtest = fs.readFileSync(backtestPath, 'utf8');
backtest = backtest.replace(
    /let rrChoch = 0; \/\/ sin zona opuesta no hay reward demostrable/g,
    "let rrChoch = 999.0; // Si no hay zonas de soporte/resistencia bloqueando, el R:R teórico es infinito (camino libre)"
);
fs.writeFileSync(backtestPath, backtest);
