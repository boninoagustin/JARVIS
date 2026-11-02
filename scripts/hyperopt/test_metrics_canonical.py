"""Canonical metrics contracts; run with unittest or pytest (no market/RPC)."""
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import metrics as core


class LegacyParity(unittest.TestCase):
    def test_actual_typescript_functions_in_vm(self):
        # AST extraction executes only the two pure worker functions, never imports services.
        source = r'''
const fs=require('fs'),ts=require('typescript'),vm=require('vm');
const p='scripts/hyperopt/jarvis_hyperopt_worker.ts';
const ast=ts.createSourceFile(p,fs.readFileSync(p,'utf8'),ts.ScriptTarget.Latest,true);
const names=new Set(['computeMetrics','objectiveFunction']);
const code=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.has(n.name?.text)).map(n=>n.getText(ast)).join('\n');
if(code.length===0)throw Error('worker pure functions not found');
const ctx={};vm.createContext(ctx);vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
let text=fs.readFileSync(0,'utf8');
const out=JSON.parse(text).map(trades=>{const m=ctx.computeMetrics(trades);return {m,score:ctx.objectiveFunction(m)}});
process.stdout.write(JSON.stringify(out));
'''
        cases = [[], [1], [1] * 29, [1] * 30, [0] * 40,
                 [2, 0, -1, -1, 0, 3] * 8, [2, -0.01] * 20]
        trades = [[{'rMultiple': r} for r in values] for values in cases]
        result = subprocess.run(['node', '-e', source], input=json.dumps(trades),
                                capture_output=True, text=True,
                                cwd=Path(__file__).resolve().parents[2], check=True)
        for records, expected in zip(trades, json.loads(result.stdout)):
            m = core.compute_metrics(records)
            self.assertAlmostEqual(core.objective_function(m), expected['score'], places=12)
            for key, value in expected['m'].items():
                self.assertAlmostEqual(getattr(m, key), value, places=12, msg=key)

    def test_objective_matches_worker_coefficients(self):
        m = core.compute_metrics([{'rMultiple': r} for r in [2, -1, 0, 3, -0.5] * 10])
        expected = (0.5 * min(m.profit_factor, 5) * min(1, m.gross_loss_r / 5)
                    - 0.5 * m.max_drawdown_r - 0.25 * abs(m.trade_count - 200) / 200
                    + m.expectancy)
        self.assertEqual(core.objective_function(m), expected)
        for n in [0, 1, 29]:
            small = core.compute_metrics([{'rMultiple': 1}] * n)
            self.assertEqual(core.objective_function(small), -100 if n == 0 else -10 * (1 - n / 30))


class CanonicalRisk(unittest.TestCase):
    def trades(self, values, closes=None):
        closes = closes or [5 + i * 10 for i in range(len(values))]
        return [{'rMultiple': r, 'timestamp': 0, 'closeTs': t} for r, t in zip(values, closes)]

    def test_canonical_temporal_shadow_contract(self):
        # Close, not entry, determines realised equity. Break-even preserves streaks.
        trades = [dict(rMultiple=-2, timestamp=0, closeTs=30),
                  dict(rMultiple=3, timestamp=10, closeTimestamp=20),
                  dict(rMultiple=0, timestamp=0, closedAt=25)]
        m = core.compute_metrics(trades, time_bounds=(0, 100))
        self.assertEqual(m.max_drawdown_r, 2)
        self.assertEqual(m.block_trade_counts, [1, 2, 0, 0])
        self.assertEqual(m.block_pnl_r, [3, -2, 0, 0])
        self.assertEqual(m.block_status, ['positive', 'negative', 'inactive', 'inactive'])
        self.assertEqual(m.block_coverage, 0.5)
        self.assertEqual(m.temporal_status, 'known')
        self.assertFalse(core.shadow_objective(m)['eligible'])
        good = core.compute_metrics(self.trades([1] * 40), time_bounds=(0, 400))
        variable = core.compute_metrics(self.trades([0.5, 1.5] * 20), time_bounds=(0, 400))
        self.assertEqual(good.sharpe_simple, 0)
        self.assertIsNone(good.sharpe_per_trade)
        self.assertIsNone(good.sortino_simple)
        self.assertEqual(good.ratio_status['sortino_simple'], 'no_downside')
        a, b = core.shadow_objective(good), core.shadow_objective(variable)
        self.assertTrue(a['eligible'])
        self.assertEqual(a['score'], b['score'])
        self.assertEqual(a['version'], 'risk_v2_shadow')
        self.assertEqual(a['calibration']['status'], 'unavailable')
        self.assertEqual(a['components']['dsr']['contribution'], 0)
        self.assertTrue(math.isfinite(a['score']))
        self.assertEqual(core.OBJECTIVE_VERSION, 'legacy_v1')
        self.assertEqual(core.objective_policy()['selector_version'], 'legacy_v1')
        self.assertTrue(core.objective_policy()['shadow']['experimental'])
        json.dumps(core.to_dict(good), allow_nan=False)
        unknown = core.compute_metrics([{'rMultiple': 1}] * 40)
        self.assertFalse(core.shadow_objective(unknown)['eligible'])
        self.assertIsNone(core.shadow_objective(unknown)['score'])

    def test_calendar_blocks_do_not_compress_inactivity(self):
        values = [2, -1] * 20
        spread = core.compute_metrics(self.trades(values), time_bounds=(0, 400))
        compressed = core.compute_metrics(self.trades(values, list(range(1, 41))), time_bounds=(0, 400))
        self.assertEqual(spread.block_trade_counts, [10] * 4)
        self.assertEqual(compressed.block_trade_counts, [40, 0, 0, 0])
        self.assertGreater(spread.block_coverage, compressed.block_coverage)
        self.assertEqual(compressed.block_status[1:], ['inactive'] * 3)

    def test_invalid_values_and_bounds(self):
        for value in [math.nan, math.inf, -math.inf, True, False]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                core.compute_metrics([{'rMultiple': value}])
        self.assertEqual(core.compute_metrics([{'rMultiple': None}]).trade_count, 0)
        for bad in [dict(rMultiple=1, timestamp=20, closeTs=19),
                    dict(rMultiple=1, timestamp=0, closeTs=100),
                    dict(rMultiple=1, timestamp=0, closeTs=-1)]:
            with self.assertRaises(ValueError):
                core.compute_metrics([bad], time_bounds=(0, 100))
        for bounds in [(10, 10), (20, 10)]:
            with self.assertRaises(ValueError):
                core.compute_metrics([], time_bounds=bounds)

    def test_moments_match_scipy(self):
        import numpy as np
        from scipy.stats import kurtosis, skew
        values = np.random.default_rng(42).normal(size=1000).tolist()
        m = core.compute_metrics([{'rMultiple': r} for r in values])
        self.assertAlmostEqual(m.kurtosis, kurtosis(values, fisher=False, bias=False), places=12)
        self.assertAlmostEqual(m.skewness, skew(values, bias=False), places=12)
        self.assertAlmostEqual(m.sharpe_per_trade, np.mean(values) / np.std(values), places=12)
        short = core.compute_metrics([{'rMultiple': r} for r in [1, 2, -1]])
        self.assertEqual(short.kurtosis, 3)
        self.assertEqual(short.moment_status, 'insufficient_n')


if __name__ == '__main__':
    unittest.main()
