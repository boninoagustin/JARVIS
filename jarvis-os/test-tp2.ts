import fs from 'fs';

const configFixedRR = 1.5;
const riskDist = 38;
const entryPrice = 138;
const adjustedSL = 100;
const currentDirection = 'BUY';
const fixedTP2 = currentDirection === 'BUY'
  ? entryPrice + (riskDist * configFixedRR)
  : entryPrice - (riskDist * configFixedRR);
const tp2Price = fixedTP2;

const pnlTp2 = Math.abs(tp2Price - entryPrice) / entryPrice * 100;
const slLossPct = Math.abs(adjustedSL - entryPrice) / entryPrice * 100;

const rMultipleTp2 = (pnlTp2 / slLossPct) * 0.5;

console.log('pnlTp2:', pnlTp2);
console.log('slLossPct:', slLossPct);
console.log('rMultipleTp2:', rMultipleTp2);
console.log('TP2 PnL Cash:', rMultipleTp2 * 50);

