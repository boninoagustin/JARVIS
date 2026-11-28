// push_reports.js — sube reportes verificados del ciclo semanal a Firestore (opt_reports/{ticker}).
// Uso:
//   npx tsx scripts/periodic_opt/push_reports.js                  # exige evidencia verificada del ciclo
//   npx tsx scripts/periodic_opt/push_reports.js --allow-partial  # diagnóstico/manual explícito (fuera del servicio)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import adminModule from 'firebase-admin';

const admin = adminModule.default ?? adminModule;
const REPO = '/opt/JARVIS';
const BAD_STATUSES = new Set(['ERROR', 'REFRESH_ERROR', 'HOLD_SELECTION_ERROR', 'HOLD_INTEGRITY', 'HOLD_ML_ERROR']);

export function verifyCycleBeforePublish({
    stateDir = process.env.MARK_DIR || '/var/lib/jarvis',
    summaryPath = process.env.WEEKLY_SUMMARY || path.join(REPO, 'scripts/periodic_opt/opt_out/weekly_selection_summary.json'),
    reportsDir = process.env.REPORTS_DIR || path.join(REPO, 'scripts/periodic_opt/reports'),
    allowPartial = false,
} = {}) {
    if (allowPartial) {
        return { verified: false, context: null, summary: null };
    }
    const verifyRes = spawnSync(
        'python3',
        [path.join(REPO, 'scripts/periodic_opt/weekly_cycle_state.py'), 'verify', '--state-dir', stateDir, '--summary', summaryPath],
        { encoding: 'utf8', timeout: 15000 },
    );
    if (verifyRes.status !== 0) {
        throw new Error(`No se publican reportes sin ciclo verificado: ${(verifyRes.stderr || verifyRes.stdout || '').trim()}`);
    }
    const context = JSON.parse(verifyRes.stdout);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const outcomesByTicker = new Map((summary.outcomes || []).map((o) => [o.ticker, o]));
    for (const ticker of context.tickers) {
        const filePath = path.join(reportsDir, `${ticker}.json`);
        if (!existsSync(filePath)) {
            throw new Error(`Falta el reporte del ciclo para ${ticker}: ${filePath}`);
        }
        const report = JSON.parse(readFileSync(filePath, 'utf8'));
        const outcome = outcomesByTicker.get(ticker);
        if (!report || typeof report !== 'object' || Array.isArray(report) || report.ticker !== ticker) {
            throw new Error(`Reporte inválido o mal etiquetado para ${ticker}`);
        }
        if (!Number.isSafeInteger(report.timestamp) || report.timestamp < context.started_at) {
            throw new Error(`Reporte viejo para ${ticker} (${report.timestamp} < ciclo ${context.started_at}); no se publica como vigente`);
        }
        if (BAD_STATUSES.has(String(report.status || '')) || report.deployment_error || outcome?.outcome === 'failed') {
            throw new Error(`Reporte con fallo para ${ticker} (status=${report.status}); no se publica cierre parcial`);
        }
    }
    return { verified: true, context, summary };
}

export async function publishReports({
    db,
    reportsDir = process.env.REPORTS_DIR || path.join(REPO, 'scripts/periodic_opt/reports'),
    stateDir = process.env.MARK_DIR || '/var/lib/jarvis',
    summaryPath = process.env.WEEKLY_SUMMARY || path.join(REPO, 'scripts/periodic_opt/opt_out/weekly_selection_summary.json'),
    allowPartial = false,
}) {
    const { verified, context } = verifyCycleBeforePublish({ stateDir, summaryPath, reportsDir, allowPartial });
    const allowedTickers = verified && context ? new Set(context.tickers) : null;

    const files = readdirSync(reportsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && (/^[A-Z][A-Z0-9]*\.json$/.test(entry.name)
            || entry.name === 'asset_scout.json' || entry.name === 'loser_triggers_proposal.json'))
        .map((entry) => entry.name)
        .sort();

    if (files.length === 0) {
        throw new Error('sin reportes para subir');
    }

    let publishedCount = 0;
    for (const f of files) {
        const docId = f.replace('.json', '').toUpperCase();
        const isSpecial = f === 'asset_scout.json' || f === 'loser_triggers_proposal.json';
        if (!isSpecial && allowedTickers && !allowedTickers.has(docId)) {
            console.log(`⏭ ${f} omitido (fuera del roster congelado del ciclo ${context.week})`);
            continue;
        }
        const report = JSON.parse(readFileSync(path.join(reportsDir, f), 'utf8'));
        if (!report || typeof report !== 'object' || Array.isArray(report)) {
            console.log(`⏭ ${f} omitido (no es objeto)`);
            continue;
        }
        if (f === 'loser_triggers_proposal.json' && verified && context && report.cycle_run_id && report.cycle_run_id !== context.run_id) {
            console.log(`⏭ ${f} omitido (pertenece a otra corrida: ${report.cycle_run_id})`);
            continue;
        }

        const ref = db.collection('opt_reports').doc(docId);
        const payload = {
            ...report,
            ...(!isSpecial && verified && context ? { cycle_week: context.week, cycle_run_id: context.run_id } : {}),
        };
        const prevSnap = await ref.get();
        if (prevSnap.exists) {
            const prev = prevSnap.data() || {};
            if (prev.timestamp !== undefined && prev.timestamp === report.timestamp && prev.appliedAt !== undefined) {
                payload.appliedAt = prev.appliedAt;
                payload.appliedBy = prev.appliedBy;
                if (prev.new_trades !== undefined) payload.new_trades = prev.new_trades;
                if (prev.application !== undefined && payload.application === undefined) payload.application = prev.application;
                if (prev.followup !== undefined && payload.followup === undefined) payload.followup = prev.followup;
                console.log(`✓ opt_reports/${docId} → status ${report.status} (preservando aplicado)`);
            } else {
                console.log(`✓ opt_reports/${docId} → status ${report.status}`);
            }
        } else {
            console.log(`✓ opt_reports/${docId} → status ${report.status} (nuevo)`);
        }
        await ref.set(payload);
        const readback = await ref.get();
        if (!readback.exists || (!isSpecial && readback.data()?.timestamp !== payload.timestamp)) {
            throw new Error(`Readback falló tras publicar opt_reports/${docId}`);
        }
        publishedCount++;
    }
    if (verified && context && publishedCount < context.tickers.length) {
        throw new Error(`Publicación incompleta: ${publishedCount} subidos < ${context.tickers.length} activos del ciclo`);
    }
    return { publishedCount, cycleWeek: context?.week ?? null, cycleRunId: context?.run_id ?? null };
}

async function main() {
    const allowPartial = process.argv.includes('--allow-partial');
    const sa = JSON.parse(readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
    const db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    const res = await publishReports({ db, allowPartial });
    console.log(`✅ Publicación completada: ${res.publishedCount} documento(s)${res.cycleWeek ? ` (${res.cycleWeek} · ${res.cycleRunId})` : ''}`);
    process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((e) => {
        console.error('ERROR:', e.message);
        process.exit(1);
    });
}
