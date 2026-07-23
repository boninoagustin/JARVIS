const fs = require('fs');
const file = 'jarvis-os/src/services/backtestEngine.ts';
let code = fs.readFileSync(file, 'utf8');

const target1 = `  const upperText = alertText.toUpperCase();

  // Extract VWAP status globally for the event timeframe`;

const repl1 = `  const upperText = alertText.toUpperCase();

  // --- TICK DENSITY (ACTIVITY PROXY) ---
  state.tickTimes = (state.tickTimes ?? []).filter(t => nowMs - t < 3600000);
  state.tickTimes.push(nowMs);
  const density = state.tickTimes.length;
  const a = 1 / 50;
  state.densityMedian = state.densityMedian === undefined ? density 
    : state.densityMedian + a * (density - state.densityMedian);

  // Extract VWAP status globally for the event timeframe`;

if (code.includes(target1)) {
  code = code.replace(target1, repl1);
  console.log("Updated target1");
} else {
  console.log("Could not find target1");
}

const target2 = `  else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
    if (!activeScore.events.includes(\`Sweep_\${readableTf}\`)) {
      if (upperText.includes('ABSORCION')) { addedPoints = 6; activeScore.events.push(\`🩸_V-Shape_Absorb_\${readableTf}\`); }
      else { addedPoints = 3; activeScore.events.push(\`Sweep_\${readableTf}\`); }
    }
  }`;

const repl2 = `  else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
    if (!activeScore.events.includes(\`Sweep_\${readableTf}\`)) {
      if (upperText.includes('ABSORCION') && density >= state.densityMedian) { 
        addedPoints = 6; 
        activeScore.events.push(\`🩸_V-Shape_Absorb_\${readableTf}\`); 
      } else if (upperText.includes('ABSORCION')) { 
        addedPoints = 3; 
        activeScore.events.push(\`Sweep_\${readableTf}\`); // sin confirmación de actividad       
      } else { 
        addedPoints = 3; 
        activeScore.events.push(\`Sweep_\${readableTf}\`); 
      }
    }
  }`;

if (code.includes(target2)) {
  code = code.replace(target2, repl2);
  console.log("Updated target2");
} else {
  console.log("Could not find target2");
}

fs.writeFileSync(file, code);
