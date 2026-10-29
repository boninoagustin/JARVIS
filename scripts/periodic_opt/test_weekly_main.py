"""Synthetic offline integration: exercises real main, mocks only subprocess/network.
No market-quality claim; all metrics and labels below are explicit fixtures.
"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('weekly_main', Path(__file__).with_name('run_weekly.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
from objective_adapter import LOADED_SCORING_HASHES

class MainIntegrationTests(unittest.TestCase):
    def test_main_freezes_one_context_and_certifies_all_aux_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            asset = {'minPointsForBuy': 7, 'sessions': {'NY': {'choch5m': {'enabled': True, 'minScore': 5, 'minimal_roi': {'0': .2, '30': .1, '120': 0}}}}}
            config = {'ticker': 'EURUSD', 'minBuyPoints': 7, 'sessions': asset['sessions'], 'mlGate': {'enabled': False}}
            fixture = root / 'asset.json'
            fixture.write_text(json.dumps(asset))
            manifest = dict(version=1, ticker='EURUSD', from_ms=100, train_end_ms=200, validation_end_ms=300, test_end_ms=300, test_independence='unverified')
            commands, evaluated, mc_series = [], [], []
            provenance = {'version': 1, 'evaluation_manifest': manifest,
                          'source_files':[{'path':p,'sha256':h} for p,h in LOADED_SCORING_HASHES.items()],
                          'dataset_files': [{'path': '/fixture/log.csv', 'sha256': 'fixture-only'}]}
            real_run = w.subprocess.run
            def run(cmd, **kwargs):
                if cmd[0] == 'node':
                    return real_run(cmd, **kwargs)  # actual cross-language canonical hashing
                commands.append(cmd)
                def flag(k): return cmd[cmd.index(k)+1]
                result = {}
                if '--help' in cmd:
                    return w.subprocess.CompletedProcess(cmd, 0, '--current-sessions --timesfm-cache --evaluation-manifest --base-config --log-dir', '')
                script = Path(cmd[2] if cmd[0] == 'npx' else cmd[1]).name
                if script == 'eval_production.ts':
                    if '--snapshot-only' in cmd:
                        Path(flag('--snapshot-out')).write_text(json.dumps(asset))
                        Path(flag('--manifest-out')).write_text(json.dumps(manifest))
                        effective = config
                    else:
                        effective = json.loads(Path(flag('--backtest-config-file')).read_text())
                        evaluated.append(effective)
                    # Explicit synthetic closes obey the same transport as a real
                    # worker; metrics must agree with these fixture labels.
                    rs = [2]*10 if evaluated else [-1]*10
                    records = [dict(timestamp=201+i*9,closeTimestamp=202+i*9,
                                    label_status='closed',rMultiple=r) for i,r in enumerate(rs)]
                    zero = w.canonical_metrics.to_dict(w.canonical_metrics.compute_metrics([]))
                    vm = w.canonical_metrics.to_dict(w.canonical_metrics.compute_metrics(records,time_bounds=(200,300)))
                    result = {'config':effective,'config_fingerprint':w.json_fingerprint(effective),
                              'evaluation_fingerprint':w.json_fingerprint(provenance),'provenance':provenance,
                              'evaluation_manifest':manifest,'trade_records_version':1,
                              'train_trades':[],'validation_trades':records,'test_trades':[],
                              'objective':-100,'metrics_train':zero,'metrics_validation':vm,
                              'metrics_test':zero,'validation_r':rs,'test_r':[]}
                elif script == 'run_hyperopt.py':
                    result = {'best_config': {'vwapPts': 3}, 'n_trials': 1}
                    Path(flag('--output')).write_text(json.dumps(result))
                elif script == 'per_trigger_tune.ts':
                    result = {'sessions': {'NY': {'choch5m': {'minScore': 8}}}, 'final': {'fixture': True}}
                elif script == 'killswitch_tune.ts':
                    result = {'maxDailyLossR': 2, 'maxConsecutiveLosses': 1}
                elif script == 'directional_mcl_tune.ts':
                    result = {'updates': {'sessions.NY.maxBuyLosses': 2}}
                elif script == 'bias_confluence_tune.ts':
                    result = {'status': 'RECOMMEND', 'recommended': {'bc': {'fullPts': 5}}}
                elif script == 'loser_triggers_proposal.ts':
                    result = {'status': 'PROPUESTA', 'disables': [{'session': 'NY', 'trigger': 'bos5m'}]}
                elif script == 'sizing_weekly_proposal.ts':
                    result = {'status': 'HOLD', 'n': 0, 'apply_eligible': False}
                elif script == 'train_ml_weekly.py':
                    self.assertIn('--dry-run', cmd)
                    self.assertNotIn('--allow-promotion', cmd)
                else:
                    self.fail(f'unexpected external command: {cmd}')
                if '--save' in cmd:
                    Path(flag('--save')).write_text(json.dumps(result))
                return w.subprocess.CompletedProcess(cmd, getattr(self, 'ml_exit', 0) if script == 'train_ml_weekly.py' else 0, json.dumps(result), '')
            argv = ['run_weekly.py', '--tickers', 'EURUSD', '--force', '--skip-fetch', '--skip-refresh', '--skip-timesfm', '--skip-telemetry', '--config-file', str(fixture), '--output-dir', str(root / 'out'), '--n-trials', '1', '--trigger-budget', '1']
            with patch.object(w, 'AUTO_APPLY_ENABLED', True), patch.object(w.sys, 'argv', argv), patch.object(w.subprocess, 'run', side_effect=run), patch.object(w, 'get_api_key', side_effect=AssertionError('fixture must not read API key')), patch.object(w, 'count_new_trades', side_effect=AssertionError('fixture must not read journal')), patch.object(w, 'run_montecarlo_gate', side_effect=lambda t, rs: mc_series.append(rs) or {'survival': .9}):
                try:
                    code = w.main()
                except SystemExit as exc:
                    self.fail(f'main lacks isolated integrated CLI contract (exit {exc.code})')
            self.assertEqual(code, 1 if getattr(self, 'ml_exit', 0) not in (0, 2) else 0)
            report = json.loads((root / 'out' / 'reports' / 'EURUSD.json').read_text())
            self.assertEqual(report['status'], 'HOLD_ML_ERROR' if getattr(self, 'ml_exit', 0) not in (0, 2) else 'RECOMMEND')
            self.assertFalse(report['apply_eligible'])
            self.assertEqual(report['production_backtest_config'], config)
            self.assertEqual(len(evaluated), 1)
            final = evaluated[0]
            self.assertEqual(final['minBuyPoints'], 7)
            self.assertEqual(final['sessions']['NY']['choch5m']['minScore'], 8)
            self.assertNotIn('minimal_roi', final['sessions']['NY']['choch5m'])
            self.assertNotIn('minimal_roi', report['final_asset_config']['sessions']['NY']['choch5m'])
            self.assertEqual(final['sessions']['NY']['maxBuyLosses'], 2)
            self.assertEqual(final['sessions']['NY']['bos5m']['minScore'], 99)
            self.assertEqual(final['maxDailyLossR'], 2)
            self.assertEqual(final['biasConfluence'], {'fullPts': 5})
            self.assertEqual(mc_series, [[2]*10])
            self.assertEqual(report['evaluation_fingerprint'], w.json_fingerprint(provenance))
            self.assertTrue(w.validate_certified_report(report))
            self.assertFalse(report['certificate']['test_evaluated'])
            self.assertIn('metrics_test', report)
            selection_names = {'per_trigger_tune.ts', 'killswitch_tune.ts', 'directional_mcl_tune.ts', 'bias_confluence_tune.ts', 'loser_triggers_proposal.ts', 'sizing_weekly_proposal.ts'}
            selections = [cmd for cmd in commands if cmd[0] == 'npx' and Path(cmd[2]).name in selection_names]
            self.assertEqual(len(selections), 6)
            shared_manifests = set()
            shared_snapshots = set()
            for cmd in selections:
                self.assertIn('--dry-run', cmd)
                shared_manifests.add(cmd[cmd.index('--evaluation-manifest')+1])
                shared_snapshots.add(cmd[cmd.index('--config-file')+1])
                self.assertIn('--backtest-config-file', cmd)
            self.assertEqual(len(shared_manifests), 1)
            self.assertEqual(len(shared_snapshots), 1)
            hp = next(cmd for cmd in commands if 'run_hyperopt.py' in ' '.join(cmd) and '--help' not in cmd)
            self.assertIn('--evaluation-manifest', hp)
            overlay = json.loads(Path(hp[hp.index('--current-sessions')+1]).read_text())
            self.assertEqual(overlay['sessions'], asset['sessions'])
            self.assertEqual(overlay['minPointsForBuy'], 7)
            self.assertIs(overlay['mlGateEnabled'], False)
            self.assertEqual(len([cmd for cmd in commands if '--snapshot-only' in cmd]), 1)

    def test_ml_hard_error_does_not_report_a_successful_cycle(self):
        self.ml_exit = 1
        self.test_main_freezes_one_context_and_certifies_all_aux_changes()

    def test_ml_insufficient_data_is_safe_hold_not_pipeline_error(self):
        self.ml_exit = 2
        self.test_main_freezes_one_context_and_certifies_all_aux_changes()

if __name__ == '__main__':
    unittest.main()
