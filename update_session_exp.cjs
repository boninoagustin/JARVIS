const fs = require('fs');
const file = 'jarvis-os/src/services/backtestEngine.ts';
let code = fs.readFileSync(file, 'utf8');

const target1 = `  if (trade.direction === 'BUY') dailyStats.buyLossCount = 0;
  }`;

const repl1 = `  if (trade.direction === 'BUY') dailyStats.buyLossCount = 0;
  }
  
  if (!dailyStats.sessionExp) dailyStats.sessionExp = {};
  const currentSession = dailyStats.currentSessionStr;
  const e = (dailyStats.sessionExp[currentSession] ??= { n: 0, sumR: 0 });
  e.n++; e.sumR += trade.rMultiple;`;

if (code.includes(target1) && !code.includes('dailyStats.sessionExp = {}')) {
  code = code.replace(target1, repl1);
  console.log('Added sessionExp logic to updateDailyStatsFromClose');
} else {
  console.log('Target 1 not found or already applied');
}

// target2: Trigger validation, after scoreMultiplier assignment
const target2 = `    if (alignedTfs >= 3) scoreMultiplier = 1.3;
    else if (againstTfs >= 2) scoreMultiplier = 0.6;
    else if (biasD && biasD !== tradeDir) scoreMultiplier = 0.8;

    totalPoints = Math.floor(totalPoints * scoreMultiplier);`;

const repl2 = `    if (alignedTfs >= 3) scoreMultiplier = 1.3;
    else if (againstTfs >= 2) scoreMultiplier = 0.6;
    else if (biasD && biasD !== tradeDir) scoreMultiplier = 0.8;

    totalPoints = Math.floor(totalPoints * scoreMultiplier);

    const session = getSessionForTimestamp(nowMs);
    const se = dailyStats.sessionExp?.[session];
    if (se && se.n >= 10 && se.sumR / se.n < 0) {
      totalPoints = Math.floor(totalPoints * 0.8);
    }`;

if (code.includes(target2) && !code.includes('se.sumR / se.n < 0')) {
  code = code.replace(target2, repl2);
  console.log('Added sessionExp validation logic to trigger validation');
} else {
  console.log('Target 2 not found or already applied');
}

fs.writeFileSync(file, code);
