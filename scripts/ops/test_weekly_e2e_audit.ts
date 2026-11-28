import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

import { mapToCTraderSymbol, CTRADER_SYMBOL_MAP, mergeCandles } from '../fetch_history.js';
import { selectScoutCandidates, canMutateActiveRoster, UNIVERSE as SCOUT_UNIVERSE } from '../asset_scout.js';
import { checkWeeklyCandidate } from '../periodic_opt/weekly_candidate_safety.js';
import { mapAssetConfig } from '../periodic_opt/selection_context.js';
import { adrUpdateDecision } from '../periodic_opt/update_adr_guarded.js';
// @ts-expect-error push_reports.js is plain ESM JavaScript
import { publishReports, verifyCycleBeforePublish } from '../periodic_opt/push_reports.js';
import { isoCycleWeek, validateCycleEvidence, cycleCloseHeader } from './weekly_digest.js';

const REPO = '/opt/JARVIS';

class MockFirestore {
    docs = new Map<string, any>();
    failNextSet = false;
    corruptReadback = false;

    collection(col: string) {
        return {
            doc: (id: string) => this.doc(`${col}/${id}`),
            get: async () => {
                const prefix = `${col}/`;
                const list = [...this.docs.entries()]
                    .filter(([k]) => k.startsWith(prefix))
                    .map(([k, v]) => ({ id: k.slice(prefix.length), exists: true, data: () => structuredClone(v) }));
                return { size: list.length, empty: list.length === 0, docs: list };
            },
        };
    }

    doc(fullPath: string) {
        return {
            get: async () => {
                const has = this.docs.has(fullPath);
                const val = this.docs.get(fullPath);
                return { exists: has, data: () => (has ? structuredClone(val) : undefined) };
            },
            set: async (payload: any, opts?: { merge?: boolean }) => {
                if (this.failNextSet) {
                    this.failNextSet = false;
                    throw new Error('simulated Firestore UNAVAILABLE');
                }
                const stored = this.corruptReadback ? { ...payload, timestamp: -1 } : payload;
                if (opts?.merge && this.docs.has(fullPath)) {
                    this.docs.set(fullPath, { ...this.docs.get(fullPath), ...structuredClone(stored) });
                } else {
                    this.docs.set(fullPath, structuredClone(stored));
                }
            },
        };
    }
}

test('fetch_history maps all 10 index/energy symbols and full 45-asset universe accurately', () => {
    const expectedSpecial: Record<string, string> = {
        AUSTRALIA200: 'AUSTRALIA 200',
        EUROPE50: 'EUROPE 50',
        FRA40: 'FRANCE 40',
        GER40: 'GERMANY 40',
        ITALY40: 'ITALY 40',
        JP225: 'JAPAN 225',
        NATGAS: 'NAT.GAS',
        NL25: 'NETHERLANDS 25',
        SPAIN35: 'SPAIN 35',
        UK100: 'UK 100',
        US30: 'US 30',
        US500: 'US 500',
        USTECH100: 'US TECH 100',
        USOIL: 'XTIUSD',
    };
    for (const [ticker, ctraderName] of Object.entries(expectedSpecial)) {
        assert.equal(mapToCTraderSymbol(ticker), ctraderName, `wrong cTrader symbol for ${ticker}`);
    }
    for (const u of SCOUT_UNIVERSE) {
        assert.equal(mapToCTraderSymbol(u.ticker), u.symbol, `fetch_history vs asset_scout mismatch on ${u.ticker}`);
    }
    assert.ok(Object.keys(CTRADER_SYMBOL_MAP).length >= 46);
    const merged = mergeCandles(
        [{ timestamp: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
        [{ timestamp: 200, open: 1.5, high: 2.5, low: 1, close: 2, volume: 20 }, { timestamp: 100, open: 1, high: 2, low: 0.5, close: 1.6, volume: 12 }],
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0].close, 1.6);
});

test('asset_scout skips active_tickers and blocks roster auto-promotion during unfinished cycle', () => {
    const active = SCOUT_UNIVERSE.map((u) => u.ticker);
    assert.equal(selectScoutCandidates(SCOUT_UNIVERSE, active).length, 0, 'must skip all already-active tickers');
    assert.equal(selectScoutCandidates(SCOUT_UNIVERSE, active, 'EURCHF').length, 1, 'explicit --ticker still works');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-roster-guard-'));
    try {
        const now = Date.now();
        const week = isoCycleWeek(now);
        const runId = crypto.randomUUID();
        fs.writeFileSync(path.join(tmp, 'weekly_cycle_context.json'), JSON.stringify({
            version: 1, week, run_id: runId, started_at: now - 5000, tickers: ['EURUSD', 'USDCAD'],
        }));
        const blocked = canMutateActiveRoster(tmp, path.join(tmp, 'missing_summary.json'), path.join(tmp, 'missing_progress.json'));
        assert.equal(blocked.ok, false);
        assert.match(blocked.reason, /inconcluso/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('export_smc_csv writes atomically under per-ticker lock without ever exposing a 0-line target', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-export-test-'));
    const lockDir = path.join(tmp, 'locks');
    const fakeRepo = path.join(tmp, 'work');
    const ticker = 'EURCHFTEST';
    const rawDir = path.join(fakeRepo, 'logs', ticker.toLowerCase(), 'history');
    const expDir = path.join(fakeRepo, 'logs', ticker.toLowerCase(), 'history_exported');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.mkdirSync(expDir, { recursive: true });

    const baseTs = 1795000000000;
    const rows = ['timestamp,open,high,low,close,volume'];
    for (let i = 0; i < 120; i++) {
        const p = 0.91 + Math.sin(i / 5) * 0.001;
        rows.push(`${baseTs + i * 300000},${p.toFixed(5)},${(p + 0.0005).toFixed(5)},${(p - 0.0005).toFixed(5)},${(p + 0.0001).toFixed(5)},100`);
    }
    fs.writeFileSync(path.join(rawDir, 'history_M5.csv'), rows.join('\n') + '\n');
    const m5Target = path.join(expDir, 'pine-logs-SMC Master_M5.csv');
    const sentinelInitial = 'Fecha,Mensaje\n2026-11-27T00:00:00.000-03:00,"PING_PRICE | TF: M5 | Precio: 0.91000 | High: 0.91050 | Low: 0.90950 | Z-Up: 0 | Z-Dn: 0 | TS: 1795000300000"\n';
    fs.writeFileSync(m5Target, sentinelInitial);

    let observedZeroDataLines = false;
    const child = spawn(path.join(REPO, 'node_modules/.bin/tsx'), [
        path.join(REPO, 'scripts/export_smc_csv.ts'),
        ticker,
        '--input-dir', rawDir,
        '--timeframes', 'M5',
        '--quiet',
    ], {
        cwd: fakeRepo,
        env: { ...process.env, JARVIS_HISTORY_LOCK_DIR: lockDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pollDone = (async () => {
        while (child.exitCode === null) {
            if (fs.existsSync(m5Target)) {
                const content = fs.readFileSync(m5Target, 'utf8');
                const lines = content.trim().split('\n');
                if (lines.length < 2) observedZeroDataLines = true;
            } else {
                observedZeroDataLines = true;
            }
            await new Promise((r) => setTimeout(r, 5));
        }
    })();

    const exitCode: number = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? 1)));
    await pollDone;
    try {
        assert.equal(exitCode, 0, 'non-isolated atomic export should succeed');
        assert.equal(observedZeroDataLines, false, 'target M5 CSV must NEVER be missing or truncated to 0 data lines during export');
        const finalLines = fs.readFileSync(m5Target, 'utf8').trim().split('\n');
        assert.ok(finalLines.length > 100, `expected >100 exported lines, got ${finalLines.length}`);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('USDCAD stays in WATCH with enabled=false: parameter updates allowed, activation blocked, ADR guarded mid-cycle', () => {
    const now = Date.now();
    const usdcadWatch = {
        enabled: false,
        disabledReason: 'watch: recuperado nov-2026 para optimizar sin operar (retirado ago-2026: SMC no compatible / rendimiento)',
        minPointsForBuy: 10,
        minPointsForSell: 9,
        oteEntryPercent: 50,
    };
    const nextWatch = { ...usdcadWatch, minPointsForBuy: 8 };
    const fp = (v: any) => {
        const c = (x: any): string => x === null || typeof x !== 'object' ? JSON.stringify(x)
            : Array.isArray(x) ? `[${x.map(c).join(',')}]`
            : `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${c(x[k])}`).join(',')}}`;
        return crypto.createHash('sha256').update(c(v)).digest('hex');
    };
    const manifest = { version: 1, ticker: 'USDCAD', from_ms: 100, train_end_ms: 200, validation_end_ms: 300, test_end_ms: 300, test_independence: 'unverified' };
    const prov = { version: 1, evaluation_manifest: manifest, source_files: [{ path: '/f', sha256: 'a'.repeat(64) }], dataset_files: [{ path: '/d', sha256: 'b'.repeat(64) }] };
    const evalFp = fp(prov);
    const baseReport = (candidateAsset: any) => {
        const cfg = { ...mapAssetConfig('USDCAD', candidateAsset), mlGate: { enabled: false } };
        return {
            ticker: 'USDCAD',
            timestamp: now - 1000,
            status: 'RECOMMEND',
            selection_outcome: 'evaluated',
            production_asset_snapshot: usdcadWatch,
            production_asset_fingerprint: fp(usdcadWatch),
            final_asset_config: candidateAsset,
            final_asset_fingerprint: fp(candidateAsset),
            final_config: cfg,
            config_fingerprint: fp(cfg),
            final_config_fingerprint: fp(cfg),
            evaluation_manifest: manifest,
            evaluation_provenance: prov,
            evaluation_fingerprint: evalFp,
            production_validation: { trade_count: 20, expectancy: 0.05, max_drawdown_r: 2, net_pnl_r: 1 },
            proposal_validation: { trade_count: 20, expectancy: 0.30, max_drawdown_r: 1.5, net_pnl_r: 6 },
            montecarlo: { survival: 0.90, n: 20, config_fingerprint: fp(cfg), evaluation_fingerprint: evalFp, partition: 'validation' },
            evaluation_certificate: {
                version: 1, config_fingerprint: fp(cfg), asset_fingerprint: fp(candidateAsset),
                evaluation_fingerprint: evalFp, montecarlo_config_fingerprint: fp(cfg),
                validation_role: 'selection_validation',
            },
            certificate: {
                version: 1, config_fingerprint: fp(cfg), asset_fingerprint: fp(candidateAsset),
                evaluation_fingerprint: evalFp, montecarlo_config_fingerprint: fp(cfg),
                validation_role: 'selection_validation',
            },
            selection_payload_fingerprint: fp({
                best_config: null, session_apply: null, session_apply_replace: null, timesfm_apply: null,
                ks_proposal: null, directional_mcl: null, bias_confluence: null, loser_triggers: null,
            }),
        };
    };

    const allowed = checkWeeklyCandidate(baseReport(nextWatch), usdcadWatch, now);
    assert.equal(allowed.ok, true, allowed.reason);
    assert.equal(nextWatch.enabled, false, 'USDCAD must remain enabled=false');

    // Trying to flip USDCAD enabled=true MUST be blocked!
    const forbiddenActivation = checkWeeklyCandidate(baseReport({ ...nextWatch, enabled: true }), usdcadWatch, now);
    assert.equal(forbiddenActivation.ok, false);
    assert.match(forbiddenActivation.reason, /control operativo/);

    // ADR update must be conserved while weekly cycle is in resume or posts
    assert.equal(adrUpdateDecision({}, 0, 'resume').ok, false);
    assert.equal(adrUpdateDecision({}, 0, 'posts').ok, false);
    assert.equal(adrUpdateDecision({}, 0, 'new').ok, true);
});

test('ISO 53-week year boundary (2026-W53 -> 2027-W01) and missing USDCAD rejected in weekly_digest', () => {
    const dec31 = Date.UTC(2026, 11, 31, 23, 0, 0);
    const jan01 = Date.UTC(2027, 0, 1, 12, 0, 0);
    const jan04 = Date.UTC(2027, 0, 4, 2, 0, 0);
    assert.equal(isoCycleWeek(dec31), '2026-W53');
    assert.equal(isoCycleWeek(jan01), '2026-W53');
    assert.equal(isoCycleWeek(jan04), '2027-W01');

    const runId = crypto.randomUUID();
    const invId = 'a'.repeat(32);
    const ctx = { version: 1, week: '2026-W53', run_id: runId, started_at: dec31, tickers: ['EURUSD', 'USDCAD'], invocation_id: invId };
    const summaryObj = {
        version: 1, cycle_week: '2026-W53', cycle_run_id: runId, started_at: dec31, completed_at: jan04 - 1000,
        status: 'completed', tickers: ['EURUSD', 'USDCAD'], errors: [], error: null,
        counts: { evaluated: 2, skipped: 0, failed: 0 },
        outcomes: [
            { ticker: 'EURUSD', timestamp: jan01, outcome: 'evaluated', status: 'HOLD' },
            { ticker: 'USDCAD', timestamp: jan01 + 1000, outcome: 'evaluated', status: 'HOLD' },
        ],
    };
    const summaryRaw = JSON.stringify(summaryObj);
    const receipt = {
        version: 1, week: '2026-W53', run_id: runId, started_at: dec31,
        tickers: ['EURUSD', 'USDCAD'], completed_at: jan04 - 1000,
        summary_sha256: crypto.createHash('sha256').update(summaryRaw).digest('hex'),
    };
    const okProof = validateCycleEvidence({
        context: ctx, receipt, summaryRaw, roster: ['EURUSD', 'USDCAD'],
        seal: '2026-W53\n', invocationId: invId, serviceWeek: '2026-W53', serviceRunId: runId, now: jan04,
    });
    assert.equal(okProof.complete, true, okProof.reason);

    // Missing USDCAD from summary when roster includes USDCAD -> rejected!
    const badRosterProof = validateCycleEvidence({
        context: ctx, receipt, summaryRaw, roster: ['EURUSD', 'USDCAD', 'EURCHF'],
        seal: '2026-W53\n', invocationId: invId, serviceWeek: '2026-W53', serviceRunId: runId, now: jan04,
    });
    assert.equal(badRosterProof.complete, false);
    assert.match(badRosterProof.reason, /EURCHF/);
});

test('bounded integrated end-to-end flow: guard -> snapshot-isolated run_weekly -> receipt -> publishReports -> chain -> tune -> digest (and failure modes)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-weekly-e2e-'));
    try {
        const stateDir = path.join(tmp, 'state');
        const outDir = path.join(tmp, 'out');
        const reportsDir = path.join(outDir, 'reports');
        const optDir = path.join(outDir, 'opt_out');
        const lockDir = path.join(tmp, 'locks');
        const rawLogsRoot = path.join(tmp, 'raw_logs');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.mkdirSync(reportsDir, { recursive: true });
        fs.mkdirSync(optDir, { recursive: true });

        // Create valid 5-TF exported CSVs for EURUSD and USDCAD
        for (const ticker of ['eurusd', 'usdcad']) {
            const d = path.join(rawLogsRoot, ticker, 'history_exported');
            fs.mkdirSync(d, { recursive: true });
            const tfLabel: Record<string, string> = { M5: 'M5', M15: '15', H1: '60', H4: '240', D1: 'D' };
            for (const tf of ['M5', 'M15', 'H1', 'H4', 'D1']) {
                const lines = ['Fecha,Mensaje'];
                for (let i = 0; i < 8; i++) {
                    const ts = 1795800000000 + i * 300000;
                    lines.push(`2026-11-27T18:00:00.000Z,"PING_PRICE | TF: ${tfLabel[tf]} | Precio: 1.05000 | High: 1.05100 | Low: 1.04900 | Z-Up: 0 | Z-Dn: 0 | TS: ${ts}"`);
                }
                fs.writeFileSync(path.join(d, `pine-logs-SMC Master_${tf}.csv`), lines.join('\n') + '\n');
            }
        }
        // Also place an orphan historical BTCUSD.json in reportsDir to verify push_reports skips non-roster orphans!
        fs.writeFileSync(path.join(reportsDir, 'BTCUSD.json'), JSON.stringify({ ticker: 'BTCUSD', timestamp: 1700000000000, status: 'HOLD' }));

        // Bounded offline runner wrapper invoking real snapshot_isolation + real run_weekly certification
        const runnerScript = path.join(tmp, 'bounded_runner.py');
        fs.writeFileSync(runnerScript, `#!/usr/bin/env python3
import json, os, pathlib, sys, time
sys.path.insert(0, '/opt/JARVIS/scripts/periodic_opt')
sys.path.insert(0, '/opt/JARVIS/scripts/hyperopt')
import run_weekly as rw
from snapshot_isolation import freeze_ticker_snapshot, sha256_file
from objective_adapter import LOADED_SCORING_HASHES

ctx = json.loads(pathlib.Path(os.environ['JARVIS_WEEKLY_CONTEXT']).read_text())
reports_dir = pathlib.Path('${reportsDir}')
opt_dir = pathlib.Path('${optDir}')
raw_root = pathlib.Path('${rawLogsRoot}')
fail_ticker = os.environ.get('SIMULATE_FAIL_TICKER', '')

outcomes = []
for ticker in ctx['tickers']:
    now_ms = int(time.time() * 1000)
    if ticker == fail_ticker:
        rep = {'ticker': ticker, 'timestamp': now_ms, 'status': 'ERROR', 'selection_outcome': 'failed', 'reason': 'simulated ticker failure'}
        rw.atomic_json(reports_dir / f'{ticker}.json', rep)
        outcomes.append({'ticker': ticker, 'timestamp': now_ms, 'outcome': 'failed', 'status': 'ERROR', 'reason': rep['reason'], 'deployment_error': None})
        continue
    snap = freeze_ticker_snapshot(ticker, raw_root / ticker.lower() / 'history_exported', opt_dir / 'snapshots',
                                  cycle_run_id=ctx['run_id'], cycle_week=ctx['week'], started_at=ctx['started_at'])
    # Truncate raw M5 right after freeze to prove snapshot independence
    (raw_root / ticker.lower() / 'history_exported' / 'pine-logs-SMC Master_M5.csv').write_text('Fecha,Mensaje\\n')
    snap_m5 = pathlib.Path(snap['files']['M5']['path'])
    asset = {'enabled': False, 'disabledReason': 'watch: e2e'} if ticker == 'USDCAD' else {'enabled': True}
    prod_cfg = {'ticker': ticker, 'minBuyPoints': 7, 'mlGate': {'enabled': False}}
    manifest = {'version': 1, 'ticker': ticker, 'from_ms': 100, 'train_end_ms': 200, 'validation_end_ms': 300, 'test_end_ms': 300, 'test_independence': 'unverified'}
    prov = {'version': 1, 'evaluation_manifest': manifest,
            'source_files': [{'path': p, 'sha256': h} for p, h in LOADED_SCORING_HASHES.items()],
            'dataset_files': [{'path': str(snap_m5), 'sha256': sha256_file(snap_m5)}]}
    efp = rw.json_fingerprint(prov)
    prod_res = {'evaluation_fingerprint': efp, 'provenance': prov, 'metrics_validation': {'trade_count': 12, 'expectancy': 0.1, 'max_drawdown_r': 2.0, 'net_pnl_r': 1.2}, 'metrics_test': {'trade_count': 0}}
    rep = {'ticker': ticker, 'timestamp': now_ms, 'status': 'HOLD', 'best_config': {'minBuyPoints': 7}, 'production_backtest_config': prod_cfg,
           'cycle_run_id': ctx['run_id'], 'cycle_week': ctx['week']}
    rw.certify_report(rep, prod_cfg, asset, prod_res, manifest,
                      lambda c: {'config': c, 'config_fingerprint': rw.json_fingerprint(c), 'evaluation_fingerprint': efp, 'provenance': prov,
                                 'metrics_validation': prod_res['metrics_validation'], 'metrics_test': {'trade_count': 0}, 'validation_r': [0.1]*12},
                      montecarlo=lambda *_a: {'survival': 0.91})
    rep['selection_outcome'] = 'evaluated'
    assert rw.validate_certified_report(rep)
    if ticker == 'USDCAD':
        assert rep['final_asset_config']['enabled'] is False
    rw.atomic_json(reports_dir / f'{ticker}.json', rep)
    outcomes.append({'ticker': ticker, 'timestamp': now_ms, 'outcome': 'evaluated', 'status': rep['status'], 'reason': None, 'deployment_error': None})
    # Restore raw M5 for subsequent retries
    lines = ['Fecha,Mensaje'] + [f'2026-11-27T18:00:00.000Z,"PING_PRICE | TF: M5 | Precio: 1.05 | High: 1.06 | Low: 1.04 | Z-Up: 0 | Z-Dn: 0 | TS: {1795800000000 + i*300000}"' for i in range(8)]
    (raw_root / ticker.lower() / 'history_exported' / 'pine-logs-SMC Master_M5.csv').write_text('\\n'.join(lines) + '\\n')

errors = [o['ticker'] for o in outcomes if o['outcome'] == 'failed']
counts = {k: sum(o['outcome'] == k for o in outcomes) for k in ('evaluated', 'skipped', 'failed')}
rw.atomic_json(opt_dir / 'weekly_selection_summary.json', {
    'version': 1, 'cycle_run_id': ctx['run_id'], 'cycle_week': ctx['week'], 'started_at': ctx['started_at'],
    'completed_at': int(time.time() * 1000), 'status': 'failed' if errors else 'completed',
    'tickers': ctx['tickers'], 'outcomes': outcomes, 'counts': counts, 'errors': errors, 'error': None,
})
sys.exit(1 if errors else 0)
`, { mode: 0o755 });

        const fakeRepo = path.join(tmp, 'fake_repo');
        fs.mkdirSync(path.join(fakeRepo, 'scripts/periodic_opt/opt_out'), { recursive: true });
        fs.symlinkSync(path.join(REPO, 'scripts/periodic_opt/weekly_cycle_state.py'), path.join(fakeRepo, 'scripts/periodic_opt/weekly_cycle_state.py'));
        fs.symlinkSync(optDir, path.join(fakeRepo, 'scripts/periodic_opt/opt_out_link'));
        // Link summary/progress into fakeRepo's opt_out so run_weekly_guard.sh finds them
        const guardOptOut = path.join(fakeRepo, 'scripts/periodic_opt/opt_out');
        fs.rmSync(guardOptOut, { recursive: true, force: true });
        fs.symlinkSync(optDir, guardOptOut);
        fs.writeFileSync(path.join(fakeRepo, 'scripts/periodic_opt/run_weekly.py'), '# placeholder\n');

        const invocationId = 'b'.repeat(32);
        const summaryPath = path.join(optDir, 'weekly_selection_summary.json');
        const baseEnv = {
            ...process.env,
            REPO: fakeRepo,
            MARK_DIR: stateDir,
            CONT_DIR: stateDir,
            WEEKLY_LOCK: path.join(tmp, 'weekly.lock'),
            SCOUT_STATE_OVERRIDE: 'inactive',
            WEEKLY_ROSTER_JSON: '["EURUSD","USDCAD"]',
            WEEKLY_PYTHON: runnerScript,
            INVOCATION_ID: invocationId,
            JARVIS_HISTORY_LOCK_DIR: lockDir,
            WEEKLY_SUMMARY: summaryPath,
        };

        // PHASE 1: Incomplete cycle (USDCAD fails) -> guard exits != 0, publishReports refuses, chain refuses, digest reports incomplete!
        const failRun = spawnSync('bash', [path.join(REPO, 'scripts/periodic_opt/run_weekly_guard.sh'), '--run'], {
            env: { ...baseEnv, SIMULATE_FAIL_TICKER: 'USDCAD' },
            encoding: 'utf8',
        });
        assert.notEqual(failRun.status, 0, 'failed ticker must fail guard');
        assert.throws(
            () => verifyCycleBeforePublish({ stateDir, summaryPath, reportsDir }),
            /No se publican reportes sin ciclo verificado/,
        );
        const failChain = spawnSync('bash', [path.join(REPO, 'scripts/periodic_opt/chain_mark_and_tune.sh')], {
            env: { ...baseEnv, TUNE_START_CMD: 'true' },
            encoding: 'utf8',
        });
        assert.notEqual(failChain.status, 0, 'chain must refuse to seal failed cycle');
        assert.equal(fs.existsSync(path.join(stateDir, 'weekly_cycle_last')), false);
        assert.match(cycleCloseHeader(false), /incompleto/);

        // PHASE 2: Recovery succeeds -> guard writes PYDONE receipt -> test Firestore write/readback errors -> publishReports succeeds -> chain + tune + recovery + digest complete!
        const okCond = spawnSync('bash', [path.join(REPO, 'scripts/periodic_opt/run_weekly_guard.sh'), '--condition'], {
            env: baseEnv,
            encoding: 'utf8',
        });
        assert.equal(okCond.status, 0, okCond.stdout + okCond.stderr);

        const okRun = spawnSync('bash', [path.join(REPO, 'scripts/periodic_opt/run_weekly_guard.sh'), '--run'], {
            env: baseEnv,
            encoding: 'utf8',
        });
        assert.equal(okRun.status, 0, okRun.stdout + okRun.stderr);
        assert.match(okRun.stdout, /done-python:/);

        const mockDb = new MockFirestore();
        // Simulate transient Firestore failure in push_reports -> must throw!
        mockDb.failNextSet = true;
        await assert.rejects(
            () => publishReports({ db: mockDb, reportsDir, stateDir, summaryPath }),
            /simulated Firestore UNAVAILABLE/,
        );
        // Simulate readback corruption -> must throw!
        mockDb.corruptReadback = true;
        await assert.rejects(
            () => publishReports({ db: mockDb, reportsDir, stateDir, summaryPath }),
            /Readback falló/,
        );
        mockDb.corruptReadback = false;

        // Clean publishReports -> publishes EURUSD & USDCAD (stamping cycle_week & cycle_run_id), skips orphan BTCUSD!
        const pubRes = await publishReports({ db: mockDb, reportsDir, stateDir, summaryPath });
        assert.equal(pubRes.publishedCount, 2);
        assert.equal(mockDb.docs.has('opt_reports/BTCUSD'), false, 'orphan non-roster report must not be republished');
        assert.equal(mockDb.docs.get('opt_reports/USDCAD')?.final_asset_config?.enabled, false, 'USDCAD published report keeps enabled=false');
        assert.equal(mockDb.docs.get('opt_reports/EURUSD')?.cycle_run_id, pubRes.cycleRunId);

        // Simulate crash on tune enqueue first, then recovery via recover_tune_pending.sh + tune_run_wrapper.sh!
        const chainFailEnqueue = spawnSync('bash', [path.join(REPO, 'scripts/periodic_opt/chain_mark_and_tune.sh')], {
            env: { ...baseEnv, TUNE_START_CMD: 'false' },
            encoding: 'utf8',
        });
        assert.notEqual(chainFailEnqueue.status, 0);
        assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'weekly_continuation.json'), 'utf8')).state, 'pending');

        let tuneRan = false;
        const recoverRes = spawnSync('bash', [path.join(REPO, 'scripts/periodic_opt/recover_tune_pending.sh')], {
            env: { ...baseEnv, TUNE_STATE_CMD: 'echo inactive', TUNE_START_CMD: 'true' },
            encoding: 'utf8',
        });
        assert.equal(recoverRes.status, 0, recoverRes.stdout + recoverRes.stderr);
        assert.match(recoverRes.stdout, /requeued:/);

        const wrapRes = spawnSync('bash', [path.join(REPO, 'scripts/periodic_opt/tune_run_wrapper.sh')], {
            env: { ...baseEnv, TUNE_CMD: 'true' },
            encoding: 'utf8',
        });
        assert.equal(wrapRes.status, 0);
        tuneRan = true;
        assert.equal(tuneRan, true);
        assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'weekly_continuation.json'), 'utf8')).state, 'completed');

        // Final cleanup of completed continuation is idempotent
        const cleanCont = spawnSync('bash', [path.join(REPO, 'scripts/periodic_opt/recover_tune_pending.sh')], {
            env: { ...baseEnv, TUNE_STATE_CMD: 'echo inactive', TUNE_START_CMD: 'false' },
            encoding: 'utf8',
        });
        assert.equal(cleanCont.status, 0);
        assert.equal(fs.existsSync(path.join(stateDir, 'weekly_continuation.json')), false);

        // Verify digest full cycle closure proof!
        const ctx = JSON.parse(fs.readFileSync(path.join(stateDir, 'weekly_cycle_context.json'), 'utf8'));
        const receipt = JSON.parse(fs.readFileSync(path.join(stateDir, `weekly_python_done_${ctx.week}`), 'utf8'));
        const summaryRaw = fs.readFileSync(summaryPath, 'utf8');
        const seal = fs.readFileSync(path.join(stateDir, 'weekly_cycle_last'), 'utf8');
        const digestProof = validateCycleEvidence({
            context: ctx, receipt, summaryRaw, roster: ['EURUSD', 'USDCAD'],
            seal, invocationId, serviceWeek: ctx.week, serviceRunId: ctx.run_id,
        });
        assert.equal(digestProof.complete, true, digestProof.reason);
        assert.match(cycleCloseHeader(true), /finalizado/);

        // Subsequent guard --condition in the same week now skips cleanly!
        const afterSealCond = spawnSync('bash', [path.join(REPO, 'scripts/periodic_opt/run_weekly_guard.sh'), '--condition'], {
            env: baseEnv,
            encoding: 'utf8',
        });
        assert.notEqual(afterSealCond.status, 0);
        assert.match(afterSealCond.stdout, /skip:/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
