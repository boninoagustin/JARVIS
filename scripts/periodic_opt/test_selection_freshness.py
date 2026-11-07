"""Offline regression tests: no optimizer, Firestore, services or live reports."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from contextlib import ExitStack

spec = importlib.util.spec_from_file_location('freshness_weekly', Path(__file__).with_name('run_weekly.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
import selection_freshness as f


class FreshnessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.reports = self.root / 'reports'
        self.reports.mkdir()
        self.state_path = self.reports / 'selection_state' / 'EURUSD.json'
        self.candle = 1000
        self.trades = 0
        self.refresh_ok = True
        self.fail_evaluation = False
        self.evaluations = 0
        self.journal_since = []
        self.dispatches = []

    def run_main(self, resume=False):
        def command(cmd, **kwargs):
            self.evaluations += 1
            if self.fail_evaluation:
                raise RuntimeError('synthetic failed evaluation')
            Path(cmd[cmd.index('--snapshot-out') + 1]).write_text('{}')
            Path(cmd[cmd.index('--manifest-out') + 1]).write_text('{}')
            return {'config': {'ticker': 'EURUSD'}}
        def certify(report, *args, **kwargs):
            report.update(status='HOLD', proposal_validation={'n_trades': 10},
                          production_validation={'n_trades': 10},
                          evaluation_provenance={'dataset_files': [{'sha256': 'fixture'}]},
                          evaluation_certificate={'fixture': True}, certificate={'fixture': True},
                          final_config={'ticker': 'EURUSD'}, config_fingerprint='fixture')
        def journal(key, ticker, since):
            self.journal_since.append(since)
            return self.trades
        def dispatch(cmd, **kwargs):
            self.dispatches.append(cmd)
            return w.subprocess.CompletedProcess(cmd, 0, '{}', '')
        argv = ['run_weekly.py', '--tickers', 'EURUSD', '--skip-fetch', '--skip-hyperopt',
                '--skip-timesfm', '--skip-aux', '--skip-ml', '--skip-telemetry']
        if resume:
            argv += ['--resume']
        with ExitStack() as stack:
            patches = [patch.object(w.sys, 'argv', argv),
                       patch.object(w, 'REPORTS_DIR', self.reports),
                       patch.object(w, 'OPT_OUT_DIR', self.root / 'opt'),
                       patch.object(w, 'get_api_key', return_value='fixture'),
                       patch.object(w, 'count_new_trades', side_effect=journal),
                       patch.object(w, 'last_candle_ms', side_effect=lambda t: self.candle),
                       patch.object(w, 'refresh_csvs', side_effect=lambda t: {'ok': self.refresh_ok, 'error': 'HTTP Error 404'}),
                       patch.object(w, 'command_json', side_effect=command),
                       patch.object(w, 'canonicalize_result', side_effect=lambda x: x),
                       patch.object(w, 'certify_report', side_effect=certify),
                       patch.object(w, 'validate_certified_report', return_value=True),
                       patch.object(w, 'run_dsr_gate', return_value={}),
                       patch.object(w.subprocess, 'run', side_effect=dispatch)]
            for item in patches:
                stack.enter_context(item)
            code = w.main()
        report = json.loads((self.reports / 'EURUSD.json').read_text())
        summary = json.loads((self.root / 'opt' / 'weekly_selection_summary.json').read_text())
        self.assertIsNotNone(summary['completed_at'])
        self.assertEqual(summary['status'], 'failed' if code else 'completed')
        self.assertEqual(summary['counts'][report['selection_outcome']], 1)
        self.assertEqual(summary['outcomes'][0]['ticker'], 'EURUSD')
        return code, report

    def test_404_retry_without_force_evaluates(self):
        self.refresh_ok = False
        code, report = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(report['status'], 'ERROR')
        self.assertFalse(self.state_path.exists())
        self.refresh_ok = True
        code, report = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(self.evaluations, 1)
        self.assertEqual(report['selection_outcome'], 'evaluated')
        self.assertTrue(self.state_path.exists())

    def test_success_unchanged_repeated_skips_preserve_candidate_and_no_apply(self):
        self.run_main()
        original = self.state_path.read_bytes()
        for _ in range(3):
            self.dispatches.clear()
            code, report = self.run_main()
            self.assertEqual(code, 0)
            self.assertEqual(report['selection_outcome'], 'skipped')
            self.assertEqual(report['application']['status'], 'UNCHANGED')
            self.assertFalse(report['apply_eligible'])
            self.assertNotIn('final_config', report)
            self.assertNotIn('certificate', report)
            self.assertFalse(report['last_successful_selection']['fresh_for_this_attempt'])
            self.assertTrue(all('--followup-only' in cmd for cmd in self.dispatches))
            self.assertEqual(self.state_path.read_bytes(), original)
        self.assertEqual(self.evaluations, 1)

    def test_new_candle_evaluates_even_before_attempt_wallclock(self):
        self.run_main()
        self.candle += 300000
        self.assertEqual(self.run_main()[1]['selection_outcome'], 'evaluated')
        self.assertEqual(self.evaluations, 2)

    def test_journal_accumulates_under_unchanged_success_watermark(self):
        self.run_main()
        original = self.state_path.read_bytes()
        since = json.loads(original)['watermark']['journal_since_ms']
        for count in (1, 10, 19):
            self.trades = count
            self.assertEqual(self.run_main()[1]['selection_outcome'], 'skipped')
            self.assertEqual(self.journal_since[-1], since)
            self.assertEqual(self.state_path.read_bytes(), original)
        self.trades = 20
        self.assertEqual(self.run_main()[1]['selection_outcome'], 'evaluated')
        self.assertEqual(self.evaluations, 2)

    def test_failed_new_evaluation_preserves_success_and_retry_evaluates(self):
        self.run_main()
        original = self.state_path.read_bytes()
        self.candle += 300000
        self.fail_evaluation = True
        self.dispatches.clear()
        code, report = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(report['application']['status'], 'BLOCKED')
        self.assertEqual(self.state_path.read_bytes(), original)
        self.assertTrue(all('--followup-only' in cmd for cmd in self.dispatches))
        self.fail_evaluation = False
        self.assertEqual(self.run_main()[1]['selection_outcome'], 'evaluated')
        self.assertEqual(self.evaluations, 3)

    def test_legacy_invalid_no_evidence_and_resume_done_require_evaluation(self):
        (self.reports / 'EURUSD.json').write_text(json.dumps({'ticker': 'EURUSD', 'status': 'HOLD', 'timestamp': 9999999999999}))
        opt = self.root / 'opt'
        opt.mkdir()
        (opt / 'weekly_progress.json').write_text(json.dumps({'done': ['EURUSD'], 'started_at': 1}))
        self.assertEqual(self.run_main(resume=True)[1]['selection_outcome'], 'evaluated')
        self.assertEqual(self.evaluations, 1)

    def test_corrupt_checkpoint_and_missing_evidence_fail_open_to_evaluation(self):
        self.state_path.parent.mkdir()
        self.state_path.write_text('{broken')
        self.assertIsNone(f.load_checkpoint(self.state_path, 'EURUSD', lambda r: True))
        self.assertFalse(f.successful_selection({'status': 'HOLD', 'timestamp': 123}, lambda r: True))
        self.assertTrue(f.needs_selection(None, 100, 0, 20))
        self.assertEqual(self.run_main()[1]['selection_outcome'], 'evaluated')

    def test_journal_pagination_counts_all_pages(self):
        doc = lambda ts: {'fields': {'ticker': {'stringValue': 'EURUSD'}, 'timestamp': {'integerValue': str(ts)}}}
        with patch.object(w, 'rest_json', side_effect=[{'documents': [doc(10)], 'nextPageToken': 'token /'}, {'documents': [doc(20), doc(30)]}]) as rest:
            self.assertEqual(w.count_new_trades('fixture', 'EURUSD', 10), 2)
            self.assertIn('pageToken=token%20%2F', rest.call_args_list[1].args[0])


if __name__ == '__main__':
    unittest.main()
