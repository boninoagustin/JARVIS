import fs from 'fs';
import { parseCSV } from './jarvis-os/src/services/backtestEngine.js';

const content = fs.readFileSync('pine-logs-SMC Master 5.1 [JARVIS v5.4]_c450d.csv', 'utf8');
const { lines, detectedTF } = parseCSV(content);
console.log(Array.isArray(lines), typeof lines);
