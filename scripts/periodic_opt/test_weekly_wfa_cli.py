"""Weekly WFA flag is explicitly opt-in, isolated, and bypasses live service paths."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('weekly_wfa_cli',Path(__file__).with_name('run_weekly.py'))
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)

class WeeklyWfaCliTests(unittest.TestCase):
    def test_explicit_shadow_routes_to_runner_without_any_live_path(self):
        from scripts.periodic_opt import wfa_runner
        with tempfile.TemporaryDirectory() as d:
            config=Path(d)/'asset.json';config.write_text(json.dumps({'ticker':'TEST','mlGateEnabled':False}))
            argv=['run_weekly.py','--wfa-shadow','--tickers','TEST','--config-file',str(config),
                  '--output-dir',d,'--n-trials','1','--trigger-budget','1','--skip-aux','--skip-ml']
            with patch.object(w.sys,'argv',argv),patch.object(wfa_runner,'run_wfa_shadow',return_value={'status':'HOLD','apply_eligible':False}) as run,\
                 patch.object(w,'get_api_key',side_effect=AssertionError('no keys')),\
                 patch.object(w,'load_active_tickers_from_firestore',side_effect=AssertionError('no Firestore')),\
                 patch.object(w,'refresh_csvs',side_effect=AssertionError('no refresh')):
                self.assertEqual(w.main(),0)
            kw=run.call_args.kwargs
            self.assertEqual(kw['ticker'],'TEST')
            self.assertEqual(kw['n_trials'],1)
            self.assertTrue(kw['skip_aux'] and kw['skip_ml'])
            self.assertEqual(kw['output_dir'],Path(d))

    def test_shadow_refuses_implicit_live_configuration_or_mixed_protocol(self):
        for argv in (['--wfa-shadow','--tickers','TEST'],
                     ['--wfa-shadow','--tickers','TEST','--config-file','unused','--output-dir','/tmp','--evaluation-manifest','unused']):
            with self.subTest(argv=argv),patch.object(w.sys,'argv',['run_weekly.py',*argv]),patch.object(w,'get_api_key') as key:
                with self.assertRaises(SystemExit) as err:w.main()
                self.assertEqual(err.exception.code,2)
                key.assert_not_called()

if __name__=='__main__':unittest.main()
