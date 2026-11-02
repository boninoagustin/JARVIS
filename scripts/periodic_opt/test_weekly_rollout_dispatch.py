"""Offline dispatch contracts: fixtures never deploy, production weekly deploys per ticker."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('rollout_weekly',Path(__file__).with_name('run_weekly.py'))
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class DispatchTests(unittest.TestCase):
 def test_real_weekly_dispatches_explicit_authorized_rollout(self):
  self.assertTrue(callable(getattr(w,'weekly_rollout_command',None)), 'weekly main needs the automatic deployment boundary')
  cmd=w.weekly_rollout_command('EURUSD',Path('/tmp/reports'),followup_only=False)
  self.assertIn('--weekly-rollout',cmd);self.assertIn('--skip-followup',cmd)
  self.assertEqual(cmd[cmd.index('--tickers')+1],'EURUSD')
  review=w.weekly_rollout_command('EURUSD',Path('/tmp/reports'),followup_only=True)
  self.assertIn('--followup-only',review)
 def test_fixture_modes_are_no_write_even_with_global_enable(self):
  self.assertTrue(callable(getattr(w,'weekly_rollout_allowed',None)))
  from types import SimpleNamespace
  for flag in ('verification','config_file','output_dir','wfa_shadow','no_apply'):
   args=SimpleNamespace(verification=False,config_file=None,output_dir=None,wfa_shadow=False,no_apply=False)
   setattr(args,flag,True)
   self.assertFalse(w.weekly_rollout_allowed(args),flag)
  self.assertTrue(w.weekly_rollout_allowed(SimpleNamespace(verification=False,config_file=None,output_dir=None,wfa_shadow=False,no_apply=False)))
class ProductionMainDispatchTests(unittest.TestCase):
 def test_real_main_reviews_before_snapshot_and_deploys_after_saved_report(self):
  import json,tempfile
  from types import SimpleNamespace
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);reports=root/'reports';opt=root/'opt';events=[]
   def command(cmd,**kw):
    self.assertIn('--snapshot-only',cmd)
    events.append('snapshot')
    Path(cmd[cmd.index('--snapshot-out')+1]).write_text(json.dumps({'enabled':True}))
    Path(cmd[cmd.index('--manifest-out')+1]).write_text(json.dumps({'test_end_ms':1000}))
    return {'config':{'ticker':'EURUSD','enabled':True}}
   def subprocess_run(cmd,**kw):
    self.assertIn('--weekly-rollout',cmd)
    if '--followup-only' in cmd:events.append('followup')
    else:
     events.append('deploy')
     self.assertIn('--skip-followup',cmd)
     saved=json.loads((reports/'EURUSD.json').read_text())
     self.assertEqual(saved['status'],'RECOMMEND')
     self.assertEqual(saved['production_backtest_config']['ticker'],'EURUSD')
    return SimpleNamespace(returncode=0,stdout='{}',stderr='')
   def certify(report,*args,**kwargs):report['status']='RECOMMEND'
   argv=['run_weekly.py','--tickers','EURUSD','--skip-fetch','--skip-refresh','--skip-hyperopt','--skip-timesfm','--skip-aux','--skip-ml','--skip-telemetry','--force']
   with patch.object(w,'AUTO_APPLY_ENABLED',True),patch.object(w,'REPORTS_DIR',reports),patch.object(w,'OPT_OUT_DIR',opt),patch.object(w.sys,'argv',argv),patch.object(w,'get_api_key',return_value='synthetic-fixture-not-a-secret'),patch.object(w,'count_new_trades',return_value=100),patch.object(w,'command_json',side_effect=command),patch.object(w,'canonicalize_result',side_effect=lambda x:x),patch.object(w,'certify_report',side_effect=certify),patch.object(w,'run_dsr_gate',return_value={}),patch.object(w.subprocess,'run',side_effect=subprocess_run):
    self.assertEqual(w.main(),0)
   self.assertEqual(events,['followup','snapshot','deploy'])

if __name__=='__main__':unittest.main()
