const isBull = true;
const useBody = true;
const high = 1.14414, low = 1.14327, open = 1.14387, close = 1.14368;

const pineTop = isBull ? high : (useBody ? Math.max(open, close) : high);
const pineBtm = isBull ? (useBody ? Math.min(open, close) : low) : low;
console.log(`Pine: top=${pineTop}, btm=${pineBtm}`);

const jsBtm = isBull ? low : (useBody ? Math.min(open, close) : low);
const jsTop = !isBull ? high : (useBody ? Math.max(open, close) : high);
console.log(`JS: top=${jsTop}, btm=${jsBtm}`);
