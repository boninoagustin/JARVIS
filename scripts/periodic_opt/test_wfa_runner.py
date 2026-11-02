"""Real Optuna and orchestration, with only the worker/TS mapping boundaries fake."""
from copy import deepcopy
from dataclasses import asdict
import importlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from scripts.hyperopt.metrics import compute_metrics


class FakeWorker:
    ready = True
    def __init__(self, root):
        self.root = Path(root)
        self.calls = []
        self.closed = False
    def init(self, ticker, log_dir, **kwargs):
        self.plan = kwargs.get('wfa_plan')
        return dict(m5_coverage=dict(from_ms=0, to_ms=90*86400000), provenance={'source':'fake'})
    def evaluate_window(self, config, plan, fold_id, role, *, replay_model=None):
        from scripts.hyperopt.wfa_protocol import resolve_fold
        from scripts.periodic_opt.wfa_runner import fingerprint
        f = resolve_fold(plan, fold_id)
        a,b = {'inner_train':(f['is_start_ms'],f['inner_train_end_ms']),
               'inner_validation':(f['inner_validation_start_ms'],f['is_end_ms']),
               'is':(f['is_start_ms'],f['is_end_ms']),
               'outer_oos':(f['oos_start_ms'],f['oos_end_ms'])}[role]
        if role == 'outer_oos':
            self.assert_frozen(fold_id, config)
        self.calls.append((fold_id, role, deepcopy(config)))
        trades=[dict(timestamp=a+1,closedAt=a+2,closeTimestamp=a+2,rMultiple=1.,result='WIN',direction='BUY')]
        provenance={'source':'fake','window':[a,b]}
        return dict(kind='wfa_window_v1',fold_id=fold_id,role=role,
            window=dict(from_ms=a,to_ms=b,warmup_start_ms=max(0,a-14*86400000)),
            closed_trades=trades,returns=[1.],metrics=asdict(compute_metrics(trades)),
            selection_objective=float(config.get('fixedRR',1)) if role=='inner_train' else None,
            effective_config=deepcopy(config),config_fingerprint=fingerprint(config),provenance=provenance,
            evaluation_fingerprint=fingerprint(provenance),
            replay_options=dict(warmupStartMs=max(0,a-14*86400000),evaluationStartMs=a,evaluationEndMs=b,
                statePolicy='context-only-reset-execution-v1',minContextObservations=plan['policy']['min_context_observations']),
            replayDiagnostics=dict(readiness=dict(ready=self.ready,missing=[],observations={})),
            status='OK' if self.ready else 'HOLD_CONTEXT')
    def assert_frozen(self, fold_id, config):
        paths=list(self.root.glob(f'wfa-*/fold-{fold_id}/frozen.json'))
        assert len(paths)==1, 'outer called before freeze'
        frozen=json.loads(paths[0].read_text())
        assert config in (frozen['candidate'],frozen['production'])
    def close(self):
        self.closed=True


class RunnerTest(unittest.TestCase):
    def run_fixture(self, root, ready=True):
        runner=importlib.import_module('scripts.periodic_opt.wfa_runner')
        worker=FakeWorker(root); worker.ready=ready
        base=dict(ticker='TEST',sessions={},mlGateEnabled=False,timesfm={'enabled':False})
        with patch.object(runner,'map_asset',return_value=dict(config=base,production_asset_snapshot={'ticker':'TEST'},mapping_only=True)):
            result=runner.run_wfa_shadow(ticker='TEST',log_dir=root,asset_config={'ticker':'TEST'},
                output_dir=Path(root),n_trials=2,trigger_budget=1,skip_aux=True,skip_ml=True,
                worker_factory=lambda:worker)
        return result,worker
    def test_real_optuna_freezes_before_outer_and_never_requests_vault(self):
        with tempfile.TemporaryDirectory() as root:
            report,worker=self.run_fixture(root)
            self.assertTrue(worker.closed)
            self.assertFalse(report['apply_eligible'])
            self.assertFalse(report['vault']['evaluated'])
            self.assertEqual(report['coverage']['evaluated'],report['coverage']['expected'])
            self.assertEqual(json.loads((Path(root)/'reports/TEST.wfa.json').read_text()),report)
            self.assertTrue(report['folds'])
            for fold in report['folds']:
                self.assertEqual(fold['optimization']['completed'],2)
                self.assertEqual(fold['optimization']['dimensions'],34)
                calls=[r for r in worker.calls if r[0]==fold['id']]
                self.assertTrue(all(role=='inner_train' for _,role,_ in calls[:3]))
                self.assertTrue(all(role in {'inner_train','is','outer_oos'} for _,role,_ in calls))

    def test_unready_trials_are_pruned_and_no_zero_risk_is_invented(self):
        with tempfile.TemporaryDirectory() as root:
            report,worker=self.run_fixture(root,ready=False)
            self.assertEqual(report['status'],'HOLD_INSUFFICIENT_DATA')
            self.assertEqual(report['coverage']['evaluated'],0)
            self.assertNotIn('stitched',report)
            self.assertTrue(all(f['optimization']['completed']==0 for f in report['folds']))
            self.assertTrue(all(r[1]=='inner_train' for r in worker.calls))

    def test_tampered_asset_stops_before_outer(self):
        runner=importlib.import_module('scripts.periodic_opt.wfa_runner')
        original=FakeWorker.evaluate_window
        def tamper(worker,*args,**kwargs):
            result=original(worker,*args,**kwargs)
            next(worker.root.glob('wfa-*/production_asset.json')).write_text('{}')
            return result
        with tempfile.TemporaryDirectory() as root, patch.object(FakeWorker,'evaluate_window',tamper):
            with self.assertRaisesRegex(ValueError,'tamper'):
                self.run_fixture(root)

    def test_all_auxiliaries_share_phased_inner_train_and_saved_artifacts(self):
        runner=importlib.import_module('scripts.periodic_opt.wfa_runner')
        calls=[]
        def saved(command,**kwargs):
            calls.append(command)
            return {'sessions':{}} if 'per_trigger_tune.ts' in command[2] else {}
        fold=dict(id=1,is_start_ms=100,inner_train_end_ms=1000,is_end_ms=2000)
        replay=dict(warmupStartMs=0,evaluationStartMs=100,evaluationEndMs=1000,
                    statePolicy='context-only-reset-execution-v1',minContextObservations={})
        with tempfile.TemporaryDirectory() as root, patch.object(runner,'command_saved',saved):
            _,report=runner.run_auxiliary('TEST',fold,{'replay_options':replay},{'ticker':'TEST'},
                                         Path(root)/'asset.json',root,Path(root),1)
            self.assertEqual(len(calls),6)
            for command in calls:
                self.assertIn('--dry-run',command)
                self.assertIn('--wfa-replay-window',command)
                self.assertIn('--backtest-config-file',command)
                manifest=json.loads(Path(command[command.index('--evaluation-manifest')+1]).read_text())
                self.assertEqual((manifest['from_ms'],manifest['train_end_ms']),(100,1000))
            self.assertEqual(report['context_policy'],'context-only-reset-execution-v1')

    def test_map_only_uses_real_typescript_mapper_and_strict_cli(self):
        import subprocess
        runner=importlib.import_module('scripts.periodic_opt.wfa_runner')
        with tempfile.TemporaryDirectory() as root:
            asset=Path(root)/'asset.json';asset.write_text(json.dumps({'ticker':'TEST','mlGateEnabled':False,'sessions':{}}))
            mapped=runner.map_asset('TEST',asset,Path(root)/'mapped.json')
            self.assertTrue(mapped['mapping_only'])
            self.assertFalse(mapped['config']['mlGateEnabled'])
            result=subprocess.run(['/usr/bin/python3',str(runner.__file__),'--ticker','TEST'],capture_output=True,text=True)
            self.assertEqual(result.returncode,2)
            self.assertIn('--config-file',result.stderr)

    def test_final_candidate_is_frozen_without_vault_replay(self):
        with tempfile.TemporaryDirectory() as root:
            report,worker=self.run_fixture(root)
            self.assertEqual(report['final_candidate']['id'],0)
            self.assertTrue(Path(report['final_candidate']['frozen']['path']).exists())
            self.assertFalse(any(fid==0 and role=='outer_oos' for fid,role,_ in worker.calls))


if __name__=='__main__': unittest.main()
