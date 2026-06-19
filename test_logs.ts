import fs from 'fs';
import path from 'path';
import { replayUploadedLogs } from './src/services/backtesting.js';

async function main() {
  const logDir = path.join(process.cwd(), 'logs');
  const files = fs.readdirSync(logDir).filter(f => f.endsWith('.csv'));
  
  const logsMap = new Map<string, string[]>();
  for (const file of files) {
    const content = fs.readFileSync(path.join(logDir, file), 'utf8');
    const lines = content.split('\n');
    let tf = 'unknown';
    // try to guess tf from first line with TF
    for (const line of lines) {
        const tfMatch = line.match(/TF:\s*(\d+)/i);
        if (tfMatch) {
            tf = tfMatch[1];
            break;
        }
    }
    logsMap.set(tf, lines);
    console.log(`Loaded TF ${tf} from ${file} (${lines.length} lines)`);
  }

  await replayUploadedLogs(logsMap, 'EURUSD', 'Debug', 6, 6, Infinity);
}

main().catch(console.error);
