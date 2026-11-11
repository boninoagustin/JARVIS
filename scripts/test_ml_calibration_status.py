#!/usr/bin/env python3
import ast
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import ml_calibration_status as status
import train_ml_model as trainer

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = {'version': 1, 'ticker': 'JP225', 'from_ms': 0, 'train_end_ms': 100,
            'validation_end_ms': 200, 'test_end_ms': 300, 'test_independence': 'unverified'}


def data(n=50, classes=True, calibration=20, final=30):
    rows = lambda count, start: [{'label': i % 2 if classes else 1, 'ts': start+i,
                                'closedAt': start+i+1} for i in range(count)]
    return {'train': rows(n, 10), 'validation': rows(calibration, 110),
            'final_readiness': status.partition(rows(final, 210), 30),
            'manifest': dict(MANIFEST), 'counts': {}}


def current_model():
    return {'meta': {'threshold_calibration_protocol': dict(status.THRESHOLD_PROTOCOL),
                     'evaluation_manifest': dict(MANIFEST)}}


def comparison(binding):
    return {'schemaVersion': 2, 'scope': 'temporal_threshold_holdout', 'status': 'valid',
            'candidate': binding['path'], 'candidateSha256': binding['sha256']}


class ReadinessTests(unittest.TestCase):
    def test_fixed_three_windows_split_previous_validation_by_time_not_returns(self):
        old = dict(MANIFEST, validation_end_ms=300, test_end_ms=300)
        self.assertEqual(status.three_window_manifest(old, 'JP225'), MANIFEST)
        self.assertEqual(old['validation_end_ms'], 300)
        with self.assertRaises(trainer.ProtocolError):
            status.three_window_manifest(dict(old, validation_end_ms=101, test_end_ms=101), 'JP225')

    def test_missing_all_three_counts(self):
        out = status.readiness(data(6, calibration=4, final=8), None)
        self.assertFalse(out['ready'])
        self.assertEqual(out['train']['missing'], 44)
        self.assertEqual(out['calibration']['missing'], 16)
        self.assertEqual(out['validation']['missing'], 22)
        self.assertEqual([out[k]['required'] for k in ('train', 'calibration', 'validation')], [50, 20, 30])

    def test_both_classes_required_in_each_window_even_at_numeric_floor(self):
        for window in ('train', 'validation'):
            d = data()
            for r in d[window]: r['label'] = 1
            self.assertFalse(status.readiness(d, None)['ready'])
        d = data(); d['final_readiness'] = status.partition([{'label': 1}]*30, 30)
        self.assertFalse(status.readiness(d, None)['ready'])

    def test_unknown_provenance_requires_explicit_bootstrap(self):
        with patch('train_ml_model.guard_freshness', side_effect=trainer.InsufficientSamples('HOLD_FRESHNESS_UNKNOWN: unknown')):
            out = status.readiness(data(), None)
        self.assertTrue(out['ready']); self.assertTrue(out['bootstrapRequired'])
        self.assertEqual(out['state'], 'BOOTSTRAP_REQUIRED')

    def test_current_protocol_insufficient_freshness_cannot_bootstrap(self):
        with patch('train_ml_model.guard_freshness', side_effect=trainer.InsufficientSamples('HOLD_FRESHNESS: 0 new closed trades < 15')):
            out = status.readiness(data(), current_model())
        self.assertFalse(out['ready']); self.assertNotIn('bootstrapRequired', out)

    def test_protocol_migration_requires_explicit_confirm_and_all_guards(self):
        out = status.readiness(data(), {'meta': {}})
        self.assertTrue(out['ready']); self.assertTrue(out['protocolBootstrapRequired'])
        self.assertTrue(out['bootstrapRequired'])
        self.assertFalse(status.readiness(data(final=29), {'meta': {}})['ready'])
        self.assertFalse(status.readiness(data(calibration=19), {'meta': {}})['ready'])

    def test_known_ready_never_passes_C_to_freshness(self):
        d = data(); d['test'] = [{'rMultiple': 99999}]
        with patch('train_ml_model.guard_freshness', return_value={}) as fresh:
            out = status.readiness(d, current_model())
        self.assertTrue(out['ready'])
        self.assertNotIn('final_readiness', fresh.call_args.args[0])
        self.assertNotIn('test', fresh.call_args.args[0])
        self.assertEqual(out['recommendation'], 'NOT_EVALUATED')

    def test_atomic_cache_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(status, 'CACHE', Path(tmp)), patch.object(status, 'STATUS', Path(tmp)/'status.json'):
                status.save({'assets': {'EURUSD': {'ready': False}}})
                self.assertFalse(status.read_status()['assets']['EURUSD']['ready'])

    def test_api_origin_and_csrf(self):
        import re
        class HTTPException(Exception):
            def __init__(self, **kw): self.status_code = kw['status_code']
        tree = ast.parse((ROOT/'kronos_api/main.py').read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name=='_ml_origin')
        env = {'re': re, 'HTTPException': HTTPException}
        exec(compile(ast.Module(body=[node], type_ignores=[]), '<origin>', 'exec'), env)
        class Request:
            def __init__(self, headers): self.headers=headers
        for headers in ({}, {'origin':'https://evil.example'}, {'origin':'http://localhost:5173.evil'}):
            with self.assertRaises(HTTPException): env['_ml_origin'](Request(headers))
        with self.assertRaises(HTTPException): env['_ml_origin'](Request({'origin':'http://localhost:5173'}), True)
        env['_ml_origin'](Request({'origin':'http://localhost:5173','x-jarvis-ml':'recalibrate'}), True)


class CollectorIsolationTests(unittest.TestCase):
    def test_collect_projects_only_C_counts_and_keeps_AB_trainer_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'logs/jp225/history_exported').mkdir(parents=True)
            provenance = {'dataset_files': [], 'source_files': []}
            effective = {'ticker': 'JP225', 'mlGate': {'enabled': False}}
            source = {'worker_provenance': provenance, 'partitions': {'validation': {'config_fingerprint': 'a'*64}}}
            calls = []
            class RPC:
                def __call__(self, method, params):
                    calls.append((method, params))
                    if method == 'init':
                        return {'evaluation_manifest': dict(MANIFEST, validation_end_ms=300, test_end_ms=300)}
                    if method == 'evaluate_final':
                        return {'evaluation_manifest': MANIFEST, 'provenance': provenance,
                            'effective_config': effective, 'config_fingerprint': 'a'*64,
                            'ml_provenance': {'enabled': False}, 'test_evidence': {'partition': 'test'},
                            'metrics_test': {'pnl_r': 9999999}, 'test_r': [9999999],
                            'test_trades': [{'timestamp': 210+i, 'closeTimestamp': 211+i,
                                'label_status': 'closed', 'rMultiple': 9999999 if i%2 else -9999999} for i in range(30)] + [
                                {'timestamp': 250, 'closeTimestamp': 251, 'label_status': 'closed', 'rMultiple': value}
                                for value in (0, float('nan'), float('inf'), True)
                            ] + [
                                {'timestamp': 250, 'closeTimestamp': 251, 'label_status': 'censored', 'rMultiple': 1},
                                {'timestamp': 250, 'closeTimestamp': 300, 'label_status': 'closed', 'rMultiple': 1},
                                {'timestamp': 199, 'closeTimestamp': 220, 'label_status': 'closed', 'rMultiple': 1},
                                {'timestamp': 250, 'closeTimestamp': 249, 'label_status': 'closed', 'rMultiple': 1}
                            ]}
                    return {}
                def close(self): calls.append(('close', {}))
            def collect(directory, ticker, config, manifest, rpc):
                self.assertEqual(manifest, MANIFEST)
                self.assertEqual(rpc('shutdown', {}), {})
                d = data(); d.pop('final_readiness')
                return dict(d, effective_config=effective, dataset_source=source)
            with patch.object(status, 'ROOT', root), patch.object(status, 'CACHE', root/'cache'), patch.object(trainer, 'MODELS_DIR', root/'models'), patch.object(trainer, 'WorkerRPC', RPC), patch.object(trainer, 'collect_temporal_trades', side_effect=collect):
                d, old, _, _ = status.collect('JP225', {'config': {'ticker': 'JP225'}})
            self.assertEqual(d['final_readiness']['accepted'], 30)
            self.assertEqual(d['final_readiness']['wins'], 15)
            serialized = json.dumps(d)
            self.assertNotIn('9999999', serialized)
            self.assertNotIn('test_trades', serialized)
            self.assertNotIn('final_readiness', status.training_data(d))
            self.assertIsNone(old)
            final_call = next(params for name, params in calls if name == 'evaluate_final')
            self.assertEqual(final_call['config']['mlGate'], {'enabled': False})


class CandidateComparisonTests(unittest.TestCase):
    def test_preserve_current_binds_identity_and_rejects_changes_and_old_protocol_result(self):
        binding = {'path': 'data/ml_calibration/candidates/JP225-1.json', 'sha256': 'a'*64}
        prior = {'candidate': binding, 'comparison': comparison(binding)}
        row = {}
        with patch.object(status, 'candidate_binding', return_value=(binding, None)):
            status.preserve_comparison(row, prior, 'JP225', {})
        self.assertEqual(row['comparison']['status'], 'valid')
        for issue in ('Current production config differs', 'Frozen candidate dataset changed'):
            with patch.object(status, 'candidate_binding', return_value=(binding, issue)):
                status.preserve_comparison(row, prior, 'JP225', {})
            self.assertEqual(row['comparison']['status'], 'unavailable')
        with patch.object(status, 'candidate_binding', return_value=(dict(binding, sha256='b'*64), None)):
            status.preserve_comparison(row, prior, 'JP225', {})
        self.assertIn('Immutable', row['comparison']['reason'])
        old = {'candidate': binding, 'comparison': dict(comparison(binding), schemaVersion=1)}
        with patch.object(status, 'candidate_binding', return_value=(binding, None)):
            status.preserve_comparison(row, old, 'JP225', {})
        self.assertEqual(row['comparison']['status'], 'unavailable')

    def test_refresh_retains_bound_comparison(self):
        binding = {'path': 'data/ml_calibration/candidates/JP225-1.json', 'sha256': 'a'*64}
        prior = {'assets': {'JP225': {'candidate': binding, 'comparison': comparison(binding)}}}
        saved = []
        with patch.object(status, 'snapshot', return_value={'assets': {'JP225': {'trade': True, 'config': {}}}}), patch.object(status, 'read_status', return_value=prior), patch.object(status, 'collect', return_value=({}, None, None, None)), patch.object(status, 'readiness', return_value={'ready': False}), patch.object(status, 'candidate_binding', return_value=(binding, None)), patch.object(status, 'save', side_effect=lambda value:saved.append(value)):
            status.refresh()
        self.assertEqual(saved[-1]['schemaVersion'], 2)
        self.assertEqual(saved[-1]['assets']['JP225']['comparison']['status'], 'valid')

    def test_comparison_errors_are_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'JP225-1.json'; path.write_text('{}')
            with patch.object(status, 'ROOT', Path(tmp)), patch.object(status, '_run_comparison', side_effect=RuntimeError('replay unavailable')):
                result = status.run_comparison('JP225', path, {})
        self.assertEqual(result['status'], 'error'); self.assertEqual(result['schemaVersion'], 2)
        self.assertEqual(result['scope'], 'temporal_threshold_holdout')

    def test_recalibrate_trains_once_on_AB_not_C_and_compares_after_immutable_save(self):
        saved = []; fits = []
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); state = {'assets': {'JP225': {}}}
            def fit(d, output, *args, **kwargs):
                fits.append(d)
                self.assertNotIn('final_readiness', d)
                self.assertEqual(kwargs['min_validation_samples'], 20)
                self.assertEqual(kwargs['threshold_calibration_protocol'], status.THRESHOLD_PROTOCOL)
                output.write_text(json.dumps({'meta': {'threshold_calibration_protocol': kwargs['threshold_calibration_protocol']}}))
                return {}
            def replay(ticker, path, config):
                self.assertTrue(path.is_file())
                self.assertEqual(saved[-1]['assets'][ticker]['job']['state'], 'CANDIDATE_SAVED')
                return {'schemaVersion': 2, 'status': 'valid', 'selectedThreshold': .5}
            with patch.object(status, 'ROOT', root), patch.object(status, 'CACHE', root/'data/ml_calibration'), patch.object(status, 'snapshot', return_value={'assets': {'JP225': {'trade': True, 'config': {}}}}), patch.object(status, 'read_status', return_value=state), patch.object(status, 'collect', return_value=(data(), None, root/'absent.json', None)), patch.object(status, 'readiness', return_value={'ready': True}), patch.object(status, 'preserve_comparison'), patch.object(status, 'run_comparison', side_effect=replay) as compare, patch.object(status, 'save', side_effect=lambda value:saved.append(json.loads(json.dumps(value)))), patch.object(trainer, 'train_candidate', side_effect=fit) as train:
                status.recalibrate('JP225')
            train.assert_called_once(); compare.assert_called_once()
            self.assertEqual(len(fits[0]['train']), 50); self.assertEqual(len(fits[0]['validation']), 20)
            self.assertFalse(saved[-1]['assets']['JP225']['job']['promoted'])

    def test_protocol_bootstrap_requires_explicit_confirmation_never_automatic_force(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); state = {'assets': {'JP225': {}}}
            with patch.object(status, 'snapshot', return_value={'assets': {'JP225': {'trade': True, 'config': {}}}}), patch.object(status, 'read_status', return_value=state), patch.object(status, 'collect', return_value=(data(), {}, root/'absent.json', None)), patch.object(status, 'readiness', return_value={'ready': True, 'bootstrapRequired': True, 'protocolBootstrapRequired': True}), patch.object(status, 'save'), patch.object(trainer, 'train_candidate') as train:
                status.recalibrate('JP225', bootstrap=False)
            train.assert_not_called()
            self.assertEqual(state['assets']['JP225']['job']['state'], 'HOLD')

    def test_existing_old_protocol_never_retrains_or_replays(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); path = root/'JP225-1.json'; path.write_text('{}')
            binding = {'path': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            state = {'assets': {'JP225': {'candidate': binding}}}
            with patch.object(status, 'ROOT', root), patch.object(status, 'snapshot', return_value={'assets': {'JP225': {'trade': True, 'config': {}}}}), patch.object(status, 'latest_candidate', return_value=path), patch.object(status, 'read_status', return_value=state), patch.object(status, 'candidate_binding', return_value=(binding, 'obsolete protocol')), patch.object(status, 'run_comparison') as replay, patch.object(status, 'save'), patch.object(trainer, 'train_candidate') as train:
                actual = status.compare_existing('JP225')
            self.assertEqual(actual['status'], 'unavailable')
            replay.assert_not_called(); train.assert_not_called()


class ImmutableProtocolTests(unittest.TestCase):
    def test_protocol_written_on_initial_exclusive_save_without_final_rows(self):
        d = status.training_data(data())
        d['max_label_closed_at_ms'] = {'train': 60, 'validation': 130}; d['embargo_ms'] = 0
        for name in ('train', 'validation'):
            for row in d[name]:
                for feature in trainer.FEATURE_NAMES: row[feature] = float(row['label'])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'candidate.json'
            protocol = json.loads(json.dumps(status.THRESHOLD_PROTOCOL))
            out = trainer.train_candidate(d, path, 'JP225', None, {'ticker': 'JP225'}, n_estimators=1,
                                          force=True, threshold_calibration_protocol=protocol)
            before = path.read_bytes()
            self.assertEqual(json.loads(before)['meta']['threshold_calibration_protocol'], status.THRESHOLD_PROTOCOL)
            self.assertFalse(out['meta']['test_evaluated'])
            self.assertEqual(out['meta']['test_samples'], 0)
            protocol['thresholds'][0] = .1
            self.assertEqual(json.loads(path.read_bytes())['meta']['threshold_calibration_protocol']['thresholds'][0], .5)
            with self.assertRaises(trainer.ProtocolError):
                trainer.train_candidate(d, path, 'JP225', None, {}, n_estimators=1, force=True)
            self.assertEqual(path.read_bytes(), before)
            old = json.loads(before); old['meta']['threshold'] = .5
            migrated = trainer.train_candidate(d, Path(tmp)/'migrated.json', 'JP225', old, {'ticker': 'JP225'},
                n_estimators=1, force=True, threshold_calibration_protocol=status.THRESHOLD_PROTOCOL)
            self.assertEqual(migrated['meta']['threshold'], .65)
            self.assertEqual(migrated['meta']['threshold_source'], 'protocol_default_before_B_selection')


if __name__ == '__main__':
    unittest.main()
