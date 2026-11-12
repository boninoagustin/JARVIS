#!/usr/bin/env python3
import ast
import asyncio
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import ml_gate_monitor as monitor

ROOT = Path(__file__).resolve().parents[1]
AT = 2_000_000_000_000
WEEK = monitor.WEEK_MS


def asset():
    deployment = {'schemaVersion': 2, 'modelSha256': 'a'*64, 'threshold': .65, 'evidenceId': 'e'*64, 'configFingerprint': '{}'}
    return {'ticker': 'JP225', 'gateEnabled': True, 'trade': True, 'deployment': deployment,
            'configFingerprint': '{}', 'strategyFingerprint': 'b'*64, 'config': {'ticker': 'JP225'},
            'ref': {'activationId': 'request1', 'enabled': True},
            'activation': {'schemaVersion': 1, 'activationId': 'request1', 'ticker': 'JP225', 'status': 'requested',
                'source': 'dashboard_requested', 'requestedAtMs': AT-1000, 'deployment': deployment,
                'configFingerprint': '{}', 'snapshotFingerprint': '{}'}}


def result(at=AT, n=40, delta=-3, active_n=None, severe=False):
    baseline = {'n': n, 'pnlR': 10, 'mdd': 1}
    active = {'n': n if active_n is None else active_n, 'pnlR': 10+delta, 'mdd': 4 if severe else 2}
    return {'windows': {k: {'baseline': baseline.copy(), 'active': active.copy(), 'deltaR': delta}
                         for k in ('cumulative', 'recent')}, 'dataThroughMs': at-100, 'dataStale': False}


class ActivationTests(unittest.TestCase):
    def test_off_and_not_trade_do_not_replay(self):
        for key, state in [('gateEnabled', 'INACTIVE'), ('trade', 'NOT_TRADE')]:
            a = asset(); a[key] = False
            with self.assertRaises(monitor.MonitorIssue) as raised:
                monitor.validate_activation('JP225', a)
            self.assertEqual(raised.exception.state, state)

    def test_missing_record_never_infers_activation(self):
        for key in ('activation', 'ref'):
            a = asset(); a.pop(key)
            with self.assertRaises(monitor.MonitorIssue) as raised:
                monitor.validate_activation('JP225', a)
            self.assertEqual(raised.exception.state, 'NEEDS_ACTIVATION_RECORD')
        a = asset(); a['activation']['requestedAtMs'] = None
        with self.assertRaises(monitor.MonitorIssue): monitor.validate_activation('JP225', a)

    def test_exact_deployment_and_config_are_bound(self):
        self.assertEqual(monitor.validate_activation('JP225', asset())[0], 'request1')
        for mutate in (lambda a:a.update(configFingerprint='changed'),
                       lambda a:a['activation'].update(snapshotFingerprint='changed'),
                       lambda a:a.update(deployment=dict(a['deployment'], threshold=.5))):
            a = copy.deepcopy(asset()); mutate(a)
            with self.assertRaises(monitor.MonitorIssue): monitor.validate_activation('JP225', a)

    def test_archive_raw_sha_and_authoritative_provenance_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); path = root/'scripts/hyperopt/models/ml_model_JP225.json'; path.parent.mkdir(parents=True)
            model = {'meta': {'ticker': 'JP225', 'available_at_ms': AT-500, 'train_end_ms': AT-1000}}
            raw = json.dumps(model).encode(); path.write_bytes(raw)
            a = asset(); a['modelPath'] = str(path); d = dict(a['deployment'], modelSha256=hashlib.sha256(raw).hexdigest())
            with patch.object(monitor, 'ROOT', root), patch.object(monitor, 'CACHE', root/'cache'):
                archive, available = monitor.archive_model('JP225', a, d, AT)
                self.assertEqual(archive.read_bytes(), raw); self.assertEqual(available, AT-500)
                with self.assertRaises(monitor.MonitorIssue): monitor.archive_model('JP225', a, a['deployment'], AT)
                old = {'meta': {'ticker': 'JP225', 'trained_at': '2020-01-01'}}; path.write_text(json.dumps(old))
                with self.assertRaises(monitor.MonitorIssue) as raised:
                    monitor.archive_model('JP225', a, dict(d, modelSha256=hashlib.sha256(path.read_bytes()).hexdigest()), AT)
                self.assertEqual(raised.exception.state, 'MODEL_PROVENANCE_UNKNOWN')

    def test_epoch_never_backdates_and_engine_change_resets(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(monitor, 'CACHE', Path(tmp)):
            a = asset(); activation_id, record, deployment = monitor.validate_activation('JP225', a)
            e1, _ = monitor.create_epoch('JP225', activation_id, record, deployment, a, 'c'*64, Path(tmp)/'archive', AT-500, AT)
            e2, _ = monitor.create_epoch('JP225', activation_id, record, deployment, a, 'c'*64, Path(tmp)/'archive', AT-500, AT+100)
            e3, _ = monitor.create_epoch('JP225', activation_id, record, deployment, a, 'd'*64, Path(tmp)/'archive', AT-500, AT+200)
            self.assertEqual(e1['fromMs'], AT); self.assertEqual(e2['fromMs'], AT)
            self.assertNotEqual(e1['epochId'], e3['epochId']); self.assertEqual(e3['fromMs'], AT+200)
            self.assertEqual(e3['runtimeAck'], 'unknown')


class PolicyTests(unittest.TestCase):
    def test_two_weeks_and_new_closed_trades_required(self):
        first = monitor.advise(result(), {}, AT)
        self.assertEqual(first['confirmationCount'], 1)
        repeated = monitor.advise(result(AT+3600000, n=41), first, AT+3600000)
        self.assertEqual(repeated['confirmationCount'], 1)
        identical = monitor.advise(result(AT+WEEK+1), repeated, AT+WEEK+1)
        self.assertEqual(identical['confirmationCount'], 1)
        confirmed = monitor.advise(result(AT+WEEK+2, n=41), identical, AT+WEEK+2)
        self.assertEqual(confirmed['confirmationCount'], 2)
        self.assertEqual(confirmed['recommendation'], 'RECOMMEND_RECALIBRATE')
        self.assertFalse(confirmed['automaticAction']); self.assertFalse(confirmed['applyEligible'])

    def test_both_arms_must_advance_and_data_through_must_advance(self):
        first = monitor.advise(result(), {}, AT)
        one = monitor.advise(result(AT+WEEK+1, n=41, active_n=40), first, AT+WEEK+1)
        self.assertEqual(one['confirmationCount'], 1)
        stale = result(AT, n=41)
        later = monitor.advise(stale, first, AT+WEEK+1)
        self.assertNotEqual(later['recommendation'], 'RECOMMEND_RECALIBRATE')

    def test_positive_or_insufficient_breaks_streak(self):
        first = monitor.advise(result(), {}, AT)
        positive = monitor.advise(result(AT+WEEK, n=41, delta=2), first, AT+WEEK)
        self.assertEqual(positive['confirmationCount'], 0)
        again = monitor.advise(result(AT+2*WEEK, n=42), positive, AT+2*WEEK)
        self.assertEqual(again['confirmationCount'], 1)
        for altered in (result(n=29), dict(result(), dataStale=True), dict(result(), dataThroughMs=None)):
            self.assertEqual(monitor.classify(altered, AT), 'INSUFFICIENT_DATA')

    def test_severe_signal_needs_own_two_confirmations(self):
        first = monitor.advise(result(), {}, AT)
        severe = monitor.advise(result(AT+WEEK, n=41, delta=-6, severe=True), first, AT+WEEK)
        self.assertEqual(severe['confirmationCount'], 1)
        confirmed = monitor.advise(result(AT+2*WEEK, n=42, delta=-6, severe=True), severe, AT+2*WEEK)
        self.assertEqual(confirmed['recommendation'], 'RECOMMEND_DISABLE')
        self.assertFalse(confirmed['automaticAction'])

    def test_history_bounded_without_manual_refresh_flushing_counted_records(self):
        history = []
        for i in range(200):
            history = monitor.bounded_history(history, {'evaluatedAt': i, 'counted': i%10 == 0})
        self.assertLessEqual(len(history), 104)
        self.assertEqual(len([r for r in history if r['counted']]), 20)
        self.assertEqual(len([r for r in history if not r['counted']]), 40)

    def test_no_enabled_gates_scan_does_not_archive_or_replay(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(monitor, 'CACHE', Path(tmp)), patch.object(monitor, 'STATUS', Path(tmp)/'status.json'), patch.object(monitor, 'snapshot', return_value={'engineFingerprint':'f'*64, 'assets':{'JP225':{'gateEnabled':False}}}), patch.object(monitor, 'replay') as replay:
            out = monitor.refresh()
        replay.assert_not_called(); self.assertEqual(out['activeGateCount'], 0)
        self.assertEqual(out['assets']['JP225']['state'], 'INACTIVE')
        self.assertFalse(out['automaticAction'])


class CandidateTests(unittest.TestCase):
    def test_unknown_candidate_never_uses_old_retrospective_figures(self):
        self.assertEqual(monitor.compare_candidate({}, {}, Path('/tmp'), {}, AT, AT)['status'], 'unavailable')

    def test_candidate_known_only_now_never_backdates_common_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); directory = root/'epoch'; directory.mkdir()
            path = root/'data/ml_calibration/candidates/JP225-1.json'; path.parent.mkdir(parents=True)
            path.write_text(json.dumps({'meta': {'available_at_ms': AT-1000, 'train_end_ms': AT-2000}}))
            a = {'candidate': {'status':'eligible','strategyFingerprint':'b'*64,'modelPath':str(path),
                'modelSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'threshold':.5,'availableAtMs':AT-1000,
                'trainEndMs':AT-2000,'selectionAtMs':AT-500,'selectionIdentity':'e'*64}}
            epoch = {'identity':{'strategyFingerprint':'b'*64},'fromMs':AT-10000}
            with patch.object(monitor,'ROOT',root), patch.object(monitor,'replay') as replay:
                out = monitor.compare_candidate(a, epoch, directory, {'modelSha256':'a'*64}, AT-1, AT)
            replay.assert_not_called(); self.assertEqual(out['status'],'unavailable')
            self.assertEqual(json.loads((directory/('selection-'+'e'*64+'.json')).read_text())['firstSelectionObservedMs'],AT)


class APITests(unittest.TestCase):
    def test_same_origin_custom_header_and_read_only_status(self):
        tree = ast.parse((ROOT/'kronos_api/main.py').read_text())
        import re
        class HTTPException(Exception):
            def __init__(self, **kw): self.status_code=kw['status_code']
        origin = next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_ml_origin')
        env={'re':re,'HTTPException':HTTPException}
        exec(compile(ast.Module(body=[origin],type_ignores=[]),'<origin>','exec'),env)
        class Request:
            def __init__(self,headers):self.headers=headers
        for headers in ({},{'origin':'https://evil.example'},{'origin':'http://localhost:5173.evil'}):
            with self.assertRaises(HTTPException):env['_ml_origin'](Request(headers),True)
        with self.assertRaises(HTTPException):env['_ml_origin'](Request({'origin':'http://localhost:5173'}),True)
        env['_ml_origin'](Request({'origin':'http://localhost:5173','x-jarvis-ml':'recalibrate'}),True)
        node=next(n for n in tree.body if isinstance(n,ast.AsyncFunctionDef) and n.name=='ml_gate_monitor_status')
        text=ast.unparse(node)
        self.assertNotIn('Popen',text);self.assertNotIn('setDoc',text)

    def test_timer_weekly_utc_persistent_no_order_service(self):
        timer=(ROOT/'scripts/ops/jarvis-ml-gate-monitor.timer').read_text()
        service=(ROOT/'scripts/ops/jarvis-ml-gate-monitor.service').read_text()
        self.assertIn('Mon *-*-* 09:00:00 UTC',timer);self.assertIn('Persistent=true',timer)
        self.assertIn('ml_gate_monitor.py refresh',service);self.assertNotIn('pm2',service)


if __name__=='__main__':
    unittest.main()
