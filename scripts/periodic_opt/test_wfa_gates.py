"""Stdlib-only offline bootstrap and shadow gate regression fixtures."""
import copy
import unittest
from importlib import import_module


def core():
    return import_module('scripts.periodic_opt.wfa_gates')


class BootstrapTracer(unittest.TestCase):
    def test_stationary_and_paired_reproducible_calendar_sampling(self):
        w = core()
        r = [-1., 2., 3., -0.5] * 10
        result = w.stationary_bootstrap(r, iterations=200, seed=8)
        self.assertEqual(result, w.stationary_bootstrap(r, iterations=200, seed=8))
        self.assertFalse(result['skip'])
        self.assertEqual(result['method'], 'stationary')
        self.assertEqual(result['n'], 40)
        self.assertGreaterEqual(result['survival'], 0)
        self.assertLessEqual(result['survival'], 1)
        self.assertGreaterEqual(result['dd_p95'], 0)
        self.assertIn('final', result['survival_definition'])
        self.assertEqual(w.stationary_bootstrap([1.] * 10, iterations=20)['survival'], 1)
        loss = w.stationary_bootstrap([-1.] * 10, iterations=20, ruin_r=5)
        self.assertEqual(loss['survival'], 0)
        self.assertEqual(loss['ruin_probability'], 1)
        paired = w.paired_calendar_bootstrap([x + 0.5 for x in r], r, iterations=100)
        self.assertEqual(paired['scope'], 'paired_calendar')
        self.assertEqual(paired['delta_mean_ci95'], [0.5, 0.5])
        self.assertEqual(paired['prob_delta_positive'], 1)
        self.assertEqual(w.paired_calendar_bootstrap(r, r, iterations=100)['delta_mean_ci95'], [0, 0])
        for data in ([], [1.] * 9):
            self.assertTrue(w.stationary_bootstrap(data)['skip'])
            self.assertIsNone(w.stationary_bootstrap(data)['survival'])
            self.assertTrue(w.paired_calendar_bootstrap(data, data)['skip'])
        for bad in ([True] * 10, [float('inf')] * 10, [float('nan')] * 10, ['1'] * 10):
            with self.assertRaises(ValueError):
                w.stationary_bootstrap(bad)
        for kwargs in ({'iterations': 0}, {'iterations': True}, {'mean_block_size': 0.5},
                       {'seed': True}, {'ruin_r': 0}):
            with self.assertRaises(ValueError):
                w.stationary_bootstrap(r, **kwargs)
        with self.assertRaises(ValueError):
            w.paired_calendar_bootstrap(r, r[:-1])


class GatesTracer(unittest.TestCase):
    def fixture(self):
        def metric(n=30, exp=.2, dd=1., pnl=6.):
            return dict(trade_count=n, expectancy=exp, max_drawdown_r=dd, net_pnl_r=pnl)
        return [metric(exp=.1), metric(), metric(exp=.1, pnl=3.),
                [metric(), metric(), metric(), metric(exp=-.05, pnl=-1.5)],
                dict(skip=False, dsr=.95, trials=10, trials_sr_std=.2,
                     calibration_status='provided',
                     calibration_context={'valid': True, 'scope': 'complete_selection'}),
                dict(skip=False, survival=.9), dict(skip=False, survival=.89)]

    def evaluate(self, args=None, **kwargs):
        return core().evaluate_wfa_gates(*(self.fixture() if args is None else args), **kwargs)

    def test_recommendation_is_shadow_only_no_wfe_upper_cap(self):
        result = self.evaluate()
        self.assertEqual(result['status'], 'RECOMMEND_SHADOW')  # WFE = 2, allowed
        self.assertFalse(result['changes_production'])
        self.assertFalse(result['apply_eligible'])
        self.assertEqual(result['gates']['paired_evidence'], None)
        self.assertIn('not_validated', result['diagnostics']['threshold_status'])
        import json
        json.dumps(core().GATE_POLICY, allow_nan=False)
        self.assertTrue(core().GATE_POLICY['version'])

    def test_zero_dd_valid_max_fold_dd_not_stitched_and_survival_not_tolerant(self):
        args = self.fixture()
        args[1]['max_drawdown_r'] = args[2]['max_drawdown_r'] = 0
        self.assertEqual(self.evaluate(args)['status'], 'RECOMMEND_SHADOW')
        args[3][0]['max_drawdown_r'] = 4.01
        self.assertFalse(self.evaluate(args)['gates']['fold_drawdown'])
        args = self.fixture()
        args[5]['survival'], args[6]['survival'] = .88, .89
        self.assertFalse(self.evaluate(args)['gates']['mc_survival'])

    def test_retention_uses_net_pnl_not_expectancy_and_one_loss_never_quarantines(self):
        args = self.fixture()
        args[1].update(expectancy=.11, net_pnl_r=2.3, max_drawdown_r=.5)
        args[2].update(expectancy=.1, net_pnl_r=10, max_drawdown_r=1)
        self.assertFalse(self.evaluate(args)['gates']['superiority'])
        args[1]['net_pnl_r'] = 9
        self.assertTrue(self.evaluate(args)['gates']['superiority'])
        args[1]['trade_count'] = 1
        result = self.evaluate(args)
        self.assertEqual(result['status'], 'HOLD_INSUFFICIENT_DATA')
        self.assertNotIn('QUARANTINE', str(result))

    def test_invalid_and_small_samples_cannot_recommend(self):
        for index, field, value in ((1, 'expectancy', float('inf')),
                                    (2, 'net_pnl_r', float('nan')),
                                    (1, 'max_drawdown_r', -1),
                                    (1, 'trade_count', 0), (1, 'trade_count', True)):
            args = self.fixture()
            args[index][field] = value
            self.assertEqual(self.evaluate(args)['status'], 'HOLD_INVALID_DATA')
        for index in (1, 2):
            args = self.fixture()
            args[index]['trade_count'] = 24
            self.assertEqual(self.evaluate(args)['status'], 'HOLD_INSUFFICIENT_DATA')
        args = self.fixture()
        del args[1]['expectancy']
        self.assertEqual(self.evaluate(args)['status'], 'HOLD_INVALID_DATA')
        args = self.fixture()
        args[1]['exp'] = .8  # Conflicting aliases may not silently select a field.
        self.assertEqual(self.evaluate(args)['status'], 'HOLD_INVALID_DATA')
        args = self.fixture()
        args[3] = args[3][:1]
        self.assertEqual(self.evaluate(args)['status'], 'HOLD_INSUFFICIENT_DATA')

    def test_valid_zero_observations_are_insufficient_not_corrupt_or_risk_evidence(self):
        empty=dict(trade_count=0,expectancy=0.,net_pnl_r=0.,max_drawdown_r=0.)
        for index in (0,1,2):
            args=self.fixture();args[index]=empty.copy()
            result=self.evaluate(args)
            self.assertEqual(result['status'],'HOLD_INSUFFICIENT_DATA')
            self.assertEqual(result['diagnostics']['errors'],[])
            self.assertFalse(result['gates']['sample_size'])
            self.assertFalse(result['apply_eligible'])
        args=self.fixture();args[3][0]=empty.copy()
        result=self.evaluate(args)
        self.assertEqual(result['status'],'HOLD_INSUFFICIENT_DATA')
        self.assertEqual(result['diagnostics']['errors'],[])
        self.assertIsNone(result['gates']['fold_consistency'])
        self.assertIsNone(result['gates']['fold_drawdown'])
        self.assertIn('fold_consistency',result['diagnostics']['unknown'])
        self.assertFalse(result['apply_eligible'])
        self.assertTrue(result['gates']['fold_coverage'])
        self.assertEqual(result['diagnostics']['empty_fold_indices'], [0])
        self.assertIsNone(result['diagnostics']['positive_fold_fraction'])
        self.assertIsNone(result['diagnostics']['max_fold_drawdown_r'])
        self.assertFalse(result['changes_production'])
        empty = core().summarize_series([], 0, 10)
        for folds in ([empty, empty], [args[3][1], empty], []):
            with self.subTest(folds=folds):
                args = self.fixture()
                args[3] = folds
                result = self.evaluate(args)
                self.assertEqual(result['status'], 'HOLD_INSUFFICIENT_DATA')
                self.assertEqual(result['diagnostics']['errors'], [])
                self.assertEqual(result['gates']['fold_coverage'], len(folds) >= 2)
                self.assertEqual(result['diagnostics']['empty_fold_indices'],
                                 [i for i, fold in enumerate(folds) if fold['trade_count'] == 0])
                for key in ('fold_consistency', 'fold_drawdown'):
                    self.assertIsNone(result['gates'][key])
                    self.assertIn(key, result['diagnostics']['unknown'])
                self.assertFalse(result['apply_eligible'])
                self.assertFalse(result['changes_production'])

    def test_zero_observations_reject_contradictions_and_invalid_aliases(self):
        empty = core().summarize_series([], 0, 10)
        variants = []
        for field in ('expectancy', 'net_pnl_r', 'max_drawdown_r'):
            for value in (-1, 1, True, float('nan'), float('inf'), '0'):
                variants.append(dict(empty, **{field: value}))
        for value in (-1, True, False, 0., float('nan'), float('inf'), '0', None):
            variants.append(dict(empty, trade_count=value))
        for field, values in (('n', (0., False, -1, 1, float('inf'))),
                              ('exp', (.2, False, float('nan'))),
                              ('dd', (1, False, float('inf'))),
                              ('netPnl', (6, False, float('nan')))):
            for value in values:
                variants.append(dict(empty, **{field: value}))
        for metrics in variants:
            for index in (0, 1, 2, 3):
                with self.subTest(metrics=metrics, index=index):
                    args = self.fixture()
                    if index == 3:
                        args[3][0] = metrics
                    else:
                        args[index] = metrics
                    result = self.evaluate(args)
                    self.assertEqual(result['status'], 'HOLD_INVALID_DATA')
                    self.assertTrue(result['diagnostics']['errors'])
                    self.assertFalse(result['apply_eligible'])
                    self.assertFalse(result['changes_production'])
        args = self.fixture()
        args[1] = dict(empty, n=0, exp=0, dd=0, netPnl=0)
        self.assertEqual(self.evaluate(args)['status'], 'HOLD_INSUFFICIENT_DATA')

    def test_dsr_uncalibrated_unknown_not_zero_or_enforced(self):
        for dsr in ({}, {'skip': True, 'dsr': None},
                    {'skip': False, 'dsr': .99, 'calibration_status': 'missing'},
                    dict(skip=False, dsr=.99, trials=10, trials_sr_std=.2,
                         calibration_status='provided')):
            args = self.fixture()
            args[4] = dsr
            result = self.evaluate(args)
            self.assertIsNone(result['gates']['dsr'])
            self.assertNotIn('dsr', result['failed'])
            self.assertEqual(result['status'], 'HOLD_INSUFFICIENT_DATA')
        args = self.fixture()
        args[4]['dsr'] = .89
        self.assertEqual(self.evaluate(args)['status'], 'HOLD')
        args[4]['dsr'] = float('inf')
        self.assertEqual(self.evaluate(args)['status'], 'HOLD_INVALID_DATA')
        args = self.fixture()
        args[5] = {'skip': True}
        self.assertEqual(self.evaluate(args)['status'], 'HOLD_INSUFFICIENT_DATA')

    def test_paired_diagnostic_cannot_smuggle_nonfinite_values_through_skip(self):
        result = self.evaluate(paired_result={'scope': 'paired_calendar', 'skip': True,
                              'delta_mean_ci95': [0, float('inf')], 'prob_delta_positive': None})
        self.assertEqual(result['status'], 'HOLD_INVALID_DATA')
        paired = core().paired_calendar_bootstrap([1.] * 20, [0.] * 20, iterations=20)
        result = self.evaluate(paired_result=paired)
        self.assertEqual(result['status'], 'RECOMMEND_SHADOW')
        self.assertTrue(result['gates']['paired_evidence'])

    def test_summarize_uses_canonical_closure_order_and_half_open_windows(self):
        from scripts.hyperopt.metrics import compute_metrics, to_dict
        rows = [dict(timestamp=2, closeTimestamp=5, rMultiple=-1),
                dict(timestamp=0, closeTimestamp=3, rMultiple=2)]
        summary = core().summarize_series(rows, 0, 10)
        expected = to_dict(compute_metrics(rows, time_bounds=(0, 10)))
        for key, value in expected.items():
            self.assertEqual(summary[key], value)
        self.assertEqual(summary['max_drawdown_r'], 1)
        for bad in ([dict(timestamp=0, closeTimestamp=10, rMultiple=1)],
                    [dict(timestamp=-1, closeTimestamp=3, rMultiple=1)],
                    [dict(timestamp=0, closeTimestamp=3, rMultiple=float('inf'))]):
            with self.assertRaises(ValueError):
                core().summarize_series(bad, 0, 10)


if __name__ == '__main__':
    unittest.main()
