"""No network/systemd/production writes: synthetic cycle receipts + shell integration."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timezone

import weekly_cycle_state as w

HERE = Path(__file__).resolve().parent

class CycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='jarvis-cycle-test-')
        self.root = Path(self.tmp.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.summary = self.root / 'summary.json'
        self.progress = self.root / 'progress.json'
        self.now = int(time.time() * 1000)
        self.start = self.now - 60000
        self.ctx = dict(version=1, week=w.week_of(self.start), run_id=str(uuid.uuid4()),
                        started_at=self.start, tickers=['EURUSD', 'USDCAD'], invocation_id='fixture')
        self.s = dict(version=1, cycle_week=self.ctx['week'], cycle_run_id=self.ctx['run_id'],
                      started_at=self.start, completed_at=self.now - 1000, status='completed',
                      tickers=self.ctx['tickers'], errors=[], error=None,
                      counts=dict(evaluated=2, skipped=0, failed=0),
                      outcomes=[dict(ticker=t, timestamp=self.start+1000, outcome='evaluated', status='HOLD') for t in self.ctx['tickers']])
        self.save()
    def tearDown(self):
        self.tmp.cleanup()
    def save(self):
        w.atomic_json(self.state / 'weekly_cycle_context.json', self.ctx)
        w.atomic_json(self.summary, self.s)
    def receipt(self):
        proof = w.summary_evidence(self.ctx, self.summary, self.now)
        w.atomic_json(self.state / ('weekly_python_done_' + self.ctx['week']), proof)
        return proof
    def plan(self, week=None):
        return w.plan(self.state, self.summary, self.progress, week or self.ctx['week'], self.now)
    def chain(self, **overrides):
        env = dict(os.environ, MARK_DIR=str(self.state), CONT_DIR=str(self.state),
                   WEEKLY_SUMMARY=str(self.summary), TUNE_START_CMD='true', INVOCATION_ID='fixture')
        env.update(overrides)
        return subprocess.run(['bash', str(HERE/'chain_mark_and_tune.sh')], env=env, capture_output=True, text=True)
    def test_exact_receipt_valid(self):
        self.receipt()
        self.assertEqual(w.verify(self.state, self.summary, self.now), self.ctx)
    def test_empty_legacy_pydone_never_proves_completion(self):
        (self.state / ('weekly_python_done_' + self.ctx['week'])).touch()
        with self.assertRaises(ValueError): w.verify(self.state, self.summary, self.now)
        self.assertEqual(self.plan()[0], 'run')
    def test_legacy_w47_marker_does_not_skip_new_week(self):
        (self.state/'weekly_cycle_context.json').unlink()
        (self.state/'weekly_cycle_last').write_text('2026-W46\n')
        (self.state/'weekly_python_done_2026-W47').touch()
        self.assertEqual(self.plan('2026-W47')[0], 'new')
    def test_py_completed_post_retry_reuses_identity(self):
        self.receipt()
        action, c = self.plan()
        self.assertEqual((action, c['run_id']), ('posts', self.ctx['run_id']))
    def test_sealed_same_week_skip_requires_receipt(self):
        self.receipt()
        (self.state/'weekly_cycle_last').write_text(self.ctx['week'])
        self.assertEqual(self.plan()[0], 'skip')
        self.summary.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'sealed cycle'): self.plan()
    def test_marker_cannot_downgrade_to_an_older_context(self):
        self.receipt()
        (self.state/'weekly_cycle_last').write_text('2099-W01')
        with self.assertRaises(ValueError): self.plan('2099-W01')
    def test_future_marker_without_context_rejected(self):
        (self.state/'weekly_cycle_context.json').unlink()
        (self.state/'weekly_cycle_last').write_text('2099-W01')
        with self.assertRaises(ValueError): self.plan()
    def test_deployment_error_prevents_receipt(self):
        self.s['outcomes'][0]['deployment_error']='write uncertain'; self.save()
        with self.assertRaises(ValueError): self.receipt()
    def test_corrupt_context_fails_closed(self):
        (self.state/'weekly_cycle_context.json').write_text('{')
        with self.assertRaises(ValueError): self.plan()
    def test_missing_context_current_seal_rejected(self):
        (self.state/'weekly_cycle_context.json').unlink()
        (self.state/'weekly_cycle_last').write_text(self.ctx['week'])
        with self.assertRaisesRegex(ValueError, 'legacy seal'): self.plan()
    def test_summary_other_run_rejected(self):
        self.s['cycle_run_id'] = str(uuid.uuid4()); self.save()
        with self.assertRaises(ValueError): self.receipt()
    def test_missing_usdcad_rejected(self):
        self.s['tickers'] = ['EURUSD']; self.save()
        with self.assertRaisesRegex(ValueError, 'roster'): self.receipt()
    def test_duplicate_outcomes_rejected(self):
        self.s['outcomes'][1] = copy.deepcopy(self.s['outcomes'][0]); self.save()
        with self.assertRaises(ValueError): self.receipt()
    def test_outcome_outside_cycle_rejected(self):
        self.s['outcomes'][0]['timestamp'] = self.start-1; self.save()
        with self.assertRaises(ValueError): self.receipt()
    def test_error_or_incomplete_summary_rejected(self):
        for field, val in [('status', 'running'), ('errors', ['USDCAD']), ('counts', dict(evaluated=1,skipped=0,failed=0))]:
            original = self.s[field]; self.s[field] = val; self.save()
            with self.assertRaises(ValueError): self.receipt()
            self.s[field] = original
    def test_summary_changed_after_receipt_rejected(self):
        self.receipt(); self.s['outcomes'][0]['status'] = 'HOLD_MC'; self.save()
        with self.assertRaisesRegex(ValueError, 'receipt'): w.verify(self.state,self.summary,self.now)
    def test_validated_all_skips_are_allowed(self):
        self.s['counts'] = dict(evaluated=0,skipped=2,failed=0)
        for x in self.s['outcomes']: x['outcome'] = 'skipped'
        self.save(); self.receipt()
    def test_cross_week_resume_retains_original_week(self):
        self.ctx['started_at'] = self.now - 8*86400000
        self.ctx['week'] = w.week_of(self.ctx['started_at']); self.save()
        w.atomic_json(self.progress, dict(started_at=self.ctx['started_at'], cycle_run_id=self.ctx['run_id'], cycle_week=self.ctx['week'], done=['EURUSD']))
        action,c = self.plan(w.week_of(self.now))
        self.assertEqual(action, 'resume'); self.assertEqual(c['week'],self.ctx['week'])
    def test_unbound_resume_rejected(self):
        w.atomic_json(self.progress,dict(started_at=self.start,done=['EURUSD']))
        with self.assertRaisesRegex(ValueError, 'not bound'): self.plan()
    def test_future_context_rejected(self):
        self.ctx['started_at'] = self.now+120000; self.ctx['week'] = w.week_of(self.ctx['started_at']); self.save()
        with self.assertRaises(ValueError): self.plan()
    def test_chain_without_proof_never_seals_or_enqueues(self):
        (self.state/'weekly_cycle_week').write_text(self.ctx['week'])
        p=self.chain(); self.assertNotEqual(p.returncode,0)
        self.assertFalse((self.state/'weekly_cycle_last').exists())
        self.assertFalse((self.state/'weekly_continuation.json').exists())
    def test_chain_ignores_stale_sidecar_uses_exact_identity(self):
        self.receipt(); (self.state/'weekly_cycle_week').write_text('2026-W01')
        p=self.chain(); self.assertEqual(p.returncode,0,p.stderr+p.stdout)
        self.assertEqual((self.state/'weekly_cycle_last').read_text().strip(),self.ctx['week'])
        c=w.read_json(self.state/'weekly_continuation.json'); self.assertEqual(c['runId'],self.ctx['run_id'])
    def test_chain_rejects_other_invocation(self):
        self.receipt(); p=self.chain(INVOCATION_ID='other')
        self.assertNotEqual(p.returncode,0); self.assertFalse((self.state/'weekly_cycle_last').exists())
    def test_chain_duplicate_delivery_does_not_create_new_run(self):
        self.receipt(); self.assertEqual(self.chain().returncode,0)
        c=w.read_json(self.state/'weekly_continuation.json'); c['state']='completed'
        w.atomic_json(self.state/'weekly_continuation.json',c)
        self.assertEqual(self.chain(TUNE_START_CMD='false').returncode,0)
        self.assertEqual(w.read_json(self.state/'weekly_continuation.json'),c)
    def test_chain_does_not_overwrite_unconsumed_other_run(self):
        self.receipt(); w.atomic_json(self.state/'weekly_continuation.json',dict(runId='other',state='started'))
        self.assertNotEqual(self.chain().returncode,0)
        self.assertEqual(w.read_json(self.state/'weekly_continuation.json')['runId'],'other')

class RunnerIdentityTests(unittest.TestCase):
    def run_case(self, *, bad_progress=False, bad_roster=False):
        import run_weekly as runner
        from unittest.mock import patch
        with tempfile.TemporaryDirectory(prefix='jarvis-runner-identity-') as td:
            root=Path(td); state=root/'state'; state.mkdir(); out=root/'out'
            now=int(time.time()*1000)
            c=dict(version=1,week=w.week_of(now),run_id=str(uuid.uuid4()),started_at=now,tickers=['EURUSD','USDCAD'])
            w.atomic_json(state/'weekly_cycle_context.json',c)
            if bad_progress:
                out.mkdir(); w.atomic_json(out/'weekly_progress.json',dict(started_at=now,cycle_run_id='other',cycle_week=c['week'],done=['EURUSD']))
            argv=['run_weekly.py','--tickers','EURUSD' if bad_roster else 'EURUSD,USDCAD','--skip-fetch','--skip-hyperopt','--skip-telemetry']
            if bad_progress: argv.append('--resume')
            with patch.dict(os.environ,{'JARVIS_WEEKLY_CONTEXT':str(state/'weekly_cycle_context.json')}), patch.object(runner.sys,'argv',argv), patch.object(runner,'REPORTS_DIR',root/'reports'), patch.object(runner,'OPT_OUT_DIR',out), patch.object(runner,'get_api_key',side_effect=RuntimeError('fixture stops before network')) as api:
                if bad_progress or bad_roster:
                    with self.assertRaises(ValueError): runner.main()
                    api.assert_not_called()
                else:
                    with self.assertRaisesRegex(RuntimeError,'fixture stops before network'): runner.main()
                    for name in ('weekly_progress.json','weekly_selection_summary.json'):
                        d=w.read_json(out/name)
                        self.assertEqual(d['cycle_run_id'],c['run_id'])
                        self.assertEqual(d['cycle_week'],c['week'])
                        self.assertEqual(d['started_at'],c['started_at'])
    def test_real_runner_propagates_context_before_network(self): self.run_case()
    def test_real_runner_rejects_wrong_resume_identity(self): self.run_case(bad_progress=True)
    def test_real_runner_rejects_different_roster(self): self.run_case(bad_roster=True)

class GuardTests(unittest.TestCase):
    def test_guard_calls_runner_then_verifies_and_only_then_skips(self):
        with tempfile.TemporaryDirectory(prefix='jarvis-guard-test-') as td:
            root=Path(td); repo=root/'repo'; scripts=repo/'scripts'/'periodic_opt'; out=scripts/'opt_out'; out.mkdir(parents=True)
            state=root/'state'; state.mkdir()
            (scripts/'weekly_cycle_state.py').symlink_to(HERE/'weekly_cycle_state.py')
            (scripts/'run_weekly.py').write_text('fixture placeholder')
            fake=root/'fake-python'
            fake.write_text('''#!/usr/bin/env python3
import json,os,pathlib,time
c=json.loads(pathlib.Path(os.environ['JARVIS_WEEKLY_CONTEXT']).read_text())
p=pathlib.Path(os.environ['REPO'])/'scripts/periodic_opt/opt_out/weekly_selection_summary.json'
now=int(time.time()*1000)
s=dict(version=1,cycle_run_id=c['run_id'],cycle_week=c['week'],started_at=c['started_at'],completed_at=now,status='completed',errors=[],error=None,tickers=c['tickers'],counts=dict(evaluated=len(c['tickers']),skipped=0,failed=0),outcomes=[dict(ticker=t,timestamp=now,status='HOLD',outcome='evaluated') for t in c['tickers']])
p.write_text(json.dumps(s))
pathlib.Path(os.environ['REPO'],'called').touch()
''')
            fake.chmod(0o755)
            env=dict(os.environ,REPO=str(repo),MARK_DIR=str(state),WEEKLY_LOCK=str(root/'lock'),SCOUT_STATE_OVERRIDE='inactive',WEEKLY_ROSTER_JSON='["EURUSD","USDCAD"]',WEEKLY_PYTHON=str(fake),INVOCATION_ID='fixture')
            # Exact regression: unbound empty done marker from an older resumed cycle.
            week=w.week_of(int(time.time()*1000)); (state/('weekly_python_done_'+week)).touch()
            (state/'weekly_cycle_week').write_text('2026-W46')
            cmd=['bash',str(HERE/'run_weekly_guard.sh'),'--run']
            p=subprocess.run(cmd,env=env,capture_output=True,text=True)
            self.assertEqual(p.returncode,0,p.stderr+p.stdout)
            self.assertTrue((repo/'called').exists())
            c=w.read_json(state/'weekly_cycle_context.json'); self.assertEqual(c['week'],week)
            self.assertEqual(w.verify(state,out/'weekly_selection_summary.json',int(time.time()*1000))['run_id'],c['run_id'])
            # Valid post-only retry updates invocation binding, not the stable cycle identity.
            env['INVOCATION_ID']='retry'
            p=subprocess.run(cmd,env=env,capture_output=True,text=True)
            self.assertEqual(p.returncode,0,p.stderr+p.stdout); self.assertIn('sólo postprocesos',p.stdout)
            self.assertEqual(w.read_json(state/'weekly_cycle_context.json')['invocation_id'],'retry')
            self.assertEqual(w.read_json(state/'weekly_cycle_context.json')['run_id'],c['run_id'])
            (state/'weekly_cycle_last').write_text(week)
            p=subprocess.run(cmd,env=env,capture_output=True,text=True)
            self.assertNotEqual(p.returncode,0); self.assertIn('skip:',p.stdout)
            p=subprocess.run(['bash',str(HERE/'run_weekly_guard.sh'),'--condition'],env=env,capture_output=True,text=True)
            self.assertNotEqual(p.returncode,0); self.assertIn('skip:',p.stdout)
    def test_invalid_evidence_is_failure_not_a_silent_execcondition_skip(self):
        with tempfile.TemporaryDirectory(prefix='jarvis-guard-test-') as td:
            root=Path(td); scripts=root/'scripts/periodic_opt'; scripts.mkdir(parents=True); state=root/'state'; state.mkdir()
            (scripts/'weekly_cycle_state.py').symlink_to(HERE/'weekly_cycle_state.py')
            (state/'weekly_cycle_context.json').write_text('{invalid')
            env=dict(os.environ,REPO=str(root),MARK_DIR=str(state),WEEKLY_LOCK=str(root/'lock'),SCOUT_STATE_OVERRIDE='inactive',WEEKLY_ROSTER_JSON='["EURUSD"]',WEEKLY_PYTHON='/bin/true')
            p=subprocess.run(['bash',str(HERE/'run_weekly_guard.sh'),'--condition'],env=env,capture_output=True,text=True)
            self.assertEqual(p.returncode,0,p.stderr+p.stdout)
            self.assertIn('run-required:',p.stdout)
            p=subprocess.run(['bash',str(HERE/'run_weekly_guard.sh'),'--run'],env=env,capture_output=True,text=True)
            self.assertNotEqual(p.returncode,0)
            self.assertFalse(list(state.glob('weekly_python_done_*')))
    def test_exit_zero_without_summary_has_no_receipt(self):
        with tempfile.TemporaryDirectory(prefix='jarvis-guard-test-') as td:
            root=Path(td); scripts=root/'scripts/periodic_opt'; scripts.mkdir(parents=True); state=root/'state'; state.mkdir()
            (scripts/'weekly_cycle_state.py').symlink_to(HERE/'weekly_cycle_state.py')
            env=dict(os.environ,REPO=str(root),MARK_DIR=str(state),WEEKLY_LOCK=str(root/'lock'),SCOUT_STATE_OVERRIDE='inactive',WEEKLY_ROSTER_JSON='["EURUSD"]',WEEKLY_PYTHON='/bin/true',INVOCATION_ID='fixture')
            p=subprocess.run(['bash',str(HERE/'run_weekly_guard.sh'),'--run'],env=env,capture_output=True,text=True)
            self.assertNotEqual(p.returncode,0)
            self.assertFalse(list(state.glob('weekly_python_done_*')))

if __name__ == '__main__': unittest.main()
