const fs = require('fs');
const file = 'jarvis-os/src/services/backtestEngine.ts';
let code = fs.readFileSync(file, 'utf8');

const isNewsBlackoutFn = `
export function isNewsBlackout(ts: number): boolean {
  const d = new Date(ts);
  const t = d.getUTCHours() * 60 + d.getUTCMinutes();
  const inW = (a: number, b: number) => t >= a && t <= b;
  const usData = inW(12 * 60 + 25, 12 * 60 + 40) || inW(13 * 60 + 55, 14 * 60 + 10);
  const nfp = d.getUTCDay() === 5 && d.getUTCDate() <= 7 && inW(12 * 60 + 20, 13 * 60);
  return usData || nfp;
}
`;

if (!code.includes('isNewsBlackout(ts: number)')) {
    code += isNewsBlackoutFn;
}

const target = `  if (config.maxTradesPerSession && dailyStats.sessionTradeCount >= config.maxTradesPerSession) {
      return;
  }

  // 🛡️ ANTI-PYRAMIDACIÓN & SAR`;

const repl = `  if (config.maxTradesPerSession && dailyStats.sessionTradeCount >= config.maxTradesPerSession) {
      return;
  }

  if (isNewsBlackout(nowMs)) return;

  // 🛡️ ANTI-PYRAMIDACIÓN & SAR`;

if (code.includes(target) && !code.includes('isNewsBlackout(nowMs)')) {
    code = code.replace(target, repl);
    console.log('Added news blackout check');
} else if (code.includes('isNewsBlackout(nowMs)')) {
    console.log('News blackout already present');
} else {
    console.log('Could not find createTrade target');
}

fs.writeFileSync(file, code);
