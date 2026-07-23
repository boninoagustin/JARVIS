const fs = require('fs');

let content = fs.readFileSync('src/engine/PortfolioModel.ts', 'utf8');

// 1. Add import
if (!content.includes("import { GlobalPortfolioConfig }")) {
    content = content.replace("export interface KillswitchResult", "import { GlobalPortfolioConfig } from './Types.js';\n\nexport interface KillswitchResult");
}

// 2. Add helper
if (!content.includes("function getArgentinaMidnightMs")) {
    const helper = `\nfunction getArgentinaMidnightMs(nowMs: number): number {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
    const [year, month, day] = formatter.format(new Date(nowMs)).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 3, 0, 0)).getTime();
}\n\n`;
    content = content.replace("export async function evaluateGlobalRisk", helper + "export async function evaluateGlobalRisk");
}

// 3. Update signatures
content = content.replace(
    /export async function evaluateGlobalRisk\([\s\S]*?db: any\n\): Promise<KillswitchResult> \{/,
    `export async function evaluateGlobalRisk(
    nowMs: number,
    globalPortfolioConfig: GlobalPortfolioConfig,
    currentKillswitchUntil: number,
    currentSession: string,
    db: FirebaseFirestore.Firestore
): Promise<KillswitchResult> {`
);

content = content.replace(
    /export async function countDailySellsForTicker\(db: any, /g,
    `export async function countDailySellsForTicker(db: FirebaseFirestore.Firestore, `
);

content = content.replace(
    /export async function countDailyBuysForTicker\(db: any, /g,
    `export async function countDailyBuysForTicker(db: FirebaseFirestore.Firestore, `
);

content = content.replace(
    /export async function countConsecutiveLossesForAsset\(db: any, /g,
    `export async function countConsecutiveLossesForAsset(db: FirebaseFirestore.Firestore, `
);

// 4. Replace midnight calculation logic with the helper call
const midnightRegex1 = /const now = new Date\(nowMs\);\s*const formatter = new Intl\.DateTimeFormat\('en-CA'[^;]+;\s*const argDateStr = formatter\.format\(now\);\s*const dateParts = argDateStr\.split\('-'\);\s*const year = parseInt\(dateParts\[0\]\);\s*const month = parseInt\(dateParts\[1\]\) - 1;\s*const day = parseInt\(dateParts\[2\]\);\s*const artMidnight = new Date\(Date\.UTC\(year, month, day, 3, 0, 0\)\);\s*const artMidnightMs = artMidnight\.getTime\(\);/g;
content = content.replace(midnightRegex1, "const artMidnightMs = getArgentinaMidnightMs(nowMs);");

const midnightRegex2 = /const now = new Date\(nowMs\);\s*const formatter = new Intl\.DateTimeFormat\('en-CA'[^;]+;\s*const argDateStr = formatter\.format\(now\);\s*const dateParts = argDateStr\.split\('-'\);\s*const artMidnightMs = new Date\(Date\.UTC\(parseInt\(dateParts\[0\]\), parseInt\(dateParts\[1\]\) - 1, parseInt\(dateParts\[2\]\), 3, 0, 0\)\)\.getTime\(\);/g;
content = content.replace(midnightRegex2, "const artMidnightMs = getArgentinaMidnightMs(nowMs);");

fs.writeFileSync('src/engine/PortfolioModel.ts', content);
console.log("PortfolioModel.ts updated successfully.");
