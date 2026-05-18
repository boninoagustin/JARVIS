import fs from 'fs';

const ote = 62;
const leg = { dir: 'BUY', origin: 100, extreme: 200 };
const r2 = Math.abs(leg.origin - leg.extreme);
const entryLevel = leg.dir === 'BUY' ? leg.extreme - (r2 * (ote / 100)) : leg.extreme + (r2 * (ote / 100));
const adjustedSL = leg.origin;
const tp1 = leg.extreme;

const pnlTp1 = Math.abs(tp1 - entryLevel) / entryLevel * 100;
const slLossPct = Math.abs(adjustedSL - entryLevel) / entryLevel * 100;
const rMultipleTp1 = (pnlTp1 / slLossPct) * 0.5;

console.log('Entry:', entryLevel);
console.log('SL:', adjustedSL);
console.log('TP1:', tp1);
console.log('Distance to SL:', Math.abs(adjustedSL - entryLevel));
console.log('Distance to TP1:', Math.abs(tp1 - entryLevel));
console.log('rMultipleTp1:', rMultipleTp1);
console.log('Cash:', rMultipleTp1 * 50);
