const fs = require('fs');
const file = 'jarvis-os/src/services/backtestEngine.ts';
let code = fs.readFileSync(file, 'utf8');

// 1) Remove the consecutive losses logic from CHoCH processing
const target1 = `    // Consecutive losses escalation (ported from live)
    if (dailyStats.consecutiveLosses >= 2) minPtsRequired += 2;`;

const repl1 = `    // Escalado de umbral removido: la calidad de la señal debe ser constante.
    // Usaremos riskMult (Anti-martingala inversa) en su lugar.`;

if (code.includes(target1)) {
  code = code.replace(target1, repl1);
} else {
  console.log("target1 not found");
}

// 2) Add riskMult to oteData where the CHoCH / SMART trade is created
// We need to find: const oteData = { ... events: [...activeScore.events, ...
// We can just calculate riskMult when creating the trade.
// Let's modify the createTrade function directly so we don't have to change all places where trades are created!
const target2 = `// --- CREATE TRADE ---
function createTrade(oteData: any, nowMs: number, trades: BacktestTrade[], activeTrades: Map<string, BacktestTrade>, dailyStats: DailyStats, config: BacktestConfig, state: any) {
  if (dailyStats.isKilled) return;`;

const repl2 = `// --- CREATE TRADE ---
function createTrade(oteData: any, nowMs: number, trades: BacktestTrade[], activeTrades: Map<string, BacktestTrade>, dailyStats: DailyStats, config: BacktestConfig, state: any) {
  if (dailyStats.isKilled) return;

  const riskMult = dailyStats.consecutiveLosses >= 3 ? 0.25 :
                   dailyStats.consecutiveLosses >= 2 ? 0.5 : 1.0;
  oteData.riskMult = riskMult;`;

if (code.includes(target2)) {
  code = code.replace(target2, repl2);
} else {
  console.log("target2 not found");
}

// 3) Push riskMult into the newTrade inside createTrade
const target3 = `    events: oteData.events,
    grade: \`\${oteData.points} pts\`,
    tf: oteData.tf
  };`;

const repl3 = `    events: oteData.events,
    grade: \`\${oteData.points} pts\`,
    tf: oteData.tf,
    riskMult: oteData.riskMult
  };`;

if (code.includes(target3)) {
  code = code.replace(target3, repl3);
} else {
  console.log("target3 not found");
}

// 4) Apply riskMult to the TP1 win in the activeTrades loop
const targetTp1 = `trade.rMultipleTp1 = slLossPct > 0 ? (trade.pnlTp1 / slLossPct) * 0.5 : 0.5;`;
const replTp1 = `trade.rMultipleTp1 = (slLossPct > 0 ? (trade.pnlTp1 / slLossPct) * 0.5 : 0.5) * (trade.riskMult || 1.0);`;
if (code.includes(targetTp1)) {
  code = code.replace(targetTp1, replTp1);
} else {
  console.log("targetTp1 not found");
}

// 5) Apply riskMult to the TP2 win
const targetTp2 = `          const grossR = initialSlLossPct > 0 ? finalPnl / initialSlLossPct : 1.5;
          trade.rMultiple = grossR - transactionCostR;`;
const replTp2 = `          const grossR = initialSlLossPct > 0 ? finalPnl / initialSlLossPct : 1.5;
          trade.rMultiple = (grossR - transactionCostR) * (trade.riskMult || 1.0);`;
if (code.includes(targetTp2)) {
  code = code.replace(targetTp2, replTp2);
} else {
  console.log("targetTp2 not found");
}

// 6) Apply riskMult to the SL (or SL in BE/TP1 partial)
const targetSl = `        const grossR = initialSlLossPct > 0 ? finalPnlPct / initialSlLossPct : 0;
        trade.rMultiple = grossR - transactionCostR;`;
const replSl = `        const grossR = initialSlLossPct > 0 ? finalPnlPct / initialSlLossPct : 0;
        trade.rMultiple = (grossR - transactionCostR) * (trade.riskMult || 1.0);`;
if (code.includes(targetSl)) {
  code = code.replace(targetSl, replSl);
} else {
  console.log("targetSl not found");
}

// Also the tp2 final calculation
const targetTp2Sub = `trade.rMultipleTp2 = initialSlLossPct > 0 ? (pnlTp2 / initialSlLossPct) * 0.5 : 0.75;`;
const replTp2Sub = `trade.rMultipleTp2 = (initialSlLossPct > 0 ? (pnlTp2 / initialSlLossPct) * 0.5 : 0.75) * (trade.riskMult || 1.0);`;
if (code.includes(targetTp2Sub)) {
  code = code.replace(targetTp2Sub, replTp2Sub);
} else {
  console.log("targetTp2Sub not found");
}

fs.writeFileSync(file, code);
console.log('Risk Multiplier logic added');
