"""Actual CLI/RPC WFA boundaries, using explicitly synthetic events only."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]

class WfaWireTests(unittest.TestCase):
    def test_window_wrapper_exists_and_uses_canonical_boundary(self):
        import hyperopt_server as server
        self.assertTrue(callable(getattr(server.HyperoptWorker,'evaluate_window',None)),
                        'WFA RPC must have a canonical Python scoring boundary')

    def test_real_wrapper_window_replay_and_canonical_rejection(self):
        import copy
        from hyperopt_server import HyperoptWorker
        from wfa_protocol import build_wfa_plan, resolve_fold
        B=1700000000000; D=86400000
        plan=build_wfa_plan('FIXTURE',B,B+56*D,policy={
            'min_context_observations':{k:1 for k in ('5','15','60','240','D')}})
        fold=resolve_fold(plan,1)
        with tempfile.TemporaryDirectory() as d:
            directory=Path(d)
            for tf,name in [('5','M5'),('15','M15'),('60','H1'),('240','H4'),('D','D1')]:
                times=[B, fold['is_start_ms']-1,fold['is_start_ms'],fold['inner_train_end_ms']-1,B+56*D-1]
                (directory/(name+'.csv')).write_text(''.join(
                    f'PING_PRICE | TF: {tf} | Precio: 1.1 | TS: {t}\n' for t in times))
            worker=HyperoptWorker('tsx','npx',ROOT)
            config=dict(ticker='FIXTURE',minBuyPoints=3,minSellPoints=3,
                        oteEntryPercent=62,entryTrigger='SMART',mlGate={'enabled':False})
            try:
                init=worker.init('FIXTURE',d,wfa_plan=plan)
                self.assertEqual(init['wfa_plan'],plan)
                result=worker.evaluate_window(config,plan,1,'inner_train')
                self.assertEqual(result['status'],'OK')
                self.assertEqual(result['objective_version'],'legacy_v1')
                self.assertEqual(result['returns'],[])
                self.assertEqual(result['selection_objective'],-100.)
                self.assertFalse(result['shadow_consumed_by_sampler'])
                for role in ('inner_validation','is'):
                    final=worker.evaluate_window(config,plan,0,role)
                    self.assertEqual(final['status'],'OK','warmup must reach actual HTF observations, not just 14 elapsed days')
                    self.assertIsNone(final['selection_objective'])
                with self.assertRaisesRegex(ValueError,'Vault'):
                    worker.evaluate_window(config,plan,0,'outer_oos')
                from wfa_adapter import canonicalize_window
                import metrics
                fixture=copy.deepcopy(result)
                fixture['closed_trades']=[dict(timestamp=fold['is_start_ms']+i,closeTimestamp=fold['is_start_ms']+10+i,
                    closedAt=fold['is_start_ms']+10+i,closeTs=fold['is_start_ms']+10+i,direction='BUY',
                    result='WIN' if r>0 else 'LOSS',rMultiple=r,label_status='closed') for i,r in enumerate((1.,-2.,3.))]
                fixture['returns']=[1.,-2.,3.]
                cm=metrics.compute_metrics(fixture['closed_trades'],time_bounds=(fold['is_start_ms'],fold['inner_train_end_ms']))
                fixture['metrics']=metrics.to_dict(cm);fixture['selection_objective']=metrics.objective_function(cm)
                verified=canonicalize_window(fixture,plan,1,'inner_train',init_info=init)
                self.assertEqual(verified['metrics']['net_pnl_r'],2.)
                for series in ([1.,3.,-2.],[1.,False,3.],[1.,float('nan'),3.]):
                    changed=copy.deepcopy(fixture);changed['returns']=series
                    with self.assertRaises(ValueError):
                        canonicalize_window(changed,plan,1,'inner_train',init_info=init)
                for mutate in (
                    lambda r:r.update(returns=[1]),
                    lambda r:r.update(role='is'),
                    lambda r:r.update(plan_fingerprint='bad'),
                    lambda r:r['window'].update(to_ms=1),
                    lambda r:r['metrics'].update(trade_count=9),
                    lambda r:r['provenance'].update(protocol='bad'),
                    lambda r:r['replayDiagnostics']['readiness']['observations'].update(D=0),
                    lambda r:r.update(closed_trades=[{'timestamp':fold['is_start_ms'],'rMultiple':0}]),
                ):
                    changed=copy.deepcopy(result);mutate(changed)
                    with self.assertRaises(ValueError):
                        canonicalize_window(changed,plan,1,'inner_train',init_info=init)
                from wfa_adapter import fingerprints
                changed=copy.deepcopy(result);changed['effective_config']['minBuyPoints']=999
                changed['config_fingerprint']=fingerprints(changed['effective_config'])[0]
                with self.assertRaises(ValueError):
                    canonicalize_window(changed,plan,1,'inner_train',init_info=init,requested_config=config)
            finally:
                worker.close()

    def test_reconstruction_bytes_metadata_roles_and_live_permission(self):
        import copy, hashlib
        from datetime import datetime, timezone
        from hyperopt_server import HyperoptWorker
        from wfa_protocol import build_wfa_plan, resolve_fold
        from test_worker_protocol import rpc
        B=1700000000000;D=86400000
        plan=build_wfa_plan('FIXTURE',B,B+56*D,policy={
            'min_context_observations':{k:1 for k in ('5','15','60','240','D')}})
        f=resolve_fold(plan,1)
        now=int(datetime.now(timezone.utc).timestamp()*1000)
        trained=datetime.fromtimestamp(now/1000,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        meta=dict(ticker='FIXTURE',train_end_ms=f['inner_train_end_ms'],available_at_ms=now,
                  trained_at=trained,trained_at_ms=now,accuracy=.7,f1=.7,threshold=.6,feature_names=[])
        meta['wfa_reconstruction']=dict(version=1,fold_id=1,fit_asof_ms=f['is_end_ms'],
            plan_fingerprint=plan['fingerprint'],train_label_end_ms=f['inner_train_end_ms']-1,
            selection_label_end_ms=f['is_end_ms']-1)
        model=dict(meta=meta,xgboost_model=[{'leaf':1}])
        with tempfile.TemporaryDirectory() as d:
            for tf,name in [('5','M5'),('15','M15'),('60','H1'),('240','H4'),('D','D1')]:
                (Path(d)/(name+'.csv')).write_text(''.join(f'PING_PRICE | TF: {tf} | Precio: 1.1 | TS: {t}\n'
                    for t in (B,f['oos_start_ms'],f['oos_end_ms']-1,B+56*D-1)))
            path=Path(d)/'model.json';path.write_text(json.dumps(model))
            descriptor=dict(version=1,kind='historical_reconstruction',fold_id=1,fit_asof_ms=f['is_end_ms'],
                plan_fingerprint=plan['fingerprint'],model_path=str(path),model_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            config=dict(ticker='FIXTURE',minBuyPoints=3,minSellPoints=3,oteEntryPercent=62,entryTrigger='SMART',mlGateEnabled=True)
            init=dict(ticker='FIXTURE',log_dir=d,wfa_plan=plan)
            params=dict(config=config,plan=plan,fold_id=1,role='outer_oos',replay_model=descriptor)
            requests=[('init',init),('evaluate_window',params),
                ('evaluate_window',{**params,'config':{**config,'mlGateEnabled':False}}),
                ('evaluate_window',{**params,'config':{**config,'mlGate':{'enabled':False}}}),
                ('evaluate_window',{**params,'role':'inner_train'}),
                ('evaluate_window',{**params,'fold_id':0,'config':None}),
                ('evaluate_window',{**params,'role':'bogus'}),
                ('evaluate_window',{**params,'replay_model':{k:v for k,v in descriptor.items() if k!='model_sha256'}}),
                ('evaluate_window',{**params,'replay_model':{**descriptor,'model_sha256':'0'*64}}),
                ('evaluate',{'config':config}),('evaluate_final',{'config':config}),('collect_trades',{'config':config})]
            responses=rpc(d,requests)
            on=responses[1]['result'];off=responses[2]['result'];explicit=responses[3]['result']
            self.assertTrue(on['effective_config']['mlGate']['enabled'])
            self.assertEqual(on['effective_config']['mlGate']['trainedAt'],f['is_end_ms'])
            self.assertEqual(on['ml_provenance']['available_at_ms'],now)
            self.assertEqual(on['ml_provenance']['simulated_asof_ms'],f['is_end_ms'])
            self.assertFalse(off['effective_config']['mlGate']['enabled'])
            self.assertFalse(explicit['effective_config']['mlGate']['enabled'])
            for response in responses[4:]:self.assertIn('error',response)
            worker=HyperoptWorker('tsx','npx',ROOT)
            try:
                worker.init('FIXTURE',d,wfa_plan=plan)
                canonical=worker.evaluate_window(config,plan,1,'outer_oos',replay_model=descriptor)
                self.assertIsNone(canonical['selection_objective'])
                self.assertEqual(canonical['ml_provenance']['available_at_ms'],now)
                from wfa_adapter import canonicalize_window
                with self.assertRaises(ValueError):
                    canonicalize_window(on,plan,1,'outer_oos',init_info=worker._wfa_init,replay_model=descriptor,
                        requested_config={**config,'mlGate':{'enabled':False}})
            finally:worker.close()
            # Matching bytes hash does not excuse contradictory artifact identity/cutoffs.
            for mutate in (lambda m:m['meta'].update(ticker='OTHER'),
                           lambda m:m['meta'].update(trained_at_ms=now+1),
                           lambda m:m['meta']['wfa_reconstruction'].update(selection_label_end_ms=f['is_end_ms']),
                           lambda m:m['meta']['wfa_reconstruction'].update(train_label_end_ms=f['inner_train_end_ms'])):
                changed=copy.deepcopy(model);mutate(changed);path.write_text(json.dumps(changed))
                desc={**descriptor,'model_sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
                result=rpc(d,[('init',init),('evaluate_window',{**params,'replay_model':desc})])[1]
                self.assertIn('error',result)

    def test_real_closed_trade_roundtrip_does_not_invent_or_drop_realization(self):
        from hyperopt_server import HyperoptWorker
        from wfa_protocol import build_wfa_plan,resolve_fold
        B=1700000000000;D=86400000
        plan=build_wfa_plan('EURUSD',B,B+56*D,policy={'min_context_observations':{k:1 for k in ('5','15','60','240','D')}})
        f=resolve_fold(plan,1);start=f['is_start_ms']
        with tempfile.TemporaryDirectory() as d:
            for tf,name in [('5','M5'),('15','M15'),('60','H1'),('240','H4'),('D','D1')]:
                rows=[f'PING_PRICE | TF: {tf} | Precio: 1.1 | High: 1.1002 | Low: 1.0998 | TS: {B}',
                      f'PING_PRICE | TF: {tf} | Precio: 1.1 | TS: {B+56*D-1}']
                if tf=='5':
                    rows.extend([f'PING_PRICE | TF: 5 | Precio: 1.1 | High: 1.1002 | Low: 1.0998 | TS: {start}',
                        f'EVENTO_CHOCH | TF: 5 | BUY | ORIGIN: 1.099 | Precio: 1.1 | TS: {start+1}',
                        f'PING_PRICE | TF: 5 | Precio: 1.09 | High: 1.0902 | Low: 1.0898 | TS: {start+60000}',
                        f'PING_PRICE | TF: 5 | Precio: 1.09 | TS: {start+120000}'])
                (Path(d)/(name+'.csv')).write_text('\n'.join(rows)+'\n')
            cfg=dict(ticker='EURUSD',entryTrigger='CHOCH',minBuyPoints=1,minSellPoints=1,oteEntryPercent=70,
                     maxTradesPerDay=1,maxTradesPerSession=1,mlGate={'enabled':False})
            worker=HyperoptWorker('tsx','npx',ROOT)
            try:
                worker.init('EURUSD',d,wfa_plan=plan)
                result=worker.evaluate_window(cfg,plan,1,'inner_train')
                self.assertEqual(result['status'],'OK')
                self.assertEqual(result['metrics']['trade_count'],1)
                self.assertEqual(result['returns'],[t['rMultiple'] for t in result['closed_trades']])
                self.assertLess(result['returns'][0],0)
                self.assertEqual(result['closed_trades'][0]['closeTimestamp'],start+60000)
            finally:worker.close()

    def test_insufficient_context_is_hold_not_protocol_error_or_selection(self):
        from hyperopt_server import HyperoptWorker
        from wfa_protocol import build_wfa_plan
        B=1700000000000;D=86400000
        plan=build_wfa_plan('FIXTURE',B,B+56*D)
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/'M5.csv').write_text(''.join(f'PING_PRICE | TF: 5 | Precio: 1.1 | TS: {t}\n'
                for t in (B,B+10*D,B+56*D-1)))
            worker=HyperoptWorker('tsx','npx',ROOT)
            try:
                worker.init('FIXTURE',d,wfa_plan=plan)
                cfg=dict(ticker='FIXTURE',minBuyPoints=3,minSellPoints=3,oteEntryPercent=62,entryTrigger='SMART')
                result=worker.evaluate_window(cfg,plan,1,'inner_train')
                self.assertEqual(result['status'],'HOLD_CONTEXT')
                self.assertIsNone(result['selection_objective'])
                self.assertEqual(result['returns'],[])
                self.assertFalse(result['replayDiagnostics']['readiness']['ready'])
                with self.assertRaisesRegex(ValueError,'role'):
                    worker.evaluate_window(cfg,plan,1,'unknown')
            finally:worker.close()

    def test_htf_context_before_first_m5_is_retained_for_warmup(self):
        from hyperopt_server import HyperoptWorker
        from wfa_protocol import build_wfa_plan,resolve_fold
        B=1700000000000;D=86400000
        plan=build_wfa_plan('FIXTURE',B,B+56*D,policy={'min_context_observations':{k:1 for k in ('5','15','60','240','D')}})
        with tempfile.TemporaryDirectory() as d:
            for tf,name in [('5','M5'),('15','M15'),('60','H1'),('240','H4'),('D','D1')]:
                times=[B,B+8*D,B+56*D-1] if tf=='5' else [B-D]
                (Path(d)/(name+'.csv')).write_text(''.join(f'PING_PRICE | TF: {tf} | Precio: 1.1 | TS: {t}\n' for t in times))
            worker=HyperoptWorker('tsx','npx',ROOT)
            try:
                worker.init('FIXTURE',d,wfa_plan=plan)
                cfg=dict(ticker='FIXTURE',entryTrigger='SMART',minBuyPoints=3,minSellPoints=3,oteEntryPercent=62,mlGate={'enabled':False})
                result=worker.evaluate_window(cfg,plan,1,'inner_train')
                self.assertEqual(result['status'],'OK','valid causal HTF context must not be cut at M5 start')
                self.assertLess(result['replay_options']['warmupStartMs'],B)
                self.assertTrue(result['replayDiagnostics']['readiness']['ready'])
            finally:worker.close()

    def test_map_only_does_not_require_manifest_logs_or_start_replay(self):
        with tempfile.TemporaryDirectory() as d:
            asset=Path(d)/'asset.json';out=Path(d)/'snapshot.json'
            raw={'minPointsForBuy':7,'minPointsForSell':8,'entryStrategy':'SMART',
                 'sessions':{},'mlGateEnabled':False,'timesfm':{'enabled':False}}
            asset.write_text(json.dumps(raw))
            cmd=[str(ROOT/'node_modules/.bin/tsx'),str(ROOT/'scripts/periodic_opt/eval_production.ts'),
                 'FIXTURE','--map-only','--config-file',str(asset),'--save',str(out)]
            run=subprocess.run(cmd,cwd=ROOT,text=True,capture_output=True,timeout=20)
            self.assertEqual(run.returncode,0,run.stdout+run.stderr)
            result=json.loads(out.read_text())
            self.assertTrue(result['mapping_only'])
            self.assertEqual(result['config']['minBuyPoints'],7)
            self.assertEqual(result['config']['minSellPoints'],8)
            self.assertEqual(result['production_asset_snapshot'],raw)
            self.assertNotIn('metrics_train',result)
            self.assertNotIn('validation_r',result)

if __name__=='__main__':unittest.main()
