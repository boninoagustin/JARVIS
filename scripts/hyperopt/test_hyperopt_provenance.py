"""Fast integration: one-trial fixture studies, never real market optimization."""
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0,str(HERE))
import hyperopt_server as server


class HyperoptProvenanceTests(unittest.TestCase):
    def test_builder_transports_explicit_live_ml_permission_without_changing_space(self):
        class Trial:
            def suggest_float(self, name, low, high): return low
            def suggest_int(self, name, low, high): return low
            def suggest_categorical(self, name, choices): return choices[0]
        params = server.suggest_params(Trial())
        legacy = server.build_backtest_config('FIXTURE', params)
        self.assertIs(legacy.get('mlGateEnabled'), False, 'legacy snapshot must explicitly preserve live OFF')
        enabled = server.build_backtest_config('USOIL',params,current_ml_gate_enabled=True)
        self.assertIs(enabled['mlGateEnabled'], True)
        self.assertIsNone(enabled['mlGate'])
        with self.assertRaises(ValueError):
            server.build_backtest_config('FIXTURE', params, current_ml_gate_enabled='true')
        self.assertEqual(len(params),34)

    def test_base_config_preserves_all_unsearched_fields_and_input_snapshot(self):
        class Trial:
            def suggest_float(self, name, low, high): return low
            def suggest_int(self, name, low, high): return low
            def suggest_categorical(self, name, choices): return choices[0]
        with tempfile.TemporaryDirectory() as d:
            cache = Path(d)/'cache.jsonl'
            cache.write_text('')
            base = dict(ticker='USOIL',entryTrigger='CHOCH',mlGateEnabled=False,
                mlGate={'enabled':False},enabled=False,spreadPips=0,
                timesfm={'enabled':False,'cachePath':str(cache),'flatMult':0},
                sessions={'ALL':{'bos5m':{'enabled':False,'slBuff':0}}},
                zoneWeights={'CUSTOM':{'ALL':0},'OB':{'ALL':0}},custom={'keep':False})
            original = json.loads(json.dumps(base))
            params = server.suggest_params(Trial())
            result = server.build_backtest_config('USOIL',params,base_config=base)
            for key,value in base.items():
                if key != 'zoneWeights':
                    self.assertEqual(result[key],value, f'preserve unsearched {key}')
            self.assertEqual(result['zoneWeights']['CUSTOM'],base['zoneWeights']['CUSTOM'])
            self.assertEqual(result['zoneWeights']['OB']['ALL'],0)
            self.assertEqual(base,original,'builder mutated its snapshot')
            with self.assertRaisesRegex(ValueError,'permission mismatch'):
                server.build_backtest_config('USOIL',params,base_config=base,current_ml_gate_enabled=True)

    def test_snapshot_cli_permission_true_false_missing_and_invalid(self):
        with tempfile.TemporaryDirectory() as d:
            snapshot = Path(d)/'snapshot.json'
            for permission in (True,False,'missing'):
                value = dict(ticker='FIXTURE',sessions={},timesfm={'enabled':False})
                if permission != 'missing':
                    value['mlGateEnabled'] = permission
                snapshot.write_text(json.dumps(value))
                argv = ['hyperopt_server.py','--ticker','FIXTURE','--log-dir',d,
                        '--current-sessions',str(snapshot)]
                with patch.object(sys,'argv',argv), patch.object(server,'run_optimization',return_value=0) as run:
                    self.assertEqual(server.main(),0)
                    args = run.call_args.args[0]
                    self.assertIs(args.current_ml_gate_enabled, permission is True)
            snapshot.write_text(json.dumps(dict(ticker='FIXTURE',sessions={},mlGateEnabled='true')))
            with patch.object(sys,'argv',argv), patch.object(server,'run_optimization') as run:
                with self.assertRaises(SystemExit) as failure:
                    server.main()
                self.assertEqual(failure.exception.code,2)
                run.assert_not_called()
            for cli in ('run_hyperopt.py','hyperopt_server.py'):
                help_run = subprocess.run([sys.executable,str(HERE/cli),'--help'],
                                          capture_output=True,text=True,timeout=15)
                self.assertEqual(help_run.returncode,0,help_run.stderr)
                for flag in ('--base-config','--log-dir','--current-sessions','--evaluation-manifest'):
                    self.assertIn(flag,help_run.stdout)

    def test_export_is_reevaluated_effective_config_and_namespace_isolated(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            base = 1_770_000_000_000
            (directory/'M5.csv').write_text(''.join(
                f'PING_PRICE | TF: 5 | Precio: 1.10 | TS: {base+x}\n' for x in (0,1,2,300,699,700,999)))
            manifest = dict(version=1,ticker='FIXTURE',from_ms=base,train_end_ms=base+700,
                validation_end_ms=base+1000,test_end_ms=base+1000,test_independence='unverified')
            mf = directory/'manifest.json'
            mf.write_text(json.dumps(manifest))
            output = directory/'result.json'
            database = directory/'study.db'
            base_config = dict(ticker='FIXTURE',entryTrigger='BOTH',enabled=False,
                spreadPips=0,commissionPerLot=7,sessionFilter=['ASIA'],
                killSwitch={'enabled':False,'threshold':0},customUnsearched={'keep':[0,False]},
                sessions={'ALL':{'bos5m':{'enabled':False,'minScore':9}}},
                timesfm={'enabled':False,'flatMult':0},mlGateEnabled=True,mlGate={'enabled':False})
            base_file = directory/'base.json'
            base_file.write_text(json.dumps(base_config))
            overlay = directory/'overlay.json'
            overlay.write_text(json.dumps(dict(ticker='FIXTURE',sessions=base_config['sessions'],
                timesfm=base_config['timesfm'],mlGateEnabled=True)))
            command = [sys.executable,str(HERE/'run_hyperopt.py'),'FIXTURE',
                '--log-dir',d,'--base-config',str(base_file),'--current-sessions',str(overlay),
                '--n-trials','1','--n-startup','1','--study-name','legacy_fixture',
                '--storage',str(database),'--output',str(output),'--evaluation-manifest',str(mf)]
            first = subprocess.run(command,cwd=ROOT,text=True,capture_output=True,timeout=40)
            self.assertEqual(first.returncode,0,first.stderr)
            exported = json.loads(output.read_text())
            self.assertTrue(exported['study_name'].startswith('legacy_fixture__'))
            self.assertEqual(exported['requested_study_name'],'legacy_fixture')
            self.assertEqual(exported['evaluation_manifest'],manifest)
            self.assertEqual(exported['best_config']['mlGate'],{'enabled':False})
            for key,value in base_config.items():
                self.assertEqual(exported['best_config'][key],value, f'unsearched field {key} was overwritten')
            self.assertEqual(exported['provenance']['base_config'],base_config)
            self.assertEqual(len(exported['provenance']['base_config_fingerprint']),64)
            self.assertEqual(exported['provenance']['current_ml_gate_enabled'],True)
            self.assertEqual(exported['best_config']['minBuyPoints'],exported['best_params']['minBuyPoints'])
            self.assertEqual(exported['best_config']['fixedRR'],exported['best_params']['fixedRR'])
            self.assertEqual(exported['best_metrics'],exported['final_evaluation']['metrics_train'])
            self.assertEqual(exported['best_value'],exported['final_evaluation']['objective'])
            self.assertEqual(exported['config_fingerprint'],exported['final_evaluation']['config_fingerprint'])
            self.assertEqual(exported['best_metrics_oos'],exported['best_metrics_validation'])
            self.assertEqual(exported['best_test_r'],[])
            second = subprocess.run(command,cwd=ROOT,text=True,capture_output=True,timeout=40)
            self.assertEqual(second.returncode,0,second.stderr)
            resumed = json.loads(output.read_text())
            self.assertEqual(resumed['study_name'],exported['study_name'])
            self.assertEqual(resumed['n_trials'],2)
            self.assertEqual(resumed['new_trials'],1)
            # Same dataset path but changed exact contents cannot resume historical scores.
            (directory/'M5.csv').write_text((directory/'M5.csv').read_text().replace('1.10','1.11'))
            third = subprocess.run(command,cwd=ROOT,text=True,capture_output=True,timeout=40)
            self.assertEqual(third.returncode,0,third.stderr)
            changed = json.loads(output.read_text())
            self.assertNotEqual(changed['study_name'],exported['study_name'])
            self.assertEqual(changed['n_trials'],1)
            self.assertEqual(changed['new_trials'],1)
            # An unsearched effective-production change still changes the namespace.
            base_config['customUnsearched']['keep'].append('changed-snapshot')
            base_file.write_text(json.dumps(base_config))
            fourth = subprocess.run(command,cwd=ROOT,text=True,capture_output=True,timeout=40)
            self.assertEqual(fourth.returncode,0,fourth.stderr)
            changed_base = json.loads(output.read_text())
            self.assertNotEqual(changed_base['study_name'],changed['study_name'])
            self.assertNotEqual(changed_base['provenance']['base_config_fingerprint'],
                                changed['provenance']['base_config_fingerprint'])
            self.assertEqual(changed_base['best_config']['customUnsearched'],base_config['customUnsearched'])
            self.assertEqual(changed_base['n_trials'],1)
            self.assertEqual(changed_base['new_trials'],1)


if __name__ == '__main__':
    unittest.main()
