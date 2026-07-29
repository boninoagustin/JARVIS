import * as fs from 'fs';

const pineData = fs.readFileSync('logs/history_exported/pine-logs-SMC Master_M15_filtered.csv', 'utf8').split('\n');
const jsData = fs.readFileSync('logs/history_exported/pine-logs-SMC Master_M15.csv', 'utf8').split('\n');

const getPayload = (line: string) => {
    const match = line.match(/Payload: (\[.*?\])/);
    if (!match) return null;
    let p = match[1];
    p = p.replace(/""/g, '"');
    try {
        return JSON.parse(p);
    } catch (e) {
        return null;
    }
};

const getTS = (line: string) => {
    const match = line.match(/TS: (\d+)/);
    return match ? parseInt(match[1]) : null;
};

const pineMap = new Map();
for (const line of pineData) {
    if (line.includes('SYNC_ZONES')) {
        const ts = getTS(line);
        if (ts) pineMap.set(ts, getPayload(line));
    }
}

for (const line of jsData) {
    if (!line.includes('SYNC_ZONES')) continue;
    const ts = getTS(line);
    if (!ts) continue;
    if (ts === 1784268900000) {
        console.log(`TS=${ts}`);
        console.log(`PINE PAYLOAD:`, pineMap.get(ts));
        console.log(`JS PAYLOAD:`, getPayload(line));
        break;
    }
}
