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


if __name__=='__main__':
    unittest.main()
