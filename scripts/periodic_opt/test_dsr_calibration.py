"""Calibration regressions (stdlib production; SciPy is test-only)."""
import json
import math
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/hyperopt'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import metrics as core
import dsr


class Calibration(unittest.TestCase):
    returns = [1, -0.3, 0.2, 0.8, -0.6] * 8

    def test_pearson_matches_scipy_not_clamped_excess(self):
        import numpy as np
        from scipy.stats import kurtosis, skew
        x = np.random.default_rng(42).normal(size=1000).tolist()
        mean, sd, sk, ku = dsr._moments(x)
        self.assertAlmostEqual(ku, kurtosis(x, fisher=False, bias=False), places=12)
        self.assertAlmostEqual(sk, skew(x, bias=False), places=12)
        self.assertAlmostEqual(ku, 3.091884, places=6)
        self.assertEqual(dsr._moments([1, 2, 3])[3], 3)

    def test_multitrial_missing_sigma_is_unavailable(self):
        d = dsr.deflated_sharpe(self.returns, 200)
        self.assertTrue(d.get('skip'))
        self.assertEqual(d['calibration_status'], 'missing')
        self.assertIsNone(d['dsr'])
        self.assertEqual(set(['n', 'trials', 'sr', 'selection_bar', 'dsr', 'verdict']) - d.keys(), set())

    def test_sigma_scales_expected_max_and_n1_is_psr(self):
        a = dsr.deflated_sharpe(self.returns, 200, trials_sr_std=0.05)
        b = dsr.deflated_sharpe(self.returns, 200, trials_sr_std=0.2)
        self.assertFalse(a['skip'])
        self.assertAlmostEqual(a['selection_bar'], 0.05 * dsr.expected_max_sr(200), places=4)
        self.assertGreater(a['dsr'], b['dsr'])
        zero = dsr.deflated_sharpe(self.returns, 200, trials_sr_std=0)
        single = dsr.deflated_sharpe(self.returns, 1)
        self.assertEqual(single['method'], 'PSR')
        self.assertEqual(single['selection_bar'], 0)
        self.assertEqual(single['dsr'], zero['dsr'])
        fixed = dsr.deflated_sharpe(self.returns, 200, sr_benchmark_override=0.1)
        self.assertFalse(fixed['skip'])
        self.assertEqual(fixed['selection_bar'], 0.1)
        self.assertEqual(fixed['calibration_status'], 'benchmark_override')

    def test_nonestimable_never_invents_probability(self):
        for x in [[1] * 40, [1], []]:
            d = dsr.deflated_sharpe(x, 1)
            self.assertTrue(d['skip'])
            self.assertIsNone(d['dsr'])
            json.dumps(d, allow_nan=False)
        invalid_variance = dsr.deflated_sharpe([99, 101] * 5, 1, use_empirical_moments=True)
        self.assertTrue(invalid_variance['skip'])
        self.assertEqual(invalid_variance['status'], 'invalid_variance_term')
        for x in [[math.nan] * 40, [math.inf] * 40, [True] * 40]:
            with self.assertRaises(ValueError):
                dsr.deflated_sharpe(x, 1)
        for sigma in [-1, math.nan, math.inf, True]:
            with self.assertRaises(ValueError):
                dsr.deflated_sharpe(self.returns, 200, trials_sr_std=sigma)
        for trials in [0, -1, True, 1.5]:
            with self.assertRaises(ValueError):
                dsr.deflated_sharpe(self.returns, trials)

    def test_cli_auto_moments_and_stdlib_import(self):
        for size, normal, expected in [(10, False, 'normal'), (40, False, 'empirical'), (40, True, 'normal')]:
            args = ['/usr/bin/python3', str(Path(dsr.__file__)), '--returns', ','.join(map(str, self.returns[:size])),
                    '--trials', '20', '--trials-sr-std', '0.05']
            if normal:
                args.append('--normal')
            result = subprocess.run(args, check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(result.stdout)['moments_used'], expected)
        result = subprocess.run(['/usr/bin/python3', '-S', '-c',
                                 "import sys;sys.path.insert(0,'scripts/hyperopt');import metrics;print(metrics.OBJECTIVE_VERSION)"],
                                cwd=ROOT, check=True, capture_output=True, text=True)
        self.assertEqual(result.stdout.strip(), 'legacy_v1')

    def test_single_source_and_shadow_common_calibration(self):
        self.assertIs(dsr.deflated_sharpe, core.deflated_sharpe)
        self.assertIs(dsr._moments, core._moments)
        values = self.returns
        m = core.compute_metrics([{'rMultiple': r, 'timestamp': 0, 'closeTs': 5 + i * 10}
                                  for i, r in enumerate(values)], time_bounds=(0, 400))
        a = core.shadow_objective(m, n_trials_reference=200, trials_sr_std=0.05)
        b = core.shadow_objective(m, n_trials_reference=200, trials_sr_std=0.05)
        self.assertEqual(a, b)
        self.assertTrue(a['eligible'])
        self.assertEqual(a['calibration']['status'], 'available')
        self.assertEqual(a['calibration']['dsr'], dsr.deflated_sharpe(values, 200, trials_sr_std=0.05)['dsr'])
        missing = core.shadow_objective(m, n_trials_reference=200)
        self.assertEqual(missing['components']['dsr']['contribution'], 0)
        self.assertEqual(missing['calibration']['status'], 'unavailable')
        json.dumps(a, allow_nan=False)


if __name__ == '__main__':
    unittest.main()
