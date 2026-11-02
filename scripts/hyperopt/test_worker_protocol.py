"""Small real NDJSON worker regression; no study, network, or production writes."""
import json
import hashlib
import select
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / 'scripts/hyperopt/jarvis_hyperopt_worker.ts'
BASE = 1_770_000_000_000
MANIFEST = dict(version=1, ticker='EURUSD', from_ms=BASE, train_end_ms=BASE+700,
                validation_end_ms=BASE+1000, test_end_ms=BASE+1200,
                test_independence='unverified')
CONFIG = dict(ticker='EURUSD', minBuyPoints=3, minSellPoints=3, oteEntryPercent=62,
              entryTrigger='SMART', mlGate={'enabled':False})


def rpc(directory, requests):
    payload = ''.join(json.dumps(dict(id=i, method=method, params=params))+'\n'
                      for i,(method,params) in enumerate(requests))
    result = subprocess.run([str(ROOT/'node_modules/.bin/tsx'), str(WORKER)], cwd=ROOT,
                            input=payload, text=True, capture_output=True, timeout=30)
    if result.returncode:
        raise AssertionError(result.stderr)
    lines = [json.loads(line) for line in result.stdout.splitlines()]
    if len(lines) != len(requests):
        raise AssertionError((lines,result.stderr))
    return lines


class WorkerProtocolTests(unittest.TestCase):
    def test_wrapper_mutation_in_fixture_changes_namespace_and_invalidates_initialized_worker(self):
        with tempfile.TemporaryDirectory() as d:
            fixture = Path(d)
            for relative in ('src','jarvis-os/src'):
                shutil.copytree(ROOT/relative, fixture/relative)
            (fixture/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
            (fixture/'scripts/hyperopt').mkdir(parents=True)
            for relative in ('package.json','tsconfig.json','scripts/hyperopt/jarvis_hyperopt_worker.ts',
                             'scripts/hyperopt/evaluation_protocol.ts'):
                shutil.copy2(ROOT/relative,fixture/relative)
            logs = fixture/'logs'
            logs.mkdir()
            (logs/'M5.csv').write_text(''.join(
                f'PING_PRICE | TF: 5 | Precio: 1.10 | TS: {BASE+x}\n'
                for x in (0, 1, 700, 999, 1000, 1199)))
            command = [str(ROOT/'node_modules/.bin/tsx'),str(fixture/'scripts/hyperopt/jarvis_hyperopt_worker.ts')]
            init_params = dict(ticker='EURUSD',log_dir=str(logs),evaluation_manifest=MANIFEST)
            wrapper = fixture/'jarvis-os/src/engine/TimesfmFilter.ts'
            with subprocess.Popen(command,cwd=fixture,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL,text=True) as process:
                try:
                    process.stdin.write(json.dumps(dict(id=0,method='init',params=init_params))+'\n')
                    process.stdin.flush()
                    self.assertTrue(select.select([process.stdout],[],[],15)[0], 'fixture worker init timeout')
                    first = json.loads(process.stdout.readline())['result']
                    wrapper.write_text(wrapper.read_text()+'\n// fixture-only provenance mutation\n')
                    payload = json.dumps(dict(id=1,method='evaluate',params={'config':CONFIG}))+'\n'
                    output,_ = process.communicate(payload,timeout=15)
                    self.assertRegex(json.loads(output)['error'],'source snapshot changed')
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate()
            output = subprocess.run(command,cwd=fixture,input=json.dumps(dict(id=0,method='init',params=init_params))+'\n',
                                    text=True,capture_output=True,timeout=15)
            self.assertEqual(output.returncode,0,output.stderr)
            second = json.loads(output.stdout)['result']
            self.assertNotEqual(first['evaluation_fingerprint'],second['evaluation_fingerprint'])
            hashes = {f['path']:f['sha256'] for f in second['provenance']['source_files']}
            self.assertEqual(hashes[str(wrapper)],hashlib.sha256(wrapper.read_bytes()).hexdigest())

    def test_collect_test_rejected_even_before_config_resolution(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/'M5.csv').write_text(''.join(
                f'PING_PRICE | TF: 5 | Precio: 1.10 | TS: {BASE+x}\n'
                for x in (0, 1, 700, 1000, 1199)))
            responses = rpc(d, [
                ('init', dict(ticker='EURUSD', log_dir=d, evaluation_manifest=MANIFEST)),
                ('collect_trades', {'config':CONFIG, 'partition':'test'}),
            ])
            self.assertIn('error', responses[1], 'collect must never expose Test labels')
            self.assertRegex(responses[1]['error'], 'Test.*evaluate_final')

    def test_verified_model_never_silently_enables_live_permission(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/'M5.csv').write_text(''.join(
                f'PING_PRICE | TF: 5 | Precio: 1.10 | TS: {BASE+x}\n'
                for x in (0, 1, 700, 999, 1000, 1199)))
            model = Path(d)/'verified-model.json'
            model.write_text(json.dumps({'meta': {'train_end_ms':BASE-2,
                'available_at_ms':BASE-1, 'accuracy':0.7, 'f1':0.7,
                'feature_names':[], 'threshold':0.6}, 'xgboost_model':[{'leaf':1}]}))
            configs = [
                {**CONFIG, 'mlGate':{'modelPath':str(model)}},
                {**CONFIG, 'mlGateEnabled':False, 'mlGate':{'modelPath':str(model)}},
                {**CONFIG, 'mlGateEnabled':True, 'mlGate':{'modelPath':str(model)}},
                {**CONFIG, 'mlGateEnabled':False, 'mlGate':{'enabled':True, 'modelPath':str(model)}},
                {**CONFIG, 'mlGateEnabled':True, 'mlGate':{'enabled':False, 'modelPath':str(model)}},
            ]
            responses = rpc(d, [('init', dict(ticker='EURUSD',log_dir=d,evaluation_manifest=MANIFEST))]
                + [('evaluate',{'config':c}) for c in configs])
            for i in (1,2,5):
                self.assertEqual(responses[i]['result']['effective_config']['mlGate'], {'enabled':False})
            self.assertTrue(responses[3]['result']['effective_config']['mlGate']['enabled'])
            self.assertIn('error',responses[4], 'explicit ON must agree with caller permission')
            oil = rpc(d, [
                ('init', dict(ticker='USOIL',log_dir=d,evaluation_manifest={**MANIFEST,'ticker':'USOIL'})),
                ('evaluate', {'config':{**configs[2],'ticker':'USOIL'}}),
            ])
            self.assertTrue(oil[1]['result']['effective_config']['mlGate']['enabled'],
                            'production permission overrides historical static USOIL exclusion')

    def test_timesfm_replay_strips_writers_and_requires_cache_even_in_collect_mode(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            (directory/'M5.csv').write_text(''.join(
                f'PING_PRICE | TF: 5 | Precio: 1.10 | TS: {BASE+x}\n'
                for x in (0, 1, 700, 999, 1000, 1199)))
            cache = directory/'cache.jsonl'
            cache.write_text('')
            audit = directory/'active-audit.jsonl'
            collect = directory/'active-collect.jsonl'
            audit.write_text('sentinel-audit\n')
            collect.write_text('sentinel-collect\n')
            tfm = dict(enabled=True, cachePath=str(cache), collectOnly=True,
                       auditPath=str(audit), collectPath=str(collect))
            config = {**CONFIG,'timesfm':tfm}
            responses = rpc(d,[
                ('init',dict(ticker='EURUSD',log_dir=d,evaluation_manifest=MANIFEST,timesfm_cache=str(cache))),
                ('evaluate_final',{'config':config}),
                ('collect_trades',{'config':config}),
                ('evaluate',{'config':{**CONFIG,'timesfm':{**tfm,'cachePath':None}}}),
                ('evaluate',{'config':{**CONFIG,'timesfm':{'enabled':True,'cachePath':str(cache)}}}),
            ])
            for i in (1,2):
                effective = responses[i]['result']['effective_config']['timesfm']
                self.assertNotIn('auditPath',effective)
                self.assertNotIn('collectPath',effective)
                self.assertFalse(effective.get('collectOnly',False))
                self.assertEqual(effective['cachePath'],str(cache))
            self.assertIn('error',responses[3], 'collectOnly may not bypass required evaluation cache')
            self.assertEqual(responses[1]['result']['config_fingerprint'],responses[4]['result']['config_fingerprint'],
                             'final fingerprint must identify sanitized effective config, not writer paths')
            self.assertEqual(responses[1]['result']['effective_config'],responses[4]['result']['effective_config'])
            self.assertEqual(audit.read_text(),'sentinel-audit\n')
            self.assertEqual(collect.read_text(),'sentinel-collect\n')
            self.assertEqual(config['timesfm'],tfm)

    def test_temporal_partitions_final_only_test_and_exact_provenance(self):
        with tempfile.TemporaryDirectory() as d:
            csv = Path(d)/'M5.csv'
            timestamps = [BASE+x for x in (0,1,2,3,699,700,999,1000,1199,1200)]
            csv.write_text(''.join(f'PING_PRICE | TF: 5 | Precio: 1.10 | TS: {ts}\n' for ts in timestamps))
            responses = rpc(d, [
                ('init', dict(ticker='EURUSD', log_dir=d, evaluation_manifest=MANIFEST)),
                ('evaluate', {'config':CONFIG}),
                ('evaluate_final', {'config':CONFIG}),
                ('collect_trades', {'config':CONFIG, 'partition':'validation'}),
                ('collect_trades', {'config':CONFIG, 'partition':'bogus'}),
                ('evaluate', {'config':{**CONFIG, 'ticker':'GBPUSD'}}),
                ('init', dict(ticker='EURUSD', log_dir=d, evaluation_manifest={**MANIFEST, 'train_end_ms':BASE})),
                ('evaluate', {'config':CONFIG}),
            ])
            init = responses[0]['result']
            self.assertEqual(init.get('evaluation_manifest'), MANIFEST, 'missing explicit temporal manifest')
            self.assertEqual(init['oos_split'], dict(train=5, validation=2, test=2))
            self.assertEqual(len(init['evaluation_fingerprint']),64)
            self.assertEqual(init['provenance']['dataset_files'][0]['path'], str(csv))
            import hashlib
            self.assertEqual(init['provenance']['dataset_files'][0]['sha256'], hashlib.sha256(csv.read_bytes()).hexdigest())
            hashes = {f['path']:f['sha256'] for f in init['provenance']['source_files']}
            for relative in ('jarvis-os/src/engine/AlphaModel.ts','jarvis-os/src/engine/FrictionModel.ts',
                             'jarvis-os/src/engine/TimesfmFilter.ts','jarvis-os/src/engine/Types.ts'):
                wrapper = ROOT/relative
                self.assertIn(str(wrapper),hashes, 'imported wrapper omitted from source namespace')
                self.assertEqual(hashes[str(wrapper)],hashlib.sha256(wrapper.read_bytes()).hexdigest())
            trial = responses[1]['result']
            self.assertEqual(trial['metrics_validation'], trial['metrics_oos'])
            self.assertEqual(trial['validation_r'], trial['oos_r'])
            self.assertNotIn('metrics_test',trial)
            final = responses[2]['result']
            self.assertEqual(final['config_fingerprint'],trial['config_fingerprint'])
            self.assertEqual(final['evaluation_fingerprint'],init['evaluation_fingerprint'])
            self.assertEqual(final['metrics_test']['trade_count'],0)
            self.assertEqual(final['test_r'],[])
            evidence = final.get('test_evidence')
            self.assertIsNotNone(evidence, 'final Test must be bound to config, evaluation and metrics')
            self.assertEqual(evidence, dict(partition='test',
                config_fingerprint=final['config_fingerprint'],
                evaluation_fingerprint=final['evaluation_fingerprint'],
                metrics_fingerprint=hashlib.sha256(json.dumps(final['metrics_test'],sort_keys=True,
                    separators=(',',':')).encode()).hexdigest(),
                test_independence=MANIFEST['test_independence']))
            self.assertNotIn('test_evidence',trial)
            collected = responses[3]['result']
            self.assertEqual(collected['dataset_meta']['partition'],'validation')
            self.assertEqual(collected['dataset_meta']['events'],2)
            self.assertIn('error',responses[4])
            self.assertIn('error',responses[5])
            self.assertIn('error',responses[6])
            self.assertIn('error',responses[7], 'failed init must invalidate prior state')


if __name__ == '__main__':
    unittest.main()
