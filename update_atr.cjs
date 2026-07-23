const fs = require('fs');
const path1 = 'jarvis-os/src/services/backtestEngine.ts';
let code1 = fs.readFileSync(path1, 'utf8');

// 1. In PING_PRICE, calculate ATR14
const pingPriceTarget = `  if (prefix === 'PING_PRICE') {
    if (p.currentPrice === undefined) return;
    const currentPrice = p.currentPrice;
    const highPrice = p.highPrice !== undefined ? p.highPrice : currentPrice;
    const lowPrice = p.lowPrice !== undefined ? p.lowPrice : currentPrice;

    const previousPrice = state.lastPrice;`;

const pingPriceRepl = `  if (prefix === 'PING_PRICE') {
    if (p.currentPrice === undefined) return;
    const currentPrice = p.currentPrice;
    const highPrice = p.highPrice !== undefined ? p.highPrice : currentPrice;
    const lowPrice = p.lowPrice !== undefined ? p.lowPrice : currentPrice;

    const tr = highPrice - lowPrice;
    const alpha = 1 / 14;
    state.atr14 = state.atr14 === undefined ? tr : state.atr14 + alpha * (tr - state.atr14);

    const previousPrice = state.lastPrice;`;

if (code1.includes(pingPriceTarget)) {
  code1 = code1.replace(pingPriceTarget, pingPriceRepl);
  console.log("Updated PING_PRICE in backtestEngine.ts");
} else {
  console.log("Could not find PING_PRICE target in backtestEngine.ts");
}

// 2. Zone buffer using ATR
const zoneBufferTarget = `    const buffer = getBuffer(ticker, currentPrice);`;
const zoneBufferRepl = `    const buffer = Math.max(getBuffer(ticker, currentPrice), (state.atr14 ?? 0) * 0.25);`;
if (code1.includes(zoneBufferTarget)) {
  code1 = code1.replace(zoneBufferTarget, zoneBufferRepl);
  console.log("Updated zone buffer in backtestEngine.ts");
}

// 3. Spatial buffer using ATR
const spatialBufferTarget = `    const spatialBuffer = getBuffer(ticker, chOrigin ?? state.lastPrice ?? 0);`;
const spatialBufferRepl = `    const spatialBuffer = Math.max(getBuffer(ticker, chOrigin ?? state.lastPrice ?? 0), (state.atr14 ?? 0) * 0.25);`;
if (code1.includes(spatialBufferTarget)) {
  code1 = code1.replace(spatialBufferTarget, spatialBufferRepl);
  console.log("Updated spatial buffer in backtestEngine.ts");
}

// 4. Structural Buffer for SL using ATR
// This was added earlier:
const structBufferTarget = `        const structuralBuffer = Math.max(
          2 * (config.spreadPips ?? 0.1) * pipSize,
          Math.abs(activeLeg.extreme - activeLeg.origin) * 0.075
        );`;
const structBufferRepl = `        const structuralBuffer = Math.max(
          2 * (config.spreadPips ?? 0.1) * pipSize,
          (state.atr14 ?? 0) * 0.5
        );`;
if (code1.includes(structBufferTarget)) {
  code1 = code1.replace(structBufferTarget, structBufferRepl);
  console.log("Updated structural buffer for SL in backtestEngine.ts");
} else {
  console.log("Could not find structural buffer target in backtestEngine.ts");
}

const structBufferTarget2 = `          const structuralBuffer = Math.max(
            2 * (config.spreadPips ?? 0.1) * pipSize,
            Math.abs(activeLeg.extreme - activeLeg.origin) * 0.075
          );`;
const structBufferRepl2 = `          const structuralBuffer = Math.max(
            2 * (config.spreadPips ?? 0.1) * pipSize,
            (state.atr14 ?? 0) * 0.5
          );`;
if (code1.includes(structBufferTarget2)) {
  code1 = code1.replace(structBufferTarget2, structBufferRepl2);
  console.log("Updated structural buffer for SL 2 in backtestEngine.ts");
}

fs.writeFileSync(path1, code1);

const path2 = 'src/engine/AlphaModel.ts';
let code2 = fs.readFileSync(path2, 'utf8');

// 5. Invalidation OTE in AlphaModel.ts
const oteInvTarget = `    const range = Math.abs(leg.extreme - leg.origin);
    const atrEstimate = range * 0.3;
    const priceBeyondExtreme = leg.direction === 'BUY' 
        ? (currentPrice > leg.extreme + atrEstimate) 
        : (currentPrice < leg.extreme - atrEstimate);`;

const oteInvRepl = `    const range = Math.abs(leg.extreme - leg.origin);
    const atrEstimate = state.atr14 ?? (range * 0.3); // Fallback if no atr14
    const priceBeyondExtreme = leg.direction === 'BUY' 
        ? (currentPrice > leg.extreme + atrEstimate) 
        : (currentPrice < leg.extreme - atrEstimate);`;

if (code2.includes(oteInvTarget)) {
  code2 = code2.replace(oteInvTarget, oteInvRepl);
  console.log("Updated OTE Invalidation in AlphaModel.ts");
} else {
  console.log("Could not find OTE Invalidation target in AlphaModel.ts");
}

fs.writeFileSync(path2, code2);
