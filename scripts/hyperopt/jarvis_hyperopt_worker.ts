/**
 * JARVIS Hyperopt Worker — JSON-RPC sobre stdin/stdout
 *
 * Recibe peticiones de Optuna (Python) por stdin, ejecuta runBacktest() de
 * jarvis-os/src/services/backtestEngine.ts y devuelve las métricas por stdout.
 *
 * Protocolo (una línea JSON por mensaje, NDJSON):
 *   IN  → {"id": <int>, "method": "evaluate", "params": {<BacktestConfig>}}
 *   OUT ← {"id": <int>, "result": {"metrics": {...}, "objective": <float>, "trades": <int>}}
 *   ERR ← {"id": <int>, "error": "<msg>"}
 *
 * Logging (stderr) separado del canal para no contaminar la RPC.
 *
 * IMPORTANTE: Las líneas de log se almacenan como strings crudos, no como
 * LogEntry objects. Así runBacktest → prepareEntries → preParseAlert
 * genera el campo 'parsed' correctamente (requisito de processAlert).
 */

import { runBacktest } from '../../jarvis-os/src/services/backtestEngine.js';
import type { BacktestConfig, BacktestTrade } from '../../jarvis-os/src/services/backtestTypes.js';
import * as fs from 'fs';
import * as path from 'path';

// -----------------------------------------------------------------------------
// JSON-RPC helpers
// -----------------------------------------------------------------------------
interface RpcRequest { id: number; method: string; params?: any; }
interface RpcResponse { id: number; result?: any; error?: string; }

function send(msg: RpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function log(msg: string): void {
  process.stderr.write(`[hyperopt-worker] ${msg}\n`);
}

// -----------------------------------------------------------------------------
// Log loading — devuelve strings crudos (prepareEntries los parsea)
// -----------------------------------------------------------------------------
function loadLogsFromDir(ticker: string, baseDir: string): Map<string, string[]> {
  const logs = new Map<string, string[]>();
  const tfToFile: Record<string, string[]> = {
    '15':  ['pine-logs-SMC Master_M15.csv', 'history_M15.csv', 'M15.csv'],
    '60':  ['pine-logs-SMC Master_H1.csv', 'history_H1.csv', 'H1.csv'],
    '240': ['pine-logs-SMC Master_H4.csv', 'history_H4.csv', 'H4.csv'],
    'D':   ['pine-logs-SMC Master_D1.csv', 'history_D1.csv', 'D1.csv'],
  };

  for (const [tfKey, candidates] of Object.entries(tfToFile)) {
    for (const fname of candidates) {
      const fpath = path.join(baseDir, fname);
      if (!fs.existsSync(fpath)) continue;
      try {
        const raw = fs.readFileSync(fpath, 'utf8');
        const lines = raw.split(/\r?\n/);
        let headerIdx = -1;
        let isCsvExport = false;

        for (let i = 0; i < Math.min(5, lines.length); i++) {
          if (lines[i].startsWith('Fecha,') || lines[i].startsWith('"Fecha"')) {
            headerIdx = i;
            isCsvExport = true;
            break;
          }
        }

        const entries: string[] = [];
        for (let i = headerIdx + 1; i < lines.length; i++) {
          const rawLine = lines[i].trim();
          if (!rawLine) continue;

          let logLine: string;
          if (isCsvExport) {
            // Formato: 2026-...-03:00,"HEARTBEAT | TF: 15 | ... TS: 176..."
            const match = rawLine.match(/^"[^"]*","(.*)"$/);
            if (match) {
              logLine = match[1].trim();
            } else {
              const parts = rawLine.split(/,(.+)/);
              if (parts.length >= 2) {
                logLine = parts[1].trim().replace(/^"|"$/g, '');
              } else {
                continue;
              }
            }
          } else {
            logLine = rawLine;
          }

          // Requiere TS timestamp
          if (!logLine.includes(' | TS: ')) continue;
          const tsMatch = logLine.match(/TS:\s*(\d+)/i);
          if (!tsMatch) continue;

          // Guardar como string crudo → prepareEntries hará preParseAlert
          entries.push(logLine);
        }

        logs.set(tfKey, entries);
        log(`TF ${tfKey} ← ${fname} → ${entries.length} lines`);
        break; // primera coincidencia gana
      } catch (e: any) {
        log(`ERROR ${fpath}: ${e.message}`);
      }
    }
  }
  return logs;
}

// -----------------------------------------------------------------------------
// Métricas (espejo TS de metrics.py — deben coincidir EXACTAMENTE)
// -----------------------------------------------------------------------------
interface Metrics {
  trade_count: number; wins: number; losses: number;
  win_rate: number; gross_profit_r: number; gross_loss_r: number;
  net_pnl_r: number; profit_factor: number; expectancy: number;
  max_drawdown_r: number; sharpe_simple: number; avg_trade_r: number;
  max_consec_losses: number; max_consec_wins: number;
}

function computeMetrics(trades: BacktestTrade[]): Metrics {
  let wins = 0, losses = 0;
  let grossProfit = 0, grossLoss = 0;
  let mcLosses = 0, mcWins = 0, curLosses = 0, curWins = 0;
  let equity = 0, peak = 0, maxDD = 0;
  const rList: number[] = [];

  for (const t of trades) {
    const r = t.rMultiple;
    if (r === undefined || r === null || Number.isNaN(r)) continue;
    rList.push(r);
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    if (r > 0) {
      wins++; grossProfit += r;
      curWins++; curLosses = 0;
      if (curWins > mcWins) mcWins = curWins;
    } else if (r < 0) {
      losses++; grossLoss += -r;
      curLosses++; curWins = 0;
      if (curLosses > mcLosses) mcLosses = curLosses;
    }
  }

  const n = rList.length;
  if (n === 0) {
    return { trade_count: 0, wins: 0, losses: 0, win_rate: 0, gross_profit_r: 0,
             gross_loss_r: 0, net_pnl_r: 0, profit_factor: 0, expectancy: 0,
             max_drawdown_r: 0, sharpe_simple: 0, avg_trade_r: 0,
             max_consec_losses: 0, max_consec_wins: 0 };
  }
  const net = grossProfit - grossLoss;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? grossProfit : 0);
  const exp = net / n;
  const wr = wins / n;
  let sharpe = 0;
  if (n > 1) {
    const mean = net / n;
    const variance = rList.reduce((acc, r) => acc + (r - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(n) : 0;
  }
  return { trade_count: n, wins, losses, win_rate: wr, gross_profit_r: grossProfit,
           gross_loss_r: grossLoss, net_pnl_r: net, profit_factor: pf,
           expectancy: exp, max_drawdown_r: maxDD, sharpe_simple: sharpe,
           avg_trade_r: net / n, max_consec_losses: mcLosses, max_consec_wins: mcWins };
}

function objectiveFunction(m: Metrics, minTrades=30, ddPenalty=2.0, samplePenalty=0.5, targetTrades=200): number {
  if (m.trade_count < minTrades) {
    if (m.trade_count === 0) return -100.0;
    return -10.0 * (1.0 - m.trade_count / minTrades);
  }
  const tradeDev = Math.abs(m.trade_count - targetTrades) / targetTrades;
  return m.profit_factor - ddPenalty * m.max_drawdown_r - samplePenalty * tradeDev + 0.1 * m.expectancy;
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------
function handleInit(params: any): any {
  const ticker = params.ticker as string;
  const logDir = params.log_dir as string;
  log(`init ticker=${ticker} log_dir=${logDir}`);
  const logs = loadLogsFromDir(ticker, logDir);
  if (logs.size === 0) {
    throw new Error(`No logs found for ${ticker} in ${logDir}`);
  }
  (global as any).__logs = logs;
  return {
    ticker,
    logs_loaded: Object.fromEntries([...logs.entries()].map(([k, v]) => [k, v.length])),
    total_events: [...logs.values()].reduce((acc, arr) => acc + arr.length, 0),
  };
}

function handleEvaluate(params: any): any {
  const config: BacktestConfig = params.config;
  const logs: Map<string, string[]> = (global as any).__logs;
  if (!logs) throw new Error('Worker no inicializado. Llamar method=init primero.');

  // runBacktest espera Map<string, (string|LogEntry)[]>
  // Pasamos strings crudos → prepareEntries → preParseAlert correcto
  const result = runBacktest(logs as Map<string, (string|any)[]>, config);
  const metrics = computeMetrics(result.trades);
  const obj = objectiveFunction(metrics);
  return { metrics, objective: obj, trade_count: metrics.trade_count,
           start_date: result.startDate, end_date: result.endDate };
}

// -----------------------------------------------------------------------------
// Main loop
// -----------------------------------------------------------------------------
async function main() {
  log('worker started, waiting for RPC...');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let req: RpcRequest;
      try { req = JSON.parse(line); }
      catch (e: any) { send({ id: -1, error: `JSON parse: ${e.message}` }); continue; }
      try {
        let result: any;
        switch (req.method) {
          case 'init':     result = handleInit(req.params || {}); break;
          case 'evaluate': result = handleEvaluate(req.params || {}); break;
          case 'ping':     result = { pong: true, ts: Date.now() }; break;
          case 'shutdown': send({ id: req.id, result: { ok: true } }); log('shutdown'); process.exit(0); return;
          default: throw new Error(`Unknown method: ${req.method}`);
        }
        send({ id: req.id, result });
      } catch (e: any) { send({ id: req.id, error: e.message || String(e) }); }
    }
  });
  process.stdin.on('end', () => { log('stdin closed'); process.exit(0); });
}
main().catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
