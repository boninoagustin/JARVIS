const fs = require('fs');

let code = fs.readFileSync('src/engine/PortfolioModel.ts', 'utf8');

// Fix 1: Type safety for ActiveTrade
code = code.replace(
  "import type { GlobalPortfolioConfig } from './Types.js';",
  "import type { GlobalPortfolioConfig, ActiveTrade } from './Types.js';"
);

// Fix 2: Cache race conditions
code = code.replace(
  "const riskCache = new Map<string, { at: number; result: any }>();",
  "const riskCache = new Map<string, { at: number; result?: any; promise?: Promise<any> }>();"
);

// We need to implement a mutex wrapper for evaluateGlobalRisk, countDailySellsForTicker, etc.
// But it's easier to just write a caching wrapper function.
// Actually, let's just edit it using AST or manually. Since it's big, I'll write a full replacement.
