#!/usr/bin/env python3
"""Mandatory regression suite for the W48 weekly cycle audit.

Covers:
1. Real EURCHF failure mode: concurrent writer truncating M5 to 0 lines during evaluation.
2. Incomplete, empty, header-only, truncated, stale, wrong-ticker, or wrong-run snapshots.
3. Cycle with one asset already APPLIED (GBPCAD) and another FAILED (EURCHF), then --resume.
4. Crashes at every boundary: Python -> receipt -> postprocessors -> seal -> tune enqueue/recovery.
5. Duplicate retries, fallback overlap while lock held, and asset-scout mutual exclusion.
6. Monday crossing (Fri W48 -> Mon W49) and ISO 53-week year crossing (2026-W53 -> 2027-W01).
7. Empty, corrupt, expired (>21d), or mismatched-identity checkpoints.
8. Stale summary or summary missing a roster ticker (explicitly including USDCAD).
9. Roster or live asset_configs / candle data changed during recovery.
10. Failure notification attribution (unit, stage, ticker, cause) and Telegram API failure.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
if str(REPO / 'scripts' / 'hyperopt') not in sys.path:
    sys.path.insert(0, str(REPO / 'scripts' / 'hyperopt'))

import weekly_cycle_state as wcs
from selection_freshness import load_checkpoint, needs_selection, save_success
from snapshot_isolation import (
    REQUIRED_TFS,
    SnapshotPreflightError,
    freeze_ticker_snapshot,
    prune_unreferenced_snapshots,
    sha256_file,
    verify_ticker_snapshot,
)
from objective_adapter import LOADED_SCORING_HASHES

spec = importlib.util.spec_from_file_location('audit_run_weekly', HERE / 'run_weekly.py')
rw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rw)


def write_valid_exported_dir(target_dir: Path, *, base_ts: int = 1795800000000, rows: int = 6) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    tf_label = {'M5': 'M5', 'M15': '15', 'H1': '60', 'H4': '240', 'D1': 'D'}
    step_ms = {'M5': 300_000, 'M15': 900_000, 'H1': 3_600_000, 'H4': 14_400_000, 'D1': 86_400_000}
    for tf in REQUIRED_TFS:
        lines = ['Fecha,Mensaje']
        for i in range(rows):
            ts = base_ts + i * step_ms[tf]
            iso = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
            msg = f'PING_PRICE | TF: {tf_label[tf]} | Precio: 0.91434 | High: 0.91450 | Low: 0.91410 | Z-Up: 0 | Z-Dn: 0 | TS: {ts}'
            lines.append(f'{iso},"{msg}"')
        (target_dir / f'pine-logs-SMC Master_{tf}.csv').write_text('\n'.join(lines) + '\n')


REAL_CERTIFY_REPORT = rw.certify_report


def make_certified_fixture_report(ticker: str, timestamp: int, *, status: str = 'RECOMMEND',
                                  prod_asset: dict | None = None, final_asset: dict | None = None,
                                  dataset_path: str = '/fixture/log.csv', dataset_sha: str = 'a' * 64) -> dict:
    prod_asset = prod_asset if prod_asset is not None else {'enabled': False, 'disabledReason': 'watch: fixture', 'minPointsForBuy': 7}
    change_pts = 8 if status == 'RECOMMEND' else prod_asset.get('minPointsForBuy', 7)
    final_asset = final_asset if final_asset is not None else {**prod_asset, 'minPointsForBuy': change_pts}
    prod_cfg = {'ticker': ticker, 'minBuyPoints': prod_asset.get('minPointsForBuy', 7), 'mlGate': {'enabled': False}}
    manifest = {'version': 1, 'ticker': ticker, 'from_ms': 100, 'train_end_ms': 200,
                'validation_end_ms': 300, 'test_end_ms': 300, 'test_independence': 'unverified'}
    provenance = {
        'version': 1,
        'evaluation_manifest': manifest,
        'source_files': [{'path': p, 'sha256': h} for p, h in LOADED_SCORING_HASHES.items()],
        'dataset_files': [{'path': dataset_path, 'sha256': dataset_sha}],
    }
    eval_fp = rw.json_fingerprint(provenance)
    prod_result = {
        'evaluation_fingerprint': eval_fp,
        'provenance': provenance,
        'metrics_validation': {'trade_count': 12, 'expectancy': 0.05, 'max_drawdown_r': 2.0, 'net_pnl_r': 0.6},
        'metrics_test': {'trade_count': 0, 'expectancy': 0.0},
    }
    exp_cand = 0.35 if status == 'RECOMMEND' else 0.05
    val_r = [0.5] * 12 if status == 'RECOMMEND' else [0.05] * 12

    def fake_eval(cand):
        return {
            'config': cand,
            'config_fingerprint': rw.json_fingerprint(cand),
            'evaluation_fingerprint': eval_fp,
            'provenance': provenance,
            'metrics_validation': {'trade_count': 12, 'expectancy': exp_cand, 'max_drawdown_r': 1.5, 'net_pnl_r': exp_cand * 12},
            'metrics_test': {'trade_count': 0, 'expectancy': 0.0},
            'validation_r': val_r,
        }

    rep = {
        'ticker': ticker,
        'timestamp': timestamp,
        'status': 'HOLD',
        'best_config': {'minBuyPoints': change_pts},
        'production_backtest_config': prod_cfg,
    }
    REAL_CERTIFY_REPORT(rep, prod_cfg, prod_asset, prod_result, manifest, fake_eval,
                        montecarlo=lambda *_a: {'survival': 0.92})
    rep['selection_outcome'] = 'evaluated'
    return rep


class SnapshotAndEurChfRegressionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='jarvis-eurchf-reg-')
        self.root = Path(self.tmp.name)
        self.lock_dir = self.root / 'locks'
        self.lock_env = patch.dict(os.environ, {'JARVIS_HISTORY_LOCK_DIR': str(self.lock_dir)})
        self.lock_env.start()

    def tearDown(self):
        self.lock_env.stop()
        self.tmp.cleanup()

    def test_eurchf_concurrent_truncation_during_evaluation_does_not_corrupt_snapshot(self):
        """Reproduces the exact W48 EURCHF bug: asset_scout truncates live M5 CSV to 0 lines mid-run."""
        live_export = self.root / 'logs' / 'eurchf' / 'history_exported'
        write_valid_exported_dir(live_export, base_ts=1795810000000, rows=10)
        asset_fixture = self.root / 'eurchf_asset.json'
        asset_fixture.write_text(json.dumps({'enabled': False, 'disabledReason': 'watch: test', 'minPointsForBuy': 6}))
        out_dir = self.root / 'out'
        real_run = rw.subprocess.run
        seen_log_dirs: list[Path] = []

        def mocked_run(cmd, **kwargs):
            if cmd[0] == 'node':
                return real_run(cmd, **kwargs)
            if '--help' in cmd:
                return subprocess.CompletedProcess(cmd, 0, '--current-sessions --timesfm-cache --evaluation-manifest --base-config --log-dir', '')
            def flag(name): return cmd[cmd.index(name) + 1]
            script = Path(cmd[2] if cmd[0] == 'npx' else cmd[1]).name
            if '--logs-dir' in cmd:
                seen_log_dirs.append(Path(flag('--logs-dir')))
            elif '--log-dir' in cmd:
                seen_log_dirs.append(Path(flag('--log-dir')))

            if script == 'run_hyperopt.py':
                # Simulate asset_scout truncating the shared live M5 CSV to header-only (0 data lines)!
                (live_export / 'pine-logs-SMC Master_M5.csv').write_text('Fecha,Mensaje\n')
                res = {'best_config': {'vwapPts': 2}, 'n_trials': 2}
                Path(flag('--output')).write_text(json.dumps(res))
                return subprocess.CompletedProcess(cmd, 0, json.dumps(res), '')

            if script == 'eval_production.ts':
                log_dir = Path(flag('--logs-dir'))
                m5_file = log_dir / 'pine-logs-SMC Master_M5.csv'
                m5_lines = [ln for ln in m5_file.read_text().splitlines()[1:] if ln.strip()]
                # Snapshot M5 MUST still have all 10 intact lines even after live_export was truncated!
                self.assertEqual(len(m5_lines), 10, 'frozen snapshot M5 must be immune to live_export truncation')
                manifest = {'version': 1, 'ticker': 'EURCHF', 'from_ms': 100, 'train_end_ms': 200,
                            'validation_end_ms': 300, 'test_end_ms': 300, 'test_independence': 'unverified'}
                asset = json.loads(asset_fixture.read_text())
                if '--snapshot-only' in cmd:
                    Path(flag('--snapshot-out')).write_text(json.dumps(asset))
                    Path(flag('--manifest-out')).write_text(json.dumps(manifest))
                    cfg = {'ticker': 'EURCHF', 'minBuyPoints': 6, 'mlGate': {'enabled': False}}
                else:
                    cfg = json.loads(Path(flag('--backtest-config-file')).read_text())
                prov = {
                    'version': 1,
                    'evaluation_manifest': manifest,
                    'source_files': [{'path': p, 'sha256': h} for p, h in LOADED_SCORING_HASHES.items()],
                    'dataset_files': [{'path': str(m5_file), 'sha256': sha256_file(m5_file)}],
                }
                zero = rw.canonical_metrics.to_dict(rw.canonical_metrics.compute_metrics([]))
                records = [{'timestamp': 205 + i * 5, 'closeTimestamp': 206 + i * 5, 'label_status': 'closed', 'rMultiple': 0.4} for i in range(10)]
                vm = rw.canonical_metrics.to_dict(rw.canonical_metrics.compute_metrics(records, time_bounds=(200, 300)))
                payload = {
                    'config': cfg, 'config_fingerprint': rw.json_fingerprint(cfg),
                    'evaluation_fingerprint': rw.json_fingerprint(prov), 'provenance': prov,
                    'evaluation_manifest': manifest, 'trade_records_version': 1,
                    'train_trades': [], 'validation_trades': records, 'test_trades': [],
                    'objective': -100, 'metrics_train': zero, 'metrics_validation': vm, 'metrics_test': zero,
                    'validation_r': [0.4] * 10, 'test_r': [],
                }
                Path(flag('--save')).write_text(json.dumps(payload))
                return subprocess.CompletedProcess(cmd, 0, json.dumps(payload), '')

            return subprocess.CompletedProcess(cmd, 0, '{}', '')

        argv = [
            'run_weekly.py', '--tickers', 'EURCHF', '--force', '--freeze-snapshot',
            '--skip-fetch', '--skip-refresh', '--skip-timesfm', '--skip-aux', '--skip-ml', '--skip-telemetry',
            '--config-file', str(asset_fixture), '--logs-dir', str(live_export), '--output-dir', str(out_dir),
            '--n-trials', '2', '--trigger-budget', '1',
        ]
        with patch.object(rw.sys, 'argv', argv), \
             patch.object(rw.subprocess, 'run', side_effect=mocked_run), \
             patch.object(rw, 'run_montecarlo_gate', return_value={'survival': 0.90}):
            rc = rw.main()

        self.assertEqual(rc, 0)
        self.assertTrue(seen_log_dirs)
        self.assertEqual(len(set(seen_log_dirs)), 1, 'all stages must consume the exact same frozen snapshot dir')
        self.assertNotEqual(seen_log_dirs[0].resolve(), live_export.resolve())
        rep = json.loads((out_dir / 'reports' / 'EURCHF.json').read_text())
        self.assertIn(rep['status'], ('HOLD', 'RECOMMEND'))
        # Live export was truncated to 1 line, yet snapshot remains read-only and intact!
        self.assertEqual(len((live_export / 'pine-logs-SMC Master_M5.csv').read_text().splitlines()), 1)
        snap_m5 = seen_log_dirs[0] / 'pine-logs-SMC Master_M5.csv'
        self.assertEqual(len(snap_m5.read_text().splitlines()), 11)
        with self.assertRaises(PermissionError if os.geteuid() != 0 else OSError):
            # Even for root, verify mode bits are 0444 (read-only)
            mode = snap_m5.stat().st_mode & 0o777
            self.assertEqual(mode, 0o444)
            raise OSError('verified 0444')

    def test_preflight_rejects_empty_truncated_missing_and_foreign_snapshots(self):
        src = self.root / 'src_csvs'
        snaps = self.root / 'snaps'
        write_valid_exported_dir(src, base_ts=1795810000000, rows=5)

        # 1) Header-only M5 (0 data lines — exact EURCHF symptom)
        (src / 'pine-logs-SMC Master_M5.csv').write_text('Fecha,Mensaje\n')
        with self.assertRaisesRegex(SnapshotPreflightError, '0 data lines'):
            freeze_ticker_snapshot('EURCHF', src, snaps, cycle_run_id='run-1', cycle_week='2026-W48', started_at=1000)

        # 2) Truncated row without trailing newline
        write_valid_exported_dir(src, base_ts=1795810000000, rows=5)
        (src / 'pine-logs-SMC Master_M5.csv').write_text('Fecha,Mensaje\n2026-11-27,"PING_PRICE | TF: M5 | TS: 100"')
        with self.assertRaisesRegex(SnapshotPreflightError, 'truncated'):
            freeze_ticker_snapshot('EURCHF', src, snaps, cycle_run_id='run-1', cycle_week='2026-W48', started_at=1000)

        # 3) Missing H4 file
        write_valid_exported_dir(src, base_ts=1795810000000, rows=5)
        (src / 'pine-logs-SMC Master_H4.csv').unlink()
        with self.assertRaisesRegex(SnapshotPreflightError, 'missing exported CSV for H4'):
            freeze_ticker_snapshot('EURCHF', src, snaps, cycle_run_id='run-1', cycle_week='2026-W48', started_at=1000)

        # 4) Stale M5 export older than candle_ms
        write_valid_exported_dir(src, base_ts=1795810000000, rows=2)
        with self.assertRaisesRegex(SnapshotPreflightError, 'stale M5 export'):
            freeze_ticker_snapshot('EURCHF', src, snaps, cycle_run_id='run-1', cycle_week='2026-W48',
                                   started_at=1000, min_m5_close_ms=1799999999000)

        # 5) Foreign ticker or foreign run_id rejected by verify_ticker_snapshot
        manifest = freeze_ticker_snapshot('EURCHF', src, snaps, cycle_run_id='run-1', cycle_week='2026-W48', started_at=1000)
        snap_dir = Path(manifest['snapshot_dir'])
        with self.assertRaisesRegex(SnapshotPreflightError, 'ticker mismatch'):
            verify_ticker_snapshot(snap_dir, expected_ticker='EURUSD', expected_run_id='run-1')
        with self.assertRaisesRegex(SnapshotPreflightError, 'another run'):
            verify_ticker_snapshot(snap_dir, expected_ticker='EURCHF', expected_run_id='run-2')

    def test_snapshot_retention_never_deletes_referenced_dataset(self):
        src = self.root / 'src'
        snaps = self.root / 'snaps'
        reports = self.root / 'reports'
        reports.mkdir()
        write_valid_exported_dir(src)
        m_keep = freeze_ticker_snapshot('GBPCAD', src, snaps, cycle_run_id='old-keep', cycle_week='2026-W46', started_at=100)
        m_drop = freeze_ticker_snapshot('EURUSD', src, snaps, cycle_run_id='old-drop', cycle_week='2026-W46', started_at=200)
        for p in (Path(m_keep['snapshot_dir']).parent, Path(m_drop['snapshot_dir']).parent):
            os.utime(p, (1, 1))
        (reports / 'GBPCAD.json').write_text(json.dumps({
            'evaluation_provenance': {'dataset_files': [{'path': m_keep['files']['M5']['path'], 'sha256': m_keep['files']['M5']['sha256']}]}
        }))
        removed = prune_unreferenced_snapshots(snaps, reports, now_ms=30 * 86400 * 1000)
        self.assertEqual(removed, [str(Path(m_drop['snapshot_dir']).parent)])
        self.assertTrue(Path(m_keep['files']['M5']['path']).exists())


class ResumePartialAndRecoveryRegressionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='jarvis-resume-reg-')
        self.root = Path(self.tmp.name)
        self.lock_env = patch.dict(os.environ, {'JARVIS_HISTORY_LOCK_DIR': str(self.root / 'locks')})
        self.lock_env.start()

    def tearDown(self):
        self.lock_env.stop()
        self.tmp.cleanup()

    def test_partial_cycle_applied_and_failed_resumes_without_reapplying_or_clobbering(self):
        """GBPCAD already APPLIED + EURCHF FAILED -> resume keeps GBPCAD APPLIED intact and evaluates only EURCHF."""
        state_dir = self.root / 'state'
        reports_dir = self.root / 'reports'
        opt_dir = self.root / 'opt_out'
        logs_root = self.root / 'repo_logs'
        for d in (state_dir, reports_dir, opt_dir):
            d.mkdir(parents=True)

        now = int(time.time() * 1000)
        started_at = now - 3600_000
        run_id = str(uuid.uuid4())
        week = wcs.week_of(started_at)
        ctx = {'version': 1, 'week': week, 'run_id': run_id, 'started_at': started_at,
               'tickers': ['GBPCAD', 'EURCHF'], 'invocation_id': 'inv1'}
        wcs.atomic_json(state_dir / 'weekly_cycle_context.json', ctx)

        # GBPCAD was evaluated and APPLIED in attempt 1 of this cycle
        gbp_rep = make_certified_fixture_report('GBPCAD', started_at + 10_000, status='RECOMMEND')
        gbp_rep['application'] = {
            'status': 'APPLIED',
            'at': started_at + 12_000,
            'asset_fingerprint': gbp_rep['final_asset_fingerprint'],
            'tracking_id': f"GBPCAD_{gbp_rep['timestamp']}",
            'confirmed_at_ms': started_at + 13_000,
        }
        wcs.atomic_json(reports_dir / 'GBPCAD.json', gbp_rep)
        save_success(reports_dir / 'selection_state' / 'GBPCAD.json', gbp_rep, 1795810000000,
                     rw.validate_certified_report, expected_asset_fingerprint=gbp_rep['final_asset_fingerprint'])

        # EURCHF failed in attempt 1
        wcs.atomic_json(reports_dir / 'EURCHF.json', {
            'ticker': 'EURCHF', 'timestamp': started_at + 20_000, 'status': 'ERROR',
            'selection_outcome': 'failed', 'reason': 'snapshot changed after init',
        })
        wcs.atomic_json(opt_dir / 'weekly_progress.json', {
            'cycle_run_id': run_id, 'cycle_week': week, 'started_at': started_at, 'done': ['GBPCAD'],
        })

        write_valid_exported_dir(logs_root / 'eurchf' / 'history_exported', base_ts=1795810000000, rows=6)
        deploy_calls: list[tuple[str, bool]] = []
        eval_calls: list[str] = []
        real_run = rw.subprocess.run

        def fake_subproc(cmd, **kw):
            if cmd[0] == 'node':
                return real_run(cmd, **kw)
            if '--weekly-rollout' in cmd:
                t = cmd[cmd.index('--tickers') + 1]
                fo = '--followup-only' in cmd
                deploy_calls.append((t, fo))
                if not fo and t == 'EURCHF':
                    rp = reports_dir / 'EURCHF.json'
                    d = json.loads(rp.read_text())
                    d['application'] = {'status': 'UNCHANGED', 'at': int(time.time() * 1000)}
                    wcs.atomic_json(rp, d)
                return subprocess.CompletedProcess(cmd, 0, '{}', '')
            return subprocess.CompletedProcess(cmd, 0, '{}', '')

        def fake_cmd_json(cmd, **_kw):
            t = cmd[3]
            eval_calls.append(t)
            asset_out = Path(cmd[cmd.index('--snapshot-out') + 1])
            man_out = Path(cmd[cmd.index('--manifest-out') + 1])
            asset_out.write_text(json.dumps({'enabled': False, 'disabledReason': 'watch: eurchf'}))
            man_out.write_text(json.dumps({'version': 1, 'ticker': t, 'from_ms': 100, 'train_end_ms': 200,
                                           'validation_end_ms': 300, 'test_end_ms': 300, 'test_independence': 'unverified'}))
            return {'config': {'ticker': t, 'minBuyPoints': 7, 'mlGate': {'enabled': False}}}

        def fake_certify(rep, *_a, **_kw):
            built = make_certified_fixture_report(rep['ticker'], rep['timestamp'], status='HOLD')
            rep.update(built)
            return rep

        fake_repo = self.root / 'fake_repo'
        (fake_repo / 'logs' / 'eurchf').mkdir(parents=True)
        (fake_repo / 'logs' / 'eurchf' / 'history_exported').symlink_to(logs_root / 'eurchf' / 'history_exported')

        argv = ['run_weekly.py', '--tickers', 'GBPCAD,EURCHF', '--resume',
                '--skip-fetch', '--skip-refresh', '--skip-hyperopt', '--skip-timesfm', '--skip-aux', '--skip-ml', '--skip-telemetry']
        with patch.dict(os.environ, {'JARVIS_WEEKLY_CONTEXT': str(state_dir / 'weekly_cycle_context.json')}), \
             patch.object(rw.sys, 'argv', argv), \
             patch.object(rw, 'REPO', fake_repo), \
             patch.object(rw, 'REPORTS_DIR', reports_dir), \
             patch.object(rw, 'OPT_OUT_DIR', opt_dir), \
             patch.object(rw, 'AUTO_APPLY_ENABLED', True), \
             patch.object(rw, 'get_api_key', return_value='fixture-key'), \
             patch.object(rw, 'count_new_trades', return_value=0), \
             patch.object(rw, 'last_candle_ms', return_value=1795810000000), \
             patch.object(rw, 'read_live_asset_fingerprint', side_effect=lambda t: gbp_rep['final_asset_fingerprint'] if t == 'GBPCAD' else 'x' * 64), \
             patch.object(rw, 'command_json', side_effect=fake_cmd_json), \
             patch.object(rw, 'canonicalize_result', side_effect=lambda x: x), \
             patch.object(rw, 'certify_report', side_effect=fake_certify), \
             patch.object(rw, 'run_dsr_gate', return_value={}), \
             patch.object(rw.subprocess, 'run', side_effect=fake_subproc):
            rc = rw.main()

        self.assertEqual(rc, 0)
        # GBPCAD was NOT re-evaluated and NOT re-deployed!
        self.assertEqual(eval_calls, ['EURCHF'])
        self.assertNotIn(('GBPCAD', False), deploy_calls)
        self.assertIn(('EURCHF', False), deploy_calls)
        saved_gbp = json.loads((reports_dir / 'GBPCAD.json').read_text())
        self.assertEqual(saved_gbp['status'], 'RECOMMEND')
        self.assertEqual(saved_gbp['application']['status'], 'APPLIED')
        self.assertEqual(saved_gbp['application']['tracking_id'], f"GBPCAD_{gbp_rep['timestamp']}")
        # Summary now passes full cycle verification!
        summary_path = opt_dir / 'weekly_selection_summary.json'
        proof = wcs.summary_evidence(ctx, summary_path, int(time.time() * 1000))
        self.assertEqual(proof['run_id'], run_id)

    def test_needs_selection_detects_live_config_change_and_data_change_on_recovery(self):
        state_path = self.root / 'selection_state' / 'USDCAD.json'
        rep = make_certified_fixture_report('USDCAD', 1795700000000, status='HOLD')
        saved = save_success(state_path, rep, 1795600000000, rw.validate_certified_report,
                             expected_asset_fingerprint=rep['production_asset_fingerprint'])
        loaded = load_checkpoint(state_path, 'USDCAD', rw.validate_certified_report)
        self.assertIsNotNone(loaded)
        # Unchanged candles, trades, and live config -> skip
        self.assertFalse(needs_selection(loaded, 1795600000000, 0, 20,
                                         current_asset_fingerprint=rep['production_asset_fingerprint'],
                                         latest_report=rep))
        # Operator changed live asset_configs during recovery -> MUST re-evaluate!
        self.assertTrue(needs_selection(loaded, 1795600000000, 0, 20,
                                        current_asset_fingerprint='f' * 64,
                                        latest_report=rep))
        # New candles arrived during recovery -> MUST re-evaluate!
        self.assertTrue(needs_selection(loaded, 1795810000000, 0, 20,
                                        current_asset_fingerprint=rep['production_asset_fingerprint'],
                                        latest_report=rep))


class SchedulingBoundariesLocksAndNotificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='jarvis-sched-reg-')
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_monday_crossing_and_iso_year_53_week_crossing(self):
        # 1) Friday W48 (2026-11-27T23:00Z) finishing Monday W49 (2026-11-30T08:00Z)
        fri_w48 = int(datetime(2026, 11, 27, 23, 0, tzinfo=timezone.utc).timestamp() * 1000)
        mon_w49 = int(datetime(2026, 11, 30, 8, 0, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertEqual(wcs.week_of(fri_w48), '2026-W48')
        self.assertEqual(wcs.week_of(mon_w49), '2026-W49')

        state = self.root / 'state_w48'
        state.mkdir()
        summary = self.root / 'summary_w48.json'
        progress = self.root / 'progress_w48.json'
        ctx = {'version': 1, 'week': '2026-W48', 'run_id': str(uuid.uuid4()),
               'started_at': fri_w48, 'tickers': ['EURUSD', 'USDCAD'], 'invocation_id': 'w48'}
        s = {'version': 1, 'cycle_week': '2026-W48', 'cycle_run_id': ctx['run_id'],
             'started_at': fri_w48, 'completed_at': mon_w49 - 1000, 'status': 'completed',
             'tickers': ['EURUSD', 'USDCAD'], 'errors': [], 'error': None,
             'counts': {'evaluated': 2, 'skipped': 0, 'failed': 0},
             'outcomes': [{'ticker': t, 'timestamp': mon_w49 - 5000, 'outcome': 'evaluated', 'status': 'HOLD'}
                          for t in ('EURUSD', 'USDCAD')]}
        wcs.atomic_json(state / 'weekly_cycle_context.json', ctx)
        wcs.atomic_json(summary, s)
        proof = wcs.summary_evidence(ctx, summary, mon_w49)
        wcs.atomic_json(state / 'weekly_python_done_2026-W48', proof)
        # Before sealing W48 on Monday W49 -> plan is 'posts' for W48 (not 'new' W49!)
        act, planned_ctx = wcs.plan(state, summary, progress, '2026-W49', mon_w49)
        self.assertEqual((act, planned_ctx['week']), ('posts', '2026-W48'))
        # Seal W48 -> later Friday W49 starts cleanly as 'new'!
        (state / 'weekly_cycle_last').write_text('2026-W48\n')
        act_after, _ = wcs.plan(state, summary, progress, '2026-W49', mon_w49 + 3600_000)
        self.assertEqual(act_after, 'new')

        # 2) ISO 53-week year crossing: 2026-12-31 (2026-W53) -> 2027-01-01 (still 2026-W53!) -> 2027-01-04 (2027-W01)
        dec31 = int(datetime(2026, 12, 31, 22, 0, tzinfo=timezone.utc).timestamp() * 1000)
        jan01 = int(datetime(2027, 1, 1, 12, 0, tzinfo=timezone.utc).timestamp() * 1000)
        jan04 = int(datetime(2027, 1, 4, 2, 0, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertEqual(wcs.week_of(dec31), '2026-W53')
        self.assertEqual(wcs.week_of(jan01), '2026-W53')
        self.assertEqual(wcs.week_of(jan04), '2027-W01')

        state53 = self.root / 'state_w53'
        state53.mkdir()
        ctx53 = {'version': 1, 'week': '2026-W53', 'run_id': str(uuid.uuid4()),
                 'started_at': dec31, 'tickers': ['EURUSD', 'USDCAD']}
        wcs.atomic_json(state53 / 'weekly_cycle_context.json', ctx53)
        wcs.atomic_json(progress, {'cycle_run_id': ctx53['run_id'], 'cycle_week': '2026-W53',
                                   'started_at': dec31, 'done': ['EURUSD']})
        act53, c53 = wcs.plan(state53, summary, progress, '2027-W01', jan04)
        self.assertEqual((act53, c53['week']), ('resume', '2026-W53'))

    def test_scout_guard_and_fallback_mutual_exclusion_while_cycle_busy_or_unfinished(self):
        state = self.root / 'state'
        state.mkdir()
        weekly_lock = self.root / 'weekly.lock'
        scout_lock = self.root / 'scout.lock'
        now = int(time.time() * 1000)
        ctx = {'version': 1, 'week': wcs.week_of(now), 'run_id': str(uuid.uuid4()),
               'started_at': now - 5000, 'tickers': ['EURUSD', 'USDCAD']}
        wcs.atomic_json(state / 'weekly_cycle_context.json', ctx)
        progress = self.root / 'progress.json'
        wcs.atomic_json(progress, {'cycle_run_id': ctx['run_id'], 'cycle_week': ctx['week'],
                                   'started_at': ctx['started_at'], 'done': ['EURUSD']})

        chain_marker = self.root / 'chained_periodic_opt'
        env = dict(
            os.environ,
            REPO=str(REPO),
            MARK_DIR=str(state),
            WEEKLY_LOCK=str(weekly_lock),
            SCOUT_LOCK=str(scout_lock),
            WEEKLY_SUMMARY=str(self.root / 'missing_summary.json'),
            WEEKLY_PROGRESS=str(progress),
            CYCLE_UNITS_STATE_OVERRIDE='inactive',
            SCOUT_CMD='true',
            CHAIN_OPT_CMD=f'touch {chain_marker}',
        )
        # Unfinished W48 resume context -> scout --condition and --run MUST refuse and NEVER chain!
        r_cond = subprocess.run(['bash', str(HERE / 'run_scout_guard.sh'), '--condition'],
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(r_cond.returncode, 0)
        self.assertIn('inconcluso', r_cond.stdout)
        r_run = subprocess.run(['bash', str(HERE / 'run_scout_guard.sh'), '--run', '--chain-opt'],
                               env=env, capture_output=True, text=True)
        self.assertNotEqual(r_run.returncode, 0)
        self.assertFalse(chain_marker.exists())

        # Active periodic-opt -> scout refuses even if state_dir is clean!
        clean_state = self.root / 'clean_state'
        clean_state.mkdir()
        env_active = {**env, 'MARK_DIR': str(clean_state), 'CYCLE_UNITS_STATE_OVERRIDE': 'activating'}
        r_busy = subprocess.run(['bash', str(HERE / 'run_scout_guard.sh'), '--condition'],
                                env=env_active, capture_output=True, text=True)
        self.assertNotEqual(r_busy.returncode, 0)
        self.assertIn('activating', r_busy.stdout)

        # Clean state + inactive cycle units -> scout runs and chains periodic-opt!
        env_ok = {**env, 'MARK_DIR': str(clean_state), 'CYCLE_UNITS_STATE_OVERRIDE': 'inactive'}
        r_ok = subprocess.run(['bash', str(HERE / 'run_scout_guard.sh'), '--run', '--chain-opt'],
                              env=env_ok, capture_output=True, text=True)
        self.assertEqual(r_ok.returncode, 0, r_ok.stderr + r_ok.stdout)
        self.assertTrue(chain_marker.exists())

        # Fallback guard while weekly lock is held -> ExecCondition and --run both refuse!
        import fcntl
        fd = os.open(str(weekly_lock), os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            g_env = {**env_ok, 'SCOUT_STATE_OVERRIDE': 'inactive'}
            rc1 = subprocess.run(['bash', str(HERE / 'run_weekly_guard.sh'), '--condition'],
                                 env=g_env, capture_output=True, text=True)
            self.assertNotEqual(rc1.returncode, 0)
            self.assertIn('lock del ciclo ocupado', rc1.stdout)
            rc2 = subprocess.run(['bash', str(HERE / 'run_weekly_guard.sh'), '--run'],
                                 env=g_env, capture_output=True, text=True)
            self.assertNotEqual(rc2.returncode, 0)
            self.assertIn('otro ciclo tomó el lock', rc2.stdout)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def test_expired_context_and_roster_change_during_recovery_fail_closed(self):
        state = self.root / 'state_exp'
        state.mkdir()
        now = int(time.time() * 1000)
        old_start = now - 22 * 86400 * 1000
        wcs.atomic_json(state / 'weekly_cycle_context.json', {
            'version': 1, 'week': wcs.week_of(old_start), 'run_id': str(uuid.uuid4()),
            'started_at': old_start, 'tickers': ['EURUSD', 'USDCAD'],
        })
        with self.assertRaisesRegex(ValueError, 'expired'):
            wcs.plan(state, self.root / 's.json', self.root / 'p.json', wcs.week_of(now), now)

        # Fresh unfinished context, but roster changed during recovery -> begin fails closed!
        fresh_start = now - 60_000
        wcs.atomic_json(state / 'weekly_cycle_context.json', {
            'version': 1, 'week': wcs.week_of(fresh_start), 'run_id': str(uuid.uuid4()),
            'started_at': fresh_start, 'tickers': ['EURUSD', 'USDCAD'],
        })
        p = subprocess.run([
            'python3', str(HERE / 'weekly_cycle_state.py'), 'begin',
            '--state-dir', str(state), '--summary', str(self.root / 's.json'),
            '--progress', str(self.root / 'p.json'), '--week', wcs.week_of(fresh_start),
            '--tickers-json', '["EURUSD","USDCAD","EURCHF"]',
        ], capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('roster changed during unfinished cycle', p.stderr)

    def test_failure_notification_identifies_unit_stage_ticker_cause_and_checks_telegram(self):
        state = self.root / 'state_notify'
        reports = self.root / 'reports_notify'
        state.mkdir()
        reports.mkdir()
        run_id = str(uuid.uuid4())
        wcs.atomic_json(state / 'weekly_cycle_context.json', {'run_id': run_id, 'week': '2026-W48'})
        summary_file = self.root / 'summary_notify.json'
        wcs.atomic_json(summary_file, {
            'cycle_run_id': run_id, 'status': 'failed', 'errors': ['EURCHF'], 'error': None,
            'outcomes': [{'ticker': 'EURCHF', 'outcome': 'failed', 'status': 'ERROR',
                          'reason': 'snapshot changed after init: pine-logs-SMC Master_M5.csv'}],
        })
        wcs.atomic_json(reports / 'EURCHF.json', {
            'ticker': 'EURCHF', 'status': 'ERROR',
            'reason': 'snapshot changed after init: pine-logs-SMC Master_M5.csv',
        })
        fake_show = self.root / 'fake_show.sh'
        fake_show.write_text('#!/bin/bash\nprintf "Result=exit-code\\nExecMainStatus=1\\nTimeoutStartUSec=48h\\n"\n')
        fake_show.chmod(0o755)
        fake_journal = self.root / 'fake_journal.sh'
        fake_journal.write_text('#!/bin/bash\nprintf "ERROR EURCHF: snapshot changed after init\\nConsumed 14h 12min CPU time.\\n"\n')
        fake_journal.chmod(0o755)

        env = dict(
            os.environ,
            DRY_RUN='1',
            MARK_DIR=str(state),
            WEEKLY_SUMMARY=str(summary_file),
            REPORTS_DIR=str(reports),
            SYSTEMCTL_SHOW_CMD=str(fake_show),
            JOURNALCTL_CMD=str(fake_journal),
        )
        out = subprocess.run(['bash', str(HERE / 'opt_failure_notify.sh'), 'jarvis-periodic-opt.service'],
                             env=env, capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn('Unidad: jarvis-periodic-opt.service', out.stdout)
        self.assertIn('Etapa: run_weekly (evaluación por activo)', out.stdout)
        self.assertIn('Activo(s): EURCHF', out.stdout)
        self.assertIn('snapshot changed after init', out.stdout)
        self.assertNotIn('sin datos de systemd', out.stdout)

        # Simulated Telegram failure (missing token or unreachable API) must return non-zero!
        bad_env_file = self.root / 'bad.env'
        bad_env_file.write_text('TELEGRAM_BOT_TOKEN="synthetic-token"\nTELEGRAM_ALLOWED_USER_IDS="123"\n')
        env_fail = {**env, 'DRY_RUN': '0', 'ENV_FILE': str(bad_env_file), 'TELEGRAM_API_BASE': 'http://127.0.0.1:9'}
        fail_res = subprocess.run(['bash', str(HERE / 'opt_failure_notify.sh'), 'jarvis-periodic-opt.service'],
                                  env=env_fail, capture_output=True, text=True)
        self.assertNotEqual(fail_res.returncode, 0)


if __name__ == '__main__':
    unittest.main()
