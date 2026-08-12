/**
 * backtest_server.ts — Backtesting server-side usando el MOTOR REAL (backtestEngine).
 * Reemplaza backtest_api.ts (simulador simplificado) por el mismo motor que usa el dashboard.
 *
 * Uso: npx tsx scripts/backtest_server.ts <ticker> <tfs> <config_json>
 * Devuelve el JSON exacto que espera el panel (BacktestResult + métricas calculadas arriba).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest, prepareEntries } from '../src/services/backtestEngine';
import type { LogEntry } from '../src/services/backtestTypes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_ROOT = path.join(__dirname, '..', '..', 'logs');

function loadLogs(ticker: string, tfs: string[]): Map<string, string[]> {
    const tickerDir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
    if (!fs.existsSync(tickerDir)) throw new Error(`No existe: ${tickerDir}`);

    const logs = new Map<string, string[]>();
    for (const tf of tfs) {
        // El TF del panel viene como M5/M15/H1/H4/D1. Los archivos se nombran igual.
        const candidates = [
            path.join(tickerDir, `pine-logs-SMC Master_${tf}.csv`),
            path.join(tickerDir, `pine-logs-SMC Master_${tf.toUpperCase()}.csv`),
        ];
        let found = candidates.find(c => fs.existsSync(c));
        if (!found) {
            // Buscar por TF numérico (5→M5, 15→M15, 60→H1, 240→H4, D→D1)
            const tfNum: Record<string, string> = { 'M5': '5', 'M15': '15', 'H1': '60', 'H4': '240', 'D1': 'D' };
            const alt = tfNum[tf];
            if (alt) {
                found = candidates.concat([
                    path.join(tickerDir, `pine-logs-SMC Master_${alt}.csv`),
                ]).find(c => fs.existsSync(c));
            }
        }
        if (!found) continue; // TF sin archivo
        const content = fs.readFileSync(found, 'utf8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        logs.set(tf, lines);
    }
    return logs;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 3) {
        console.log(JSON.stringify({ error: 'Uso: backtest_server.ts <ticker> <tfs> <config_json>' }));
        process.exit(0);
    }
    const ticker = args[0].toUpperCase();
    const tfs = args[1].split(',').map(t => t.trim()).filter(Boolean);
    const config = JSON.parse(args[2]);

    // config.tfs es un array en el payload del panel; usarlo si existe
    const tfsFinal = (config.tfs && Array.isArray(config.tfs) && config.tfs.length > 0)
        ? config.tfs
        : tfs;

    const t0 = Date.now();
    const logs = loadLogs(ticker, tfsFinal);
    const prepared: LogEntry[] = await prepareEntries(logs);
    const loadMs = Date.now() - t0;

    const simStart = Date.now();
    const res = runBacktest(logs, config, undefined, prepared);
    const simMs = Date.now() - simStart;

    // Métricas (igual que el panel calcula con calculateAdvancedMetrics)
    const trades = res.trades;
    const wins = trades.filter(t => (t.rMultiple ?? 0) > 0).length;
    const losses = trades.filter(t => (t.rMultiple ?? 0) < 0).length;
    const be = trades.filter(t => (t.rMultiple ?? 0) === 0).length;
    const totalR = trades.reduce((s, t) => s + (t.rMultiple ?? 0), 0);
    const wr = trades.length > 0 ? (wins / trades.length) * 100 : 0;

    const output = {
        ticker,
        timeframes: tfsFinal,
        mode: 'simulate',
        timings: { loadMs, simulateMs: simMs, totalMs: loadMs + simMs },
        candles: 0,
        processedEvents: res.processedEvents,
        totalEvents: res.totalEvents,
        startDate: res.startDate,
        endDate: res.endDate,
        config,
        metrics: {
            totalTrades: trades.length,
            wins, losses, be,
            winRate: Math.round(wr * 10) / 10,
            totalR: Math.round(totalR * 1000) / 1000,
            avgR: trades.length > 0 ? Math.round((totalR / trades.length) * 1000) / 1000 : 0,
        },
        trades,
    };
    console.log(JSON.stringify(output));
}

main().catch(e => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
