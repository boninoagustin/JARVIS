import fs from 'fs';
import path from 'path';
import { replayUploadedLogs } from './src/services/backtesting.js';

const origLog = console.log;
console.log = (...args) => {
    const msg = args.join(' ');
    
    // Hide spam
    if (msg.includes('SYNC_ZONES')) return;
    if (msg.includes('Memoria restaurada')) return;
    if (msg.includes('[REPLAY]') && msg.includes('ev/s')) return; // Hide progress

    // Only show FIBO if it's a rejection or expiration
    if (msg.includes('[FIBO]')) {
        if (!msg.match(/ignorado|descartado|invalidado|EXPIRADO|INALCANZABLE/i)) {
            return; // Hide standard FIBO noise
        }
    }

    origLog(...args);
};

async function main() {
  const logDir = path.join(process.cwd(), 'logs');
  const files = fs.readdirSync(logDir).filter(f => f.endsWith('.csv'));
  
  const logsMap = new Map<string, string[]>();
  for (const file of files) {
    const content = fs.readFileSync(path.join(logDir, file), 'utf8');
    const lines = content.split('\n');
    let tf = 'unknown';
    const parsedLines = [];
    for (const line of lines) {
        if (!line.trim() || line.startsWith('Fecha')) continue;
        const cols = line.split(',');
        if (cols.length > 1) {
            const timeStr = cols[0];
            const alertText = cols.slice(1).join(',').replace(/^"|"$/g, '').trim();
            if (alertText) {
                parsedLines.push(alertText);
                if (tf === 'unknown') {
                    const tfMatch = alertText.match(/TF:\s*(\d+)/i);
                    if (tfMatch) tf = tfMatch[1];
                }
            }
        }
    }
    logsMap.set(tf, parsedLines);
    origLog(`Loaded TF ${tf} from ${file} (${parsedLines.length} lines)`);
  }

  await replayUploadedLogs(logsMap, 'EURUSD', 'Debug', 6, 6, Infinity);
}

main().catch(console.error);
