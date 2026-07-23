const fs = require('fs');
const file = 'jarvis-os/src/services/backtestEngine.ts';
let code = fs.readFileSync(file, 'utf8');

const target1 = `        const decimals = getDecimals(ticker);
        const activeSlBufferPercent = 0; // SL Buffer only applies to OTE entries
        const activeFixedRR = sessionConfig?.fixedRR ?? config.fixedRR ?? 2.0;

        const slBufferAmt = calculateDynamicSlBuffer(ticker, activeLeg.origin, activeSlBufferPercent);
        const adjustedSL = currentDirection === 'BUY' ? activeLeg.origin - slBufferAmt : activeLeg.origin + slBufferAmt;`;

const repl1 = `        const decimals = getDecimals(ticker);
        const structuralBuffer = Math.max(
          2 * (config.spreadPips ?? 0.1) * pipSize,
          Math.abs(activeLeg.extreme - activeLeg.origin) * 0.075
        );
        const adjustedSL = currentDirection === 'BUY'
          ? activeLeg.origin - structuralBuffer
          : activeLeg.origin + structuralBuffer;
        const activeFixedRR = sessionConfig?.fixedRR ?? config.fixedRR ?? 2.0;`;

const target2 = `            // 🆕 TRAILING STOP ESTRUCTURAL POST-TP1 (Mejora 4)
            for (const [, trade] of activeTrades) {
              if (trade.direction === 'BUY' && trade.tp1Hit && !trade.closeTimestamp) {
                if (newOrigin > trade.slPrice) {
                  trade.slPrice = newOrigin;
                }
              }
            }
          } else {
            state.activeImpulseSell = newLeg;
            // 🆕 TRAILING STOP ESTRUCTURAL POST-TP1 (Mejora 4)
            for (const [, trade] of activeTrades) {
              if (trade.direction === 'SELL' && trade.tp1Hit && !trade.closeTimestamp) {
                if (newOrigin < trade.slPrice) {
                  trade.slPrice = newOrigin;
                }
              }
            }
          }`;

const repl2 = `            // 🆕 TRAILING STOP ESTRUCTURAL POST-TP1 (Mejora 4)
            for (const [, trade] of activeTrades) {
              if (trade.direction === 'BUY' && trade.tp1Hit && !trade.closeTimestamp) {
                const structuralBuffer = Math.max(
                  2 * (config.spreadPips ?? 0.1) * pipSize,
                  Math.abs(actualPrice - newOrigin) * 0.075
                );
                const trailedSL = newOrigin - structuralBuffer;
                if (trailedSL > trade.slPrice) {
                  trade.slPrice = trailedSL;
                }
              }
            }
          } else {
            state.activeImpulseSell = newLeg;
            // 🆕 TRAILING STOP ESTRUCTURAL POST-TP1 (Mejora 4)
            for (const [, trade] of activeTrades) {
              if (trade.direction === 'SELL' && trade.tp1Hit && !trade.closeTimestamp) {
                const structuralBuffer = Math.max(
                  2 * (config.spreadPips ?? 0.1) * pipSize,
                  Math.abs(actualPrice - newOrigin) * 0.075
                );
                const trailedSL = newOrigin + structuralBuffer;
                if (trailedSL < trade.slPrice) {
                  trade.slPrice = trailedSL;
                }
              }
            }
          }`;

if (code.includes(target1)) {
  code = code.replace(target1, repl1);
} else {
  console.log('Failed to find target1');
}

if (code.includes(target2)) {
  code = code.replace(target2, repl2);
} else {
  console.log('Failed to find target2');
}

fs.writeFileSync(file, code);
console.log('SMC Logic updated');
