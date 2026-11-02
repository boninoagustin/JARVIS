"""Canonical selection is frozen legacy; all experimental rankings are diagnostics."""
import copy
import json
import math
from pathlib import Path
import statistics
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import objective_adapter as adapter
import hyperopt_server as server

BASE=1_770_000_000_000
MANIFEST=dict(version=1,ticker='FIXTURE',from_ms=BASE,train_end_ms=BASE+4000,
              validation_end_ms=BASE+5000,test_end_ms=BASE+6000,test_independence='unverified')

def payload():
    trades=[dict(timestamp=BASE+i*90,closeTimestamp=BASE+i*90+1,
                 rMultiple=1 if i%2==0 else -.5,label_status='closed') for i in range(40)]
    m=dict(trade_count=40,wins=20,losses=20,win_rate=.5,gross_profit_r=20,
           gross_loss_r=10,net_pnl_r=10,profit_factor=2,profit_factor_capped=2,
           expectancy=.25,max_drawdown_r=.5,sharpe_simple=(1/3)*math.sqrt(40),
           avg_trade_r=.25,max_consec_losses=1,max_consec_wins=1)
    z={k:0 for k in m if k!='profit_factor_capped'}
    return dict(trade_records_version=1,evaluation_manifest=MANIFEST,train_trades=trades,
                validation_trades=[],validation_r=[],metrics_train=m,metrics=m,metrics_validation=z,
                metrics_oos=z,objective=.8,objective_authority='legacy_compatibility_ts')

class CanonicalIntegrationTests(unittest.TestCase):
    def test_authority_legacy_golden_shadow_never_replaces_objective(self):
        data=payload(); original=copy.deepcopy(data)
        result=adapter.canonicalize_result(data)
        self.assertEqual(data,original,'never mutate RPC/cache evidence')
        self.assertAlmostEqual(result['objective'],.8,places=12)
        self.assertEqual(result['objective_version'],'legacy_v1')
        self.assertEqual(result['objective_authority'],'scripts/hyperopt/metrics.py')
        self.assertEqual(result['objective_worker_legacy'],.8)
        self.assertEqual(result['objective_shadow']['version'],'risk_v2_shadow')
        self.assertIs(result['shadow_consumed_by_sampler'],False)
        self.assertIn('kurtosis',result['metrics_train'])
        self.assertNotIn('test_trades',result)
        json.dumps(result,allow_nan=False)

    def test_validation_returns_cannot_disagree_with_empty_closes(self):
        bad=payload(); bad.update(validation_r=[999.]*40,oos_r=[999.]*40)
        with self.assertRaisesRegex(ValueError,'validation_r'):
            adapter.canonicalize_result(bad)

    @staticmethod
    def _payload_with_returns(partition):
        data=payload()
        if partition=='train':
            data['train_r']=[t['rMultiple'] for t in data['train_trades']]
            return data
        start=MANIFEST['train_end_ms' if partition=='validation' else 'validation_end_ms']
        # Overlaps, equal closes with different entries, and an exact stable tie.
        data[f'{partition}_trades']=[dict(timestamp=start+entry,closeTimestamp=start+close,
            rMultiple=r,label_status='closed') for entry,close,r in
            [(30,80,1),(10,40,-.5),(20,80,2),(20,80,0)]]
        data[f'metrics_{partition}']=adapter.canonical_metrics.to_dict(
            adapter.canonical_metrics.compute_metrics(data[f'{partition}_trades'],
                time_bounds=(start,start+1000)))
        data[f'{partition}_r']=[-.5,2,0,1]
        if partition=='test':
            data['test_evidence']={'metrics_fingerprint':server._fingerprint(data['metrics_test'])}
        return data

    def test_optional_oos_alias_cannot_contradict_validation(self):
        bad=payload(); bad['oos_r']=[999.]
        with self.assertRaisesRegex(ValueError,'oos_r'):
            adapter.canonicalize_result(bad)

    def test_required_return_series_cannot_be_missing(self):
        for partition in ('validation','test'):
            with self.subTest(partition=partition):
                bad=self._payload_with_returns(partition); bad.pop(f'{partition}_r')
                with self.assertRaisesRegex(ValueError,f'{partition}_r'):
                    adapter.canonicalize_result(bad)

    def test_return_series_require_finite_numeric_arrays_without_booleans(self):
        for key in ('validation_r','oos_r','test_r','train_r'):
            partition='validation' if key=='oos_r' else key[:-2]
            valid=self._payload_with_returns(partition)
            rs=valid[f'{partition}_r']
            invalid=[None,{},tuple(rs),'not an array',0,True]
            invalid += [[value]+rs[1:] for value in
                        (float('nan'),float('inf'),-float('inf'),True,False,'1',None)]
            invalid += [rs[:-1],rs+[0]]
            for series in invalid:
                with self.subTest(key=key,series=series):
                    bad=copy.deepcopy(valid); bad[key]=series
                    with self.assertRaisesRegex(ValueError,key):
                        adapter.canonicalize_result(bad)

    def test_return_series_match_exact_canonical_close_order(self):
        for key in ('validation_r','oos_r','test_r','train_r'):
            partition='validation' if key=='oos_r' else key[:-2]
            valid=self._payload_with_returns(partition)
            rs=valid[f'{partition}_r']
            wrong_order=list(reversed(rs))
            if partition!='train':
                wrong_order=[t['rMultiple'] for t in valid[f'{partition}_trades']]
            stable_tie=list(rs)
            stable_tie[1:3]=reversed(stable_tie[1:3])
            for series in (wrong_order,stable_tie,[math.nextafter(rs[0],math.inf)]+rs[1:]):
                with self.subTest(key=key,series=series):
                    bad=copy.deepcopy(valid); bad[key]=series
                    with self.assertRaisesRegex(ValueError,key):
                        adapter.canonicalize_result(bad)

    def test_matching_returns_accept_int_float_and_preserve_signed_test_evidence(self):
        for partition in ('train','validation','test'):
            data=self._payload_with_returns(partition)
            data[f'{partition}_r']=[float(r) for r in data[f'{partition}_r']]
            data['oos_r']=list(data['validation_r'])
            original=copy.deepcopy(data)
            result=adapter.canonicalize_result(data)
            self.assertEqual(data,original)
            self.assertEqual(result[f'{partition}_r'],original[f'{partition}_r'])
            if partition=='test':
                self.assertEqual(result['metrics_test'],original['metrics_test'])
                self.assertEqual(result['test_evidence'],original['test_evidence'])
                self.assertIn('metrics_test_canonical',result)

    def test_malformed_records_mismatched_totals_and_missing_records_fail_closed(self):
        for mutate in (lambda r:r.pop('train_trades'),
                       lambda r:r['train_trades'][0].update(rMultiple=float('inf')),
                       lambda r:r['train_trades'][0].update(closeTimestamp=BASE+5000),
                       lambda r:r['metrics_train'].update(trade_count=39),
                       lambda r:r.update(objective=999),
                       lambda r:r.update(objective=True)):
            with self.subTest(mutate=mutate):
                bad=payload(); mutate(bad)
                with self.assertRaises((ValueError,KeyError)):
                    adapter.canonicalize_result(bad)

    def test_python_worker_wrapper_cannot_return_ts_score_without_canonicalizing(self):
        worker=object.__new__(server.HyperoptWorker)
        with patch.object(worker,'_send',return_value=payload()) as send:
            result=worker.evaluate({'ticker':'FIXTURE'})
            self.assertEqual(result.get('objective_version'),'legacy_v1')
            send.assert_called_once_with('evaluate',{'config':{'ticker':'FIXTURE'}})
        final=payload(); final.update(test_trades=[],test_r=[],metrics_test=copy.deepcopy(final['metrics_validation']))
        with patch.object(worker,'_send',return_value=final):
            self.assertEqual(worker.evaluate_final({})['metrics_test']['trade_count'],0)

    def test_real_optuna_loop_ignores_a_shadow_winner_that_reverses_the_ranking(self):
        # Deliberately synthetic worker boundary; real run_optimization + Optuna/SQLite.
        # No market data, network, production study, or configuration write.
        from argparse import Namespace
        class FakeWorker:
            def __init__(self,**kwargs): self.calls=0; self.results={}
            def init(self,*args):
                provenance={'evaluation_manifest':MANIFEST,'source_files':[
                    {'path':p,'sha256':h} for p,h in adapter.LOADED_SCORING_HASHES.items()]}
                self.context=dict(provenance=provenance,evaluation_manifest=MANIFEST,
                    evaluation_fingerprint=server._fingerprint(provenance),ml_provenance={'status':'fixture'})
                return copy.deepcopy(self.context)
            def evaluate(self,config):
                raw=payload()
                if self.calls:
                    for t in raw['train_trades']:
                        if t['rMultiple']>0: t['rMultiple']=.9
                    raw['metrics_train']=adapter.canonical_metrics.to_dict(
                        adapter.canonical_metrics.compute_metrics(raw['train_trades'],time_bounds=(BASE,BASE+4000)))
                    raw['objective']=.65
                raw.update(self.context,effective_config=config,config_fingerprint=server._fingerprint(config))
                self.results[server._fingerprint(config)]=copy.deepcopy(raw);self.calls+=1
                return adapter.canonicalize_result(raw)
            def evaluate_final(self,config):
                raw=copy.deepcopy(self.results[server._fingerprint(config)])
                raw.update(test_trades=[],test_r=[],metrics_test=copy.deepcopy(raw['metrics_validation']))
                return adapter.canonicalize_result(raw)
            def close(self):pass
        def reversed_shadow(m,**kwargs):
            return dict(version='risk_v2_shadow',eligible=True,score=1000 if m.expectancy<.25 else -1000,
                        reasons=[],components={},calibration={'status':'explicit_test_fixture'})
        with tempfile.TemporaryDirectory() as d:
            output=Path(d)/'out.json'
            args=Namespace(ticker='FIXTURE',log_dir=d,evaluation_manifest=MANIFEST,timesfm_cache=None,
                           current_sessions={},base_config=None,storage=str(Path(d)/'fixture.db'),
                           seed=42,n_startup=2,study_name='shadow_isolation_fixture',smoke_test=False,
                           n_trials=2,output=str(output))
            with patch.object(server,'HyperoptWorker',FakeWorker),patch.object(adapter.canonical_metrics,'shadow_objective',side_effect=reversed_shadow):
                self.assertEqual(server.run_optimization(args),0)
            result=json.loads(output.read_text())
            self.assertEqual(result['best_trial_number'],0)
            self.assertAlmostEqual(result['best_value'],.8)
            self.assertEqual(result['objective_comparison']['shadow_best_trial_number'],1)
            self.assertFalse(result['objective_comparison']['changes_selection'])

    def test_all_posthoc_trials_use_one_frozen_reference_and_legacy_winner_is_unchanged(self):
        first=adapter.canonicalize_result(payload())
        second=copy.deepcopy(first['metrics_train']); second['sharpe_per_trade']=.5
        trials=[SimpleNamespace(number=2,value=.8,user_attrs={'metrics_train':first['metrics_train']}),
                SimpleNamespace(number=9,value=.7,user_attrs={'metrics_train':second})]
        real=adapter.canonical_metrics.shadow_objective
        with patch.object(adapter.canonical_metrics,'shadow_objective',wraps=real) as scorer:
            result=adapter.posthoc_shadow_comparison(trials,legacy_best_number=2,total_trials=3)
            self.assertEqual(len(scorer.call_args_list),2)
            references=[c.kwargs for c in scorer.call_args_list]
            self.assertEqual(references[0],references[1])
            self.assertEqual(references[0]['n_trials_reference'],2)
            self.assertAlmostEqual(references[0]['trials_sr_std'],statistics.stdev([1/3,.5]))
        self.assertEqual(result['legacy_selected_trial'],2)
        self.assertIs(result['changes_selection'],False)
        self.assertFalse(result['final_pipeline_dsr_certified'])
        self.assertEqual(result['reference']['total_trials'],3)
        json.dumps(result,allow_nan=False)

if __name__=='__main__':unittest.main()
