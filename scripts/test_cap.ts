import { capTp2Price } from '../src/engine/tp2Cap';
// Trade real de Bon: SELL entry 1.16271, SL 1.1655468, TP2 1.1592125
const tp2 = capTp2Price('EURUSD', 'SELL', 1.16271, 1.1655468, 1.1592125);
console.log('TP2 original: 1.1592125 (35.0 pips)');
console.log(`TP2 capeado:  ${tp2.toFixed(7)} (${((1.16271 - tp2) / 0.0001).toFixed(1)} pips)`);
// XAUUSD: entry 4000, SL 3985 (15 pips = 1.5$), TP2 3985-60=3925
const x = capTp2Price('XAUUSD', 'SELL', 4000, 4015, 3925);
console.log(`XAUUSD: TP2 ${((4000 - x) / 0.1).toFixed(1)} pips (cap ADR 0.5*800=400)`);
