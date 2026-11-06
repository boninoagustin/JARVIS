/**
 * Calcula el progreso de datos recolectados para el backtesting del analizador
 * y lo publica en Firestore (app_settings/backtest_progress) para el panel web.
 *
 * Lee los archivos locales de /opt/JARVIS/logs/market_intel/:
 *   - trades.jsonl     (trades cerrados)
 *   - sentiment.jsonl  (net de sentimiento por activo, cada 15 min)
 *   - calendar.jsonl   (snapshots del calendario económico)
 *
 * Uso: npx tsx scripts/update_backtest_progress.ts
 */
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const CRED = '/opt/JARVIS/service-account.json';
const DIR = '/opt/JARVIS/logs/market_intel';

if (!fs.existsSync(CRED)) {
    console.error('❌ service-account.json no encontrado');
    process.exit(1);
}
if (admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(CRED, 'utf8'))) });
}
const db = admin.firestore();

function fileStats(file: string): { count: number; first: string | null; last: string | null } {
    const p = path.join(DIR, file);
    if (!fs.existsSync(p)) return { count: 0, first: null, last: null };
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    let first: number | null = null;
    let last: number | null = null;
    for (const l of lines) {
        try {
            const o = JSON.parse(l);
            let raw = o.ts ?? o.timestamp ?? o.closedAt ?? o.date;
            if (raw == null) continue;
            const t = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : Date.parse(raw);
            if (!Number.isFinite(t)) continue;
            if (first == null || t < first) first = t;
            if (last == null || t > last) last = t;
        } catch { /* skip */ }
    }
    return {
        count: lines.length,
        first: first ? new Date(first).toISOString() : null,
        last: last ? new Date(last).toISOString() : null
    };
}

async function run() {
    const trades = fileStats('trades.jsonl');
    const sentiment = fileStats('sentiment.jsonl');
    const calendar = fileStats('calendar.jsonl');
    const summary = {
        last_updated: new Date().toISOString(),
        trades,
        sentiment,
        calendar
    };
    await db.collection('app_settings').doc('backtest_progress').set(summary, { merge: true });
    console.log(`[PROGRESS] trades=${trades.count} (${trades.first?.slice(0,10)}→${trades.last?.slice(0,10)}) · sentiment=${sentiment.count} · calendar=${calendar.count}`);
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
