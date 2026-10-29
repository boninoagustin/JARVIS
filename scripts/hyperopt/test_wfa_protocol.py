"""Offline contract tests for retrospective rolling shadow plans."""
import copy
import hashlib
import json
import unittest
from importlib import import_module

DAY = 86_400_000


class PlanTracer(unittest.TestCase):
    def test_rolling_plan_is_deterministic_and_vault_stays_blocked(self):
        w = import_module('scripts.hyperopt.wfa_protocol')
        plan = w.build_wfa_plan('EURUSD', 0, 100 * DAY + 1)
        self.assertEqual(plan['version'], 2)
        self.assertEqual(plan['kind'], 'rolling_wfa_shadow')
        self.assertEqual(plan['clock'], 'M5')
        self.assertFalse(plan['apply_eligible'])
        self.assertEqual(plan['vault'], dict(from_ms=93 * DAY + 1, to_ms=100 * DAY + 1,
                                            independence='unverified', access='blocked'))
        self.assertEqual(len(plan['folds']), 3)
        self.assertEqual([f['id'] for f in plan['folds']], [1, 2, 3])
        self.assertEqual(plan, w.validate_wfa_plan(plan))
        self.assertEqual(plan, w.build_wfa_plan('EURUSD', 0, 100 * DAY + 1))
        encoded = json.dumps({k: v for k, v in plan.items() if k != 'fingerprint'},
                             sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        self.assertEqual(plan['fingerprint'], hashlib.sha256(encoded.encode()).hexdigest())
        for f in plan['folds']:
            self.assertLess(f['is_start_ms'], f['inner_train_end_ms'])
            self.assertLess(f['inner_train_end_ms'], f['inner_validation_start_ms'])
            self.assertLess(f['inner_validation_start_ms'], f['is_end_ms'])
            self.assertEqual(f['fit_asof_ms'], f['is_end_ms'])
            self.assertEqual(f['oos_start_ms'] - f['is_end_ms'], 8 * 3_600_000)
            self.assertLessEqual(f['oos_end_ms'], plan['vault']['from_ms'])
            for role, bounds in {
                'inner_train': (f['is_start_ms'], f['inner_train_end_ms']),
                'inner_validation': (f['inner_validation_start_ms'], f['is_end_ms']),
                'is': (f['is_start_ms'], f['is_end_ms']),
                'outer_oos': (f['oos_start_ms'], f['oos_end_ms']),
            }.items():
                w.assert_window_access(plan, *bounds, role=role, fold_id=f['id'])
                with self.assertRaises(ValueError):
                    w.assert_window_access(plan, bounds[0] + 1, bounds[1], role=role, fold_id=f['id'])
        self.assertEqual(w.resolve_fold(plan, 1), plan['folds'][0])
        with self.assertRaises(ValueError):
            w.assert_window_access(plan, 93 * DAY + 1, 100 * DAY + 1, role='outer_oos', fold_id=3)


class PlanSafety(unittest.TestCase):
    def test_policy_normalizes_integral_floats_and_resolves_only_integer_milliseconds(self):
        w = import_module('scripts.hyperopt.wfa_protocol')
        base = w.build_wfa_plan('X', 0, 100 * DAY)
        same = w.build_wfa_plan('X', 0, 100 * DAY, policy={'is_days': 21.0,
            'min_context_observations': {k: 60.0 for k in ('5', '15', '60', '240', 'D')}})
        self.assertEqual(base, same)
        fractional = w.build_wfa_plan('X', 0, 100 * DAY, policy={'gap_hours': 8.5})
        self.assertEqual(fractional, w.validate_wfa_plan(fractional))
        self.assertIs(type(fractional['folds'][0]['is_end_ms']), int)
        with self.assertRaises(ValueError):
            w.build_wfa_plan('X', 0, 100 * DAY, policy={'gap_hours': .00000000001})

    def test_recomputed_fingerprint_does_not_authorize_unknown_or_modified_windows(self):
        w = import_module('scripts.hyperopt.wfa_protocol')
        plan = w.build_wfa_plan('EURUSD', 0, 100 * DAY)
        variants = []
        for path, value in ((('version',), True), (('extra',), 'bypass'),
                            (('vault', 'access'), 'open'),
                            (('coverage', 'htf_end_ms'), 999),
                            (('folds', 0, 'oos_end_ms'), 1),
                            (('folds', 0, 'id'), True),
                            (('folds', 0, 'extra'), 'bypass')):
            changed = copy.deepcopy(plan)
            node = changed
            for key in path[:-1]:
                node = node[key]
            node[path[-1]] = value
            variants.append(changed)
        changed = copy.deepcopy(plan)
        changed['folds'] = tuple(changed['folds'])
        variants.append(changed)
        changed = copy.deepcopy(plan)
        changed['folds'].append(copy.deepcopy(changed['folds'][0]))
        variants.append(changed)
        for changed in variants:
            changed['fingerprint'] = hashlib.sha256(json.dumps(
                {k: v for k, v in changed.items() if k != 'fingerprint'},
                sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                w.validate_wfa_plan(changed)

    def test_short_history_never_moves_vault_and_policy_rejects_invalid_override(self):
        w = import_module('scripts.hyperopt.wfa_protocol')
        one = w.build_wfa_plan('X', 0, 40 * DAY)
        self.assertEqual(len(one['folds']), 1)
        self.assertEqual(one['vault']['from_ms'], 33 * DAY)
        with self.assertRaisesRegex(ValueError, 'insufficient'):
            w.build_wfa_plan('X', 0, 35 * DAY)
        for start, end in ((True, 100 * DAY), (-1, 100 * DAY),
                           (0, 2**53), (0., 100 * DAY), (1, 1)):
            with self.assertRaises(ValueError):
                w.build_wfa_plan('X', start, end)
        for override in ({'step_days': 6}, {'is_days': 7}, {'embargo_hours': True},
                         {'unknown': 1}, {'min_context_observations': {'D': 60}}):
            with self.assertRaises(ValueError):
                w.build_wfa_plan('X', 0, 100 * DAY, policy=override)
        plan = w.build_wfa_plan('X', 0, 100 * DAY, policy={'step_days': 14})
        for left, right in zip(plan['folds'], plan['folds'][1:]):
            self.assertLessEqual(left['oos_end_ms'], right['oos_start_ms'])
        final = w.resolve_fold(plan, 0)
        self.assertEqual(final['oos_start_ms'], plan['vault']['from_ms'])
        self.assertEqual(final['is_end_ms'], plan['vault']['from_ms'] - 8 * 3_600_000)
        w.assert_window_access(plan, final['is_start_ms'], final['is_end_ms'], role='is', fold_id=0)
        with self.assertRaisesRegex(ValueError, 'Vault'):
            w.assert_window_access(plan, final['oos_start_ms'], final['oos_end_ms'], role='outer_oos', fold_id=0)
        for fold_id in (True, 99):
            with self.assertRaises(ValueError):
                w.resolve_fold(plan, fold_id)
        resolved = w.resolve_fold(plan, 1)
        resolved['id'] = 999
        self.assertEqual(plan['folds'][0]['id'], 1)


if __name__ == '__main__':
    unittest.main()
