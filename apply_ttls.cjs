const fs = require('fs');
const file = 'jarvis-os/src/services/backtestEngine.ts';
let code = fs.readFileSync(file, 'utf8');

// 1. VWAP assignments
const vwapTarget = `    if (!state.vwapStatus) state.vwapStatus = {};
    state.vwapStatus[eventTf] = vwapMatch[1];`;
const vwapRepl = `    if (!state.vwapStatus) state.vwapStatus = {};
    if (!state.vwapTs) state.vwapTs = {};
    state.vwapStatus[eventTf] = vwapMatch[1];
    state.vwapTs[eventTf] = nowMs;`;

if (code.includes(vwapTarget)) {
  code = code.replace(vwapTarget, vwapRepl);
}

// 2. Bias assignments 1 (BIAS_CHANGE)
const biasTarget1 = `    if (p.trendMatch) state.marketBias[sourceTf] = p.trendMatch;`;
const biasRepl1 = `    if (p.trendMatch) {
      if (!state.biasTs) state.biasTs = {};
      state.marketBias[sourceTf] = p.trendMatch;
      state.biasTs[sourceTf] = nowMs;
    }`;

if (code.includes(biasTarget1)) {
  code = code.replace(biasTarget1, biasRepl1);
}

// 3. Bias assignments 2 (EVENTO_BOS)
const biasTarget2 = `    state.marketBias[eventTf] = currentDirection;`;
const biasRepl2 = `    if (!state.biasTs) state.biasTs = {};
    state.marketBias[eventTf] = currentDirection;
    state.biasTs[eventTf] = nowMs;`;

if (code.includes(biasTarget2)) {
  code = code.replace(biasTarget2, biasRepl2);
}

// 4. Extracting Bias with TTL
const biasExtTarget = `    const isMacroAligned = (state.marketBias['240'] === currentDirection) || (state.marketBias['60'] === currentDirection);
    const isDAgainst = state.marketBias['D'] !== currentDirection && state.marketBias['D'] !== 'NEUTRAL';
    const is4HAgainst = state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL';
    const is1HAgainst = state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL';`;

const biasExtRepl = `    const BIAS_TTL: Record<string, number> = { '60': 8*3600e3, '240': 48*3600e3, '1D': 120*3600e3, 'D': 120*3600e3, '4H': 48*3600e3, '1H': 8*3600e3 };
    const freshBias = (tf: string) => (nowMs - (state.biasTs?.[tf] ?? 0) < (BIAS_TTL[tf] ?? 24*3600e3)) ? state.marketBias?.[tf] : undefined;
    const mb240 = freshBias('240'); const mb60 = freshBias('60'); const mbD = freshBias('D') || freshBias('1D');
    
    const isMacroAligned = (mb240 === currentDirection) || (mb60 === currentDirection);
    const isDAgainst = mbD !== undefined && mbD !== currentDirection && mbD !== 'NEUTRAL';
    const is4HAgainst = mb240 !== undefined && mb240 !== currentDirection && mb240 !== 'NEUTRAL';
    const is1HAgainst = mb60 !== undefined && mb60 !== currentDirection && mb60 !== 'NEUTRAL';`;

if (code.includes(biasExtTarget)) {
  code = code.replace(biasExtTarget, biasExtRepl);
}

// 5. Extracting VWAP with TTL
const vwapExtTarget = `    state.vwapStatus = state.vwapStatus || {};
    const vwap15m = state.vwapStatus['15'] || (upperText.match(/VWAP:\\s*(UNDER|OVER)/)?.[1]);
    const vwap1H = state.vwapStatus['60'];
    const vwap4H = state.vwapStatus['240'];`;

const vwapExtRepl = `    const VWAP_TTL: Record<string, number> = { '15': 2*3600e3, '60': 8*3600e3, '240': 48*3600e3 };
    const freshVwap = (tf: string) => (nowMs - (state.vwapTs?.[tf] ?? 0) < (VWAP_TTL[tf] ?? 4*3600e3)) ? state.vwapStatus?.[tf] : undefined;
    
    const vwap15m = freshVwap('15') || (upperText.match(/VWAP:\\s*(UNDER|OVER)/)?.[1]);
    const vwap1H = freshVwap('60');
    const vwap4H = freshVwap('240');`;

if (code.includes(vwapExtTarget)) {
  code = code.replace(vwapExtTarget, vwapExtRepl);
}

// 6. Bias Extracting lower down (line 825 roughly)
const biasExtTarget2 = `    const biasD = state.marketBias['D'] || state.marketBias['1D'];
    const bias4H = state.marketBias['4H'] || state.marketBias['240'];
    const bias1H = state.marketBias['1H'] || state.marketBias['60'];`;

const biasExtRepl2 = `    const biasD = freshBias('D') || freshBias('1D');
    const bias4H = freshBias('4H') || freshBias('240');
    const bias1H = freshBias('1H') || freshBias('60');`;

if (code.includes(biasExtTarget2)) {
  code = code.replace(biasExtTarget2, biasExtRepl2);
}

fs.writeFileSync(file, code);
console.log('Applied TTL updates');
