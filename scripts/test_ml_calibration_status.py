#!/usr/bin/env python3
import ast
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
import ml_calibration_status as status


def data(n=50, classes=True):
    rows = [{'label': i % 2 if classes else 1, 'ts': i+10, 'closedAt': i+11} for i in range(n)]
    return {'train': rows, 'validation': rows, 'manifest': {}, 'counts': {}}


class ReadinessTests(unittest.TestCase):
    def test_missing_train_and_validation_counts(self):
        out = status.readiness(data(6), None)
        self.assertFalse(out['ready'])
        self.assertEqual(out['train']['missing'], 44)
        self.assertEqual(out['validation']['missing'], 14)
        self.assertEqual(out['train']['required'], 50)
        self.assertEqual(out['validation']['accepted'], 6)

    def test_both_classes_required_even_at_twenty(self):
        out = status.readiness(data(50, False), None)
        self.assertFalse(out['ready'])
        self.assertEqual(out['train']['missing'], 0)
        self.assertFalse(out['train']['bothClasses'])

    def test_unknown_provenance_requires_explicit_bootstrap(self):
        with patch('train_ml_model.guard_freshness', side_effect=__import__('train_ml_model').InsufficientSamples('HOLD_FRESHNESS_UNKNOWN: old label/training range unknown')):
            out = status.readiness(data(), {})
        self.assertTrue(out['ready'])
        self.assertTrue(out['bootstrapRequired'])
        self.assertEqual(out['state'], 'BOOTSTRAP_REQUIRED')

    def test_known_insufficient_freshness_cannot_bootstrap(self):
        with patch('train_ml_model.guard_freshness', side_effect=__import__('train_ml_model').InsufficientSamples('HOLD_FRESHNESS: 0 new closed trades < 15')):
            out = status.readiness(data(), {})
        self.assertFalse(out['ready'])
        self.assertNotIn('bootstrapRequired', out)

    def test_known_ready(self):
        with patch('train_ml_model.guard_freshness', return_value={}):
            out = status.readiness(data(), {})
        self.assertTrue(out['ready'])
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
        check = env['_ml_origin']
        class Request:
            def __init__(self, headers): self.headers=headers
        for headers in ({}, {'origin':'https://evil.example'}, {'origin':'http://localhost:5173.evil'}):
            with self.assertRaises(HTTPException): check(Request(headers))
        with self.assertRaises(HTTPException): check(Request({'origin':'http://localhost:5173'}), True)
        check(Request({'origin':'http://localhost:5173','x-jarvis-ml':'recalibrate'}), True)


class CandidateComparisonTests(unittest.TestCase):
    def test_preserve_comparison_binds_path_hash_and_rejects_changed_config_dataset(self):
        binding = {'path': 'data/ml_calibration/candidates/JP225-1.json', 'sha256': 'a'*64}
        comparison = {'status': 'valid', 'candidate': binding['path'], 'candidateSha256': binding['sha256'], 'deltaR': -2.3}
        prior = {'candidate': binding, 'comparison': comparison}
        row = {}
        with patch.object(status, 'candidate_binding', return_value=(binding, None)):
            status.preserve_comparison(row, prior, 'JP225', {})
        self.assertEqual(row['comparison']['status'], 'valid')
        self.assertEqual(row['currentCandidateSha256'], 'a'*64)
        for issue in ('Current production config differs', 'Frozen candidate dataset changed'):
            with patch.object(status, 'candidate_binding', return_value=(binding, issue)):
                status.preserve_comparison(row, prior, 'JP225', {})
            self.assertEqual(row['comparison']['status'], 'unavailable')
            self.assertEqual(row['comparison']['reason'], issue)
        changed = dict(binding, sha256='b'*64)
        with patch.object(status, 'candidate_binding', return_value=(changed, None)):
            status.preserve_comparison(row, prior, 'JP225', {})
        self.assertEqual(row['comparison']['status'], 'unavailable')
        self.assertIn('Immutable', row['comparison']['reason'])
        self.assertEqual(row['candidate']['sha256'], 'a'*64)

    def test_refresh_retains_bound_comparison(self):
        binding = {'path': 'data/ml_calibration/candidates/JP225-1.json', 'sha256': 'a'*64}
        comparison = {'status': 'valid', 'candidate': binding['path'], 'candidateSha256': binding['sha256']}
        prior = {'assets': {'JP225': {'candidate': binding, 'comparison': comparison}}}
        saved = []
        with patch.object(status, 'snapshot', return_value={'assets': {'JP225': {'trade': True, 'config': {}}}}), patch.object(status, 'read_status', return_value=prior), patch.object(status, 'collect', return_value=({}, None, None, None)), patch.object(status, 'readiness', return_value={'ready': False}), patch.object(status, 'candidate_binding', return_value=(binding, None)), patch.object(status, 'save', side_effect=lambda value:saved.append(value)):
            status.refresh()
        self.assertEqual(saved[-1]['assets']['JP225']['comparison']['status'], 'valid')

    def test_comparison_errors_are_explicit_not_success_or_permanent_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'JP225-1.json'
            path.write_text('{}')
            with patch.object(status, 'ROOT', Path(tmp)), patch.object(status, '_run_comparison', side_effect=RuntimeError('replay unavailable')):
                result = status.run_comparison('JP225', path, {})
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['reason'], 'replay unavailable')
        self.assertEqual(result['recommendation'], 'INSUFFICIENT_EVIDENCE')

    def test_recalibrate_compares_only_after_candidate_is_saved(self):
        import json
        saved = []
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = {'assets': {'JP225': {}}}
            def train(data, output, *args, **kwargs):
                output.write_text('{}')
                return {}
            def replay(ticker, path, config):
                self.assertTrue(path.is_file())
                self.assertEqual(saved[-1]['assets'][ticker]['job']['state'], 'CANDIDATE_SAVED')
                return {'status': 'valid', 'deltaR': -1}
            with patch.object(status, 'ROOT', root), patch.object(status, 'CACHE', root/'data/ml_calibration'), patch.object(status, 'snapshot', return_value={'assets': {'JP225': {'trade': True, 'config': {}}}}), patch.object(status, 'read_status', return_value=state), patch.object(status, 'collect', return_value=({}, None, root/'absent.json', None)), patch.object(status, 'readiness', return_value={'ready': True}), patch.object(status, 'preserve_comparison'), patch.object(status, 'run_comparison', side_effect=replay) as compare, patch.object(status, 'save', side_effect=lambda value:saved.append(json.loads(json.dumps(value)))), patch('train_ml_model.train_candidate', side_effect=train):
                status.recalibrate('JP225')
            compare.assert_called_once()
            self.assertEqual(saved[-1]['assets']['JP225']['comparison']['deltaR'], -1)
            self.assertFalse(saved[-1]['assets']['JP225']['job']['promoted'])

    def test_existing_candidate_compare_never_retrains(self):
        import json, hashlib
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root/'JP225-1.json'; path.write_text('{}')
            binding = {'path': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            state = {'assets': {'JP225': {'candidate': binding}}}
            result = {'status': 'valid', 'candidate': path.name, 'candidateSha256': binding['sha256'], 'deltaR': -1}
            with patch.object(status, 'ROOT', root), patch.object(status, 'snapshot', return_value={'assets': {'JP225': {'trade': True, 'config': {}}}}), patch.object(status, 'latest_candidate', return_value=path), patch.object(status, 'read_status', return_value=state), patch.object(status, 'candidate_binding', return_value=(binding, None)), patch.object(status, 'run_comparison', return_value=result) as replay, patch.object(status, 'save'), patch('train_ml_model.train_candidate') as train:
                actual = status.compare_existing('JP225')
            self.assertEqual(actual['deltaR'], -1)
            replay.assert_called_once(); train.assert_not_called()


if __name__=='__main__':
    unittest.main()
