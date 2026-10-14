// collect_triggers.ts — colecta los orígenes (candle-ts) de TODOS los triggers 5m
// del ticker para luego precomputar forecasts TimesFM (F4, sep-2026).
//
// Corre el backtest UNA vez en modo collectOnly con la config MÁS LAXA posible:
// todos los gatillos 5m activos en las 4 sesiones, thresholds mínimos (minBuy/minSell=3),
// sin killswitches diarios ni de racha → el set de orígenes colectado es SUPERSET
// de los que cualquier trial del hyperopt puede generar.
//
// Uso: npx tsx scripts/hyperopt/collect_triggers.ts EURUSD [--out logs/eurusd/forecasts/triggers_m5.jsonl]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';

const REPO = '/opt/JARVIS';
const WORKER = `${REPO}/scripts/hyperopt/jarvis_hyperopt_worker.ts`;
const ticker = (process.argv[2] || 'EURUSD').toUpperCase();
const outArg = process.argv.find((a, i) => process.argv[i - 1] === '--out');
const outPath = outArg || `${REPO}/logs/${ticker.toLowerCase()}/forecasts/triggers_m5.jsonl`;

// ─── Worker NDJSON (mismo protocolo que eval_production.ts / run_ab.py) ───────
class RpcWorker {
    proc: any; buf: string; pending: Map<number, (msg: any) => void>; _id: number;
    constructor() {
        this.proc = spawn('npx', ['tsx', WORKER], { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] });
        this.buf = ''; this._id = 0; this.pending = new Map();
        this.proc.stdout.on('data', (d: Buffer) => {
            this.buf += d.toString();
            let idx;
            while ((idx = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, idx).trim();
                this.buf = this.buf.slice(idx + 1);
                if (!line) continue;
                try {
                    const msg = JSON.parse(line);
                    const res = this.pending.get(msg.id);
                    if (res) { this.pending.delete(msg.id); res(msg); }
                } catch { /* log del worker */ }
            }
        });
    }
    call(method: string, params: any, timeoutMs = 1800_000): Promise<any> {
        this._id += 1;
        const id = this._id;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
            this.pending.set(id, (msg: any) => { clearTimeout(timer); msg.error ? reject(new Error(msg.error)) : resolve(msg.result); });
            this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        });
    }
    close() { try { this.proc.kill(); } catch {} }
}

const TRIGGERS_5M = ['choch5m', 'bos5m', 'oteChoch5m', 'oteBos5m'];
const SESSIONS = ['LONDON', 'NY', 'ASIA', 'OFF'];

async function main() {
    // Config laxa: superset de orígenes. Sin maxDailyLossR/maxConsecutiveLosses →
    // sin killswitches que recorten la colecta. Gestión neutra.
    const sessions: any = {};
    for (const sess of SESSIONS) {
        const s: any = {};
        for (const t of ['choch5m', 'choch15m', 'bos5m', 'bos15m', 'oteChoch5m', 'oteChoch15m', 'oteBos5m', 'oteBos15m']) {
            s[t] = { enabled: false };
        }
        for (const t of TRIGGERS_5M) {
            s[t] = {
                enabled: true,
                tp2: 2.0,
                slBuff: 0.1,
                entryPercent: 50,
                partialClosePct: 0.0,
                slAfterTp1: 'none',
                tp15BeEnabled: false,
                atrTrailEnabled: false,
                structuralTrailEnabled: false,
                tp1StructuralMinRR: 1.0,
            };
        }
        sessions[sess] = s;
    }
    const config: any = {
        ticker,
        entryTrigger: 'SMART',
        minBuyPoints: 3,
        minSellPoints: 3,
        minRR: 1.0,
        slBufferPercent: 0.1,
        fixedRR: 2.0,
        oteEntryPercent: 50,
        tp1StructuralMinRR: 1.0,
        minimal_roi: {},
        sessions,
        timesfm: { enabled: false, collectOnly: true, collectPath: outPath },
    };

    mkdirSync(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
    if (existsSync(outPath)) {
        // limpiar archivo de colectas previas
        writeFileSync(outPath, '');
    }

    const w = new RpcWorker();
    try {
        await w.call('init', { ticker: ticker.toLowerCase(), log_dir: `logs/${ticker.toLowerCase()}/history_exported` });
        const t0 = Date.now();
        const result: any = await w.call('evaluate', { config });
        const n = result?.metrics?.trade_count ?? '?';
        console.log(`[COLLECT] ${ticker}: backtest completo (${((Date.now() - t0) / 1000).toFixed(1)}s, trades=${n}). Orígenes → ${outPath}`);
    } finally {
        w.close();
        process.exit(0);
    }
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
