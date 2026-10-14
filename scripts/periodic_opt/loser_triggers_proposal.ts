// Paso "gatillos perdedores" del dominical (sep-2026): mide exp por gatillo con el motor real
// y la config de PRODUCCIÓN de cada activo; PROPONE apagar (minScore=99) los perdedores
// persistentes (n>=10, exp<=-0.15). Escribe reports/loser_triggers_proposal.json.
// NO aplica nada (regla de oro). Uso: npx tsx scripts/periodic_opt/loser_triggers_proposal.ts
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest, prepareEntries, getSessionForTimestamp } from '../../jarvis-os/src/services/backtestEngine';
import type { LogEntry } from '../../jarvis-os/src/services/backtestTypes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_ROOT = path.join(__dirname, '..', '..', 'logs');
const TICKERS = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40', 'JP225'];
const MIN_N = 8;
const EXP_LIMIT = -0.15;
const DEAD_MINSCORE = 99;

function loadLogs(ticker: string): Map<string, string[]> {
    const tickerDir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
    const logs = new Map<string, string[]>();
    if (!fs.existsSync(tickerDir)) return logs;
    for (const tf of ['M5', 'M15']) {
        const found = [
            path.join(tickerDir, `pine-logs-SMC Master_${tf}.csv`),
            path.join(tickerDir, `pine-logs-SMC Master_${tf.toUpperCase()}.csv`),
        ].find(c => fs.existsSync(c));
        if (found) logs.set(tf, fs.readFileSync(found, 'utf8').split('\n').filter(l => l.trim().length > 0));
    }
    return logs;
}

async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();

    const out: any = { generatedAt: new Date().toISOString(), status: "HOLD", disables: [], enables: [], perTicker: {} };
    for (const ticker of TICKERS) {
        const doc = await db.collection("asset_configs").doc(ticker).get();
        const logs = loadLogs(ticker);
        if (!doc.exists || !logs.has('M5')) { out.perTicker[ticker] = { note: "sin doc o sin logs" }; continue; }
        const d = doc.data() || {};

        // ── Corrida A: config de PRODUCCIÓN → perdedores de gatillos ENCENDIDOS ──
        const prodCfg: any = {
            ticker,
            entryTrigger: d.entryTrigger || 'SMART',
            minBuyPoints: d.minPointsForBuy ?? 4,
            minSellPoints: d.minPointsForSell ?? 4,
            slBufferPercent: d.slBufferPercent ?? 0.1,
            fixedRR: d.fixedRR ?? 2.0,
            oteEntryPercent: d.oteEntryPercent ?? 50,
            spreadPips: 0, commissionPerLot: 0,
            sessions: d.sessions || {}, enabled: true,
        };
        const prepared: LogEntry[] = await prepareEntries(logs);
        const resA = runBacktest(logs, prodCfg, undefined, prepared);

        // ── Corrida B: config SONDA (todo encendido, minScore 4) → ganadores APAGADOS hoy ──
        const sondeoSessions: any = {};
        for (const s of ['ASIA', 'LONDON', 'NY', 'OFF']) {
            sondeoSessions[s] = {};
            for (const t of ['choch5m', 'bos5m', 'choch15m', 'bos15m', 'oteChoch5m', 'oteBos5m', 'oteChoch15m', 'oteBos15m'])
                sondeoSessions[s][t] = { enabled: true, minScore: 4 };
        }
        const sondaCfg: any = { ...prodCfg, sessions: sondeoSessions };
        const resB = runBacktest(logs, sondaCfg, undefined, prepared);

        // 🆕 10-sep-2026: VENTANA MÓVIL de 84 días (3 meses calendario) — pedido de Bon.
        // La señal se mide SOLO sobre los trades de la ventana reciente (el motor igual corrió
        // toda la historia, así el estado acumulado —zonas/legs/ATR— es válido). Cambio de
        // régimen visible; muestra mínima relajada a n>=8 para los gatillos lentos.
        const WINDOW_DAYS = 84;
        const allTs = [...resA.trades, ...resB.trades].map(t => (t as any).timestamp).filter((x): x is number => Number.isFinite(x));
        const cut = (allTs.length ? Math.max(...allTs) : Date.now()) - WINDOW_DAYS * 86400000;
        const winA = resA.trades.filter(t => (t as any).timestamp >= cut);
        const winB = resB.trades.filter(t => (t as any).timestamp >= cut);

        // Gatillos APAGADOS hoy (minScore>=99 o enabled===false en TODAS las sesiones)
        const prodSessions: any = d.sessions || {};
        const offToday = new Set<string>();
        for (const trig of ['choch5m', 'bos5m', 'choch15m', 'bos15m', 'oteChoch5m', 'oteBos5m', 'oteChoch15m', 'oteBos15m']) {
            const states = ['ASIA', 'LONDON', 'NY', 'OFF'].map(s => prodSessions[s]?.[trig]);
            const allOff = states.every(b => b === undefined || b?.enabled === false || b?.minScore >= 99);
            if (allOff) offToday.add(trig);
        }

        // ── sep-2026 (pedido Bon): desglose por SESIÓN — gatillo×sesión en vez de gatillo global.
        //    Así un choch5m que gana en LONDON y pierde en ASIA se detecta en ASIA (antes el
        //    neto positivo global lo enmascaraba). Propone apagar/activar SOLO en esa sesión.
        const aggBySesTrig = (trades: any[]) => {
            const m = new Map<string, { n: number; r: number }>();
            for (const t of trades) {
                if (!Number.isFinite(t.rMultiple)) continue;
                const trig = t.triggerType || '?';
                if (trig === '?') continue;
                const ses = getSessionForTimestamp((t as any).timestamp);
                const key = `${ses}|${trig}`;
                const a = m.get(key) || { n: 0, r: 0 };
                a.n++; a.r += t.rMultiple;
                m.set(key, a);
            }
            return m;
        };

        // Estado del gatillo en UNA sesión (producción): OFF si deshabilitado o minScore>=99
        const isOffIn = (trig: string, ses: string) => {
            const c = prodSessions[ses]?.[trig];
            return c === undefined ? false : (c?.enabled === false || c?.minScore >= 99);
        };

        const byProd = aggBySesTrig(winA);
        const bySonda = aggBySesTrig(winB);

        // Disables: gatillo ENCENDIDO en esa sesión (producción) que pierde persistente
        const disables: any[] = [];
        for (const [key, v] of byProd) {
            const [ses, trig] = key.split('|');
            if (isOffIn(trig, ses)) continue; // ya está apagado ahí — nada que apagar
            const exp = v.r / v.n;
            if (v.n >= MIN_N && exp <= EXP_LIMIT) {
                disables.push({ session: ses, trigger: trig, n: v.n, exp: +exp.toFixed(3), action: `minScore=${DEAD_MINSCORE} en ${ses}` });
            }
        }
        // Enables: gatillo APAGADO hoy en esa sesión que en la sonda gana con margen
        const enables: any[] = [];
        for (const [key, v] of bySonda) {
            const [ses, trig] = key.split('|');
            if (!isOffIn(trig, ses)) continue; // solo reactivar lo que está apagado en ESA sesión
            const exp = v.r / v.n;
            if (v.n >= MIN_N && exp >= 0.15) {
                enables.push({ session: ses, trigger: trig, n: v.n, exp: +exp.toFixed(3), action: `activar minScore=4 en ${ses}` });
            }
        }
        out.perTicker[ticker] = { tradesProd: winA.length, tradesSonda: winB.length, windowDays: WINDOW_DAYS, disables, enables };
        // 🆕 11-sep-2026: volcar TODOS los gatillos 15m (no solo los que pasan umbral) para
        // revisar la política solo-5M con datos (pedido Bon: discriminar gatillo por gatillo).
        const t15: any[] = [];
        for (const trig of ['choch15m', 'bos15m', 'oteChoch15m', 'oteBos15m']) {
            const p = byProd.get(trig);
            const s = bySonda.get(trig);
            t15.push({
                trigger: trig,
                offHoy: offToday.has(trig),
                prod: p ? { n: p.n, exp: +(p.r / p.n).toFixed(3) } : null,
                sonda: s ? { n: s.n, exp: +(s.r / s.n).toFixed(3) } : null,
            });
        }
        (out.perTicker[ticker] as any).triggers15m = t15;
        for (const l of disables) out.disables.push({ ticker, ...l });
        for (const e of enables) out.enables.push({ ticker, ...e });
        if (disables.length) console.log(`  🔴 ${ticker} APAGAR: ${disables.map(l => `${l.session}/${l.trigger} (${l.n}t, ${l.exp}R/t)`).join(" · ")}`);
        if (enables.length) console.log(`  🟢 ${ticker} ACTIVAR: ${enables.map(l => `${l.session}/${l.trigger} (${l.n}t, +${l.exp}R/t)`).join(" · ")}`);
    }
    out.status = (out.disables.length || out.enables.length) ? "PROPUESTA" : "HOLD";
    mkdirSync("/opt/JARVIS/scripts/periodic_opt/reports", { recursive: true });
    writeFileSync("/opt/JARVIS/scripts/periodic_opt/reports/loser_triggers_proposal.json", JSON.stringify(out, null, 2));
    console.log(`Trigger-state: ${out.status} (${out.disables.length} apagar, ${out.enables.length} activar) → reports/loser_triggers_proposal.json`);
    process.exit(0);
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
