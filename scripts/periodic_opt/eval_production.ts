// eval_production.ts — métricas OOS de la config de PRODUCCIÓN de un ticker.
// Usa el MISMO worker NDJSON y split 70/30 que el hyperopt → comparación 1:1.
// Uso: npx tsx scripts/periodic_opt/eval_production.ts EURUSD
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
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
        // 🆕 sep-2026 (A/B VWAP): peso VWAP aplicado por activo (default 2 = pre-A/B)
        vwapPts: current.vwapPts ?? 2,
        // 🆕 sep-2026 (Capa 1): pesos de zona × sesión aplicados por activo
        zoneWeights: current.zoneWeights || undefined,
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
        spreadPips: 0.1, commissionPerLot: 3.0,
        // F3-etapa1: reflejar la gestión real de producción (antes hardcodeado en 1.2 y sin ROI)
        tp1StructuralMinRR: current.tp1StructuralMinRR ?? 1.2,
        minimal_roi: current.minimal_roi,
    } as any;

    // F4 (07-sep-2026): activar el filtro TimesFM con el cache precomputado para que
    // la comparación prop↔prod sea 1:1 (el hyperopt corre CON filtro). El bloque de
    // producción (asset_configs.timesfm: counterMult=1, lowConvictionMult=1, dryRun…)
    // se respeta tal cual; solo se inyecta el cachePath. Si no hay cache → filtro
    // queda como estaba (sin efecto) — el umbral propuesto no se compara en ese caso.
    const tfmCache = `${REPO}/logs/${ticker.toLowerCase()}/forecasts/forecasts_m5.jsonl`;
    if (existsSync(tfmCache) && current.timesfm) {
        config.timesfm = { ...(current.timesfm as any), enabled: true, cachePath: tfmCache };
    }

    // 🛡️ ML F3 (sep-2026): gate ML idéntico en prop y prod (walk-forward por mtime).
    // El hyperopt corre CON el gate → eval_production debe correr CON el MISMO gate
    // para que prop↔prod sea 1:1. Sin modelo → gate OFF (legacy), igual que las trials.
    // 🆕 10-sep-2026: fallback al modelo genérico (igual que el vivo: DEFAULT_KEY) —
    // sin esto JP225 quedaba ungated en prod pero gated en las trials (worker).
    const mlPerTicker = `${REPO}/scripts/hyperopt/models/ml_model_${ticker}.json`;
    const mlGeneric = `${REPO}/scripts/hyperopt/models/ml_model.json`;
    const mlModelP = existsSync(mlPerTicker) ? mlPerTicker : mlGeneric;
    if (existsSync(mlModelP)) {
        try {
            config.mlGate = {
                enabled: true,
                modelPath: mlModelP,
                trainedAt: Math.floor(statSync(mlModelP).mtimeMs),
            };
        } catch (_e) { /* gate OFF */ }
    }

    const w = new RpcWorker();
    try {
        const initRes: any = await w.call('init', { ticker: ticker.toLowerCase(), log_dir: `logs/${ticker.toLowerCase()}/history_exported` });
        const result: any = await w.call('evaluate', { config });
        console.log(JSON.stringify({ ticker, config, metrics: result.metrics, metrics_oos: result.metrics_oos, oos_split: initRes?.oos_split, oos_r: result.oos_r ?? [] }));
    } finally {
        w.close();
        process.exit(0);
    }
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
