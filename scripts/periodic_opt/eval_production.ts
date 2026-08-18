// eval_production.ts — métricas OOS de la config de PRODUCCIÓN de un ticker.
// Usa el MISMO worker NDJSON y split 70/30 que el hyperopt → comparación 1:1.
// Uso: npx tsx scripts/periodic_opt/eval_production.ts EURUSD
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const REPO = '/opt/JARVIS';
const WORKER = `${REPO}/scripts/hyperopt/jarvis_hyperopt_worker.ts`;
const ticker = (process.argv[2] || 'XAUUSD').toUpperCase();

// ─── Worker NDJSON (mismo protocolo que run_ab.py) ────────────────────────────
class RpcWorker {
    proc: any;
    buf: string;
    pending: Map<number, (msg: any) => void>;
    _id: number;
    constructor() {
        this.proc = spawn('npx', ['tsx', WORKER], { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] });
        this.buf = '';
        this._id = 0;
        this.pending = new Map();
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
            this.pending.set(id, (msg) => { clearTimeout(timer); msg.error ? reject(new Error(msg.error)) : resolve(msg.result); });
            this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        });
    }
    close() { try { this.proc.kill(); } catch {} }
}

async function main() {
    const sa = JSON.parse(readFileSync(`${REPO}/firebase-key.json`, 'utf8'));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
    const db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });

    const current = (await db.doc(`asset_configs/${ticker}`).get()).data() || {};
    // Mismo mapeo que eval_current_config.ts
    const config = {
        ticker,
        entryTrigger: current.entryTrigger || 'SMART',
        minBuyPoints: current.minPointsForBuy ?? 4,
        minSellPoints: current.minPointsForSell ?? 4,
        slBufferPercent: current.slBufferPercent ?? 0.1,
        fixedRR: current.fixedRR ?? 2.0,
        oteEntryPercent: current.oteEntryPercent ?? 50,
        sessions: current.sessions || {},
        maxDailyLossR: current.maxDailyLossR || undefined,
        dailyProfitTargetR: current.dailyProfitTargetR || undefined,
        maxConsecutiveLosses: current.maxConsecutiveLosses || undefined,
        maxTradesPerDay: current.maxTradesPerDay || undefined,
        trailingDrawdownR: current.trailingDrawdownR || undefined,
        enabled: current.enabled ?? true,
        spreadPips: 0.1, commissionPerLot: 3.0, tp1StructuralMinRR: 1.2,
    };

    const w = new RpcWorker();
    try {
        const initRes: any = await w.call('init', { ticker: ticker.toLowerCase(), log_dir: `logs/${ticker.toLowerCase()}/history_exported` });
        const result: any = await w.call('evaluate', { config });
        console.log(JSON.stringify({ ticker, config, metrics: result.metrics, metrics_oos: result.metrics_oos, oos_split: initRes?.oos_split }));
    } finally {
        w.close();
        process.exit(0);
    }
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
