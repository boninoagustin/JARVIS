import fs from 'fs';

let code = fs.readFileSync('jarvis-os/src/services/backtestEngine.ts', 'utf8');

code = code.replace(
  "export function* parseCSVLines(content: string): Generator<LogEntry> {\n  const seen = new Set<string>();\n  const rows = content.split(/\\r?\\n/);\n  for (const r of rows) {\n    if (r.trim().length === 0 || !r.includes(' | TS: ')) continue;\n    const firstComma = r.indexOf(',');\n    const line = firstComma > 0 ? r.substring(firstComma + 1).replace(/^\"|\"$/g, '') : r;\n    if (seen.has(line)) continue;\n    seen.add(line);\n    const tsMatch = line.match(/TS:\\s*(\\d+)/i);\n    const tfMatch = line.match(/TF:\\s*([a-zA-Z0-9]+)/i);\n    yield {\n      line,\n      ts: tsMatch ? parseInt(tsMatch[1], 10) : 0,\n      tf: tfMatch ? tfMatch[1].toUpperCase() : '3',\n      parsed: preParseAlert(line)\n    };\n  }\n}",
  `export function* parseCSVLines(content: string): Generator<LogEntry> {
  const seen = new Set<string>();
  let start = 0;
  while (start < content.length) {
    let end = content.indexOf('\\n', start);
    if (end === -1) end = content.length;
    let r = content.substring(start, end);
    if (r.endsWith('\\r')) r = r.slice(0, -1);
    start = end + 1;

    if (r.trim().length === 0 || !r.includes(' | TS: ')) continue;
    const firstComma = r.indexOf(',');
    const line = firstComma > 0 ? r.substring(firstComma + 1).replace(/^"|"$/g, '') : r;
    
    // Guardamos una subcadena o hash simple en memoria en vez de la línea completa de 300 chars
    // para reducir drásticamente el uso de RAM del Set. 
    // Como las duplicaciones suelen ser exactas, un prefijo + TS suele bastar.
    const dedupKey = line.substring(0, 60);
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const tsMatch = line.match(/TS:\\s*(\\d+)/i);
    const tfMatch = line.match(/TF:\\s*([a-zA-Z0-9]+)/i);
    yield {
      line,
      ts: tsMatch ? parseInt(tsMatch[1], 10) : 0,
      tf: tfMatch ? tfMatch[1].toUpperCase() : '3',
      parsed: preParseAlert(line)
    };
  }
}`
);

fs.writeFileSync('jarvis-os/src/services/backtestEngine.ts', code);
