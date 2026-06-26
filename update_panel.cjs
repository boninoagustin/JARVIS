const fs = require('fs');
let content = fs.readFileSync('jarvis-os/src/components/BacktestingPanel.tsx', 'utf8');

// 1. Update the state interface
content = content.replace(
  /choch: \{ enabled: boolean; minScore: number \};/g,
  'choch5m: { enabled: boolean; minScore: number };\n    choch15m: { enabled: boolean; minScore: number };'
);
content = content.replace(
  /bos: \{ enabled: boolean; minScore: number \};/g,
  'bos5m: { enabled: boolean; minScore: number };\n    bos15m: { enabled: boolean; minScore: number };'
);
content = content.replace(
  /oteChoch: \{ enabled: boolean; minScore: number; entryPercent\?: number \};/g,
  'oteChoch5m: { enabled: boolean; minScore: number; entryPercent?: number };\n    oteChoch15m: { enabled: boolean; minScore: number; entryPercent?: number };'
);
content = content.replace(
  /oteBos: \{ enabled: boolean; minScore: number; entryPercent\?: number \};/g,
  'oteBos5m: { enabled: boolean; minScore: number; entryPercent?: number };\n    oteBos15m: { enabled: boolean; minScore: number; entryPercent?: number };'
);

// 2. Update initial values
content = content.replace(
  /choch: \{ enabled: true, minScore: 5 \}/g,
  'choch5m: { enabled: true, minScore: 5 }, choch15m: { enabled: true, minScore: 5 }'
);
content = content.replace(
  /bos: \{ enabled: true, minScore: 10 \}/g,
  'bos5m: { enabled: true, minScore: 10 }, bos15m: { enabled: true, minScore: 10 }'
);
content = content.replace(
  /oteChoch: \{ enabled: true, minScore: 8, entryPercent: 62 \}/g,
  'oteChoch5m: { enabled: true, minScore: 8, entryPercent: 62 }, oteChoch15m: { enabled: true, minScore: 8, entryPercent: 62 }'
);
content = content.replace(
  /oteBos: \{ enabled: true, minScore: 8, entryPercent: 62 \}/g,
  'oteBos5m: { enabled: true, minScore: 8, entryPercent: 62 }, oteBos15m: { enabled: true, minScore: 8, entryPercent: 62 }'
);

// 3. Update parsed parsing logic
content = content.replace(/if \(!parsed\[s\]\.choch\) parsed\[s\]\.choch = \{ enabled: true, minScore: 5 \};/g,
  `if (!parsed[s].choch5m) parsed[s].choch5m = { enabled: true, minScore: 5 };
            if (!parsed[s].choch15m) parsed[s].choch15m = { enabled: true, minScore: 5 };`
);
content = content.replace(/if \(!parsed\[s\]\.bos\) parsed\[s\]\.bos = \{ enabled: true, minScore: 10 \};/g,
  `if (!parsed[s].bos5m) parsed[s].bos5m = { enabled: true, minScore: 10 };
            if (!parsed[s].bos15m) parsed[s].bos15m = { enabled: true, minScore: 10 };`
);
content = content.replace(/if \(!parsed\[s\]\.oteChoch\) parsed\[s\]\.oteChoch = \{ enabled: true, minScore: 8, entryPercent: 62 \};/g,
  `if (!parsed[s].oteChoch5m) parsed[s].oteChoch5m = { enabled: true, minScore: 8, entryPercent: 62 };
            if (!parsed[s].oteChoch15m) parsed[s].oteChoch15m = { enabled: true, minScore: 8, entryPercent: 62 };`
);
content = content.replace(/if \(!parsed\[s\]\.oteBos\) parsed\[s\]\.oteBos = \{ enabled: true, minScore: 8, entryPercent: 62 \};/g,
  `if (!parsed[s].oteBos5m) parsed[s].oteBos5m = { enabled: true, minScore: 8, entryPercent: 62 };
            if (!parsed[s].oteBos15m) parsed[s].oteBos15m = { enabled: true, minScore: 8, entryPercent: 62 };`
);
content = content.replace(/if \(parsed\[s\]\.oteChoch\.entryPercent === undefined\) parsed\[s\]\.oteChoch\.entryPercent = 62;/g,
  `if (parsed[s].oteChoch5m.entryPercent === undefined) parsed[s].oteChoch5m.entryPercent = 62;
            if (parsed[s].oteChoch15m.entryPercent === undefined) parsed[s].oteChoch15m.entryPercent = 62;`
);
content = content.replace(/if \(parsed\[s\]\.oteBos\.entryPercent === undefined\) parsed\[s\]\.oteBos\.entryPercent = 62;/g,
  `if (parsed[s].oteBos5m.entryPercent === undefined) parsed[s].oteBos5m.entryPercent = 62;
            if (parsed[s].oteBos15m.entryPercent === undefined) parsed[s].oteBos15m.entryPercent = 62;`
);

// 4. Update updateSessionTrigger definition
content = content.replace(
  /triggerType: 'choch' \| 'bos' \| 'oteChoch' \| 'oteBos' \| 'slBufferPercent' \| 'fixedRR' \| 'maxSellLosses' \| 'maxBuyLosses'/g,
  "triggerType: 'choch5m' | 'choch15m' | 'bos5m' | 'bos15m' | 'oteChoch5m' | 'oteChoch15m' | 'oteBos5m' | 'oteBos15m' | 'slBufferPercent' | 'fixedRR' | 'maxSellLosses' | 'maxBuyLosses'"
);
content = content.replace(
  /const type = triggerType as 'choch' \| 'bos' \| 'oteChoch' \| 'oteBos';/g,
  "const type = triggerType as 'choch5m' | 'choch15m' | 'bos5m' | 'bos15m' | 'oteChoch5m' | 'oteChoch15m' | 'oteBos5m' | 'oteBos15m';"
);

fs.writeFileSync('jarvis-os/src/components/BacktestingPanel.tsx', content, 'utf8');
console.log("Updated state parsing and definitions");
