#!/usr/bin/env python3
import ast
import asyncio
import copy
import contextlib
import io
import hashlib
import fcntl
import sys
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


SOURCE_FILES = [{'path': '/opt/JARVIS/scripts/ml_active_monitor.ts', 'sha256': 'f'*64}]
ENGINE_FP = hashlib.sha256(json.dumps(SOURCE_FILES, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def replay_params(from_ms=AT-2*WEEK, to_ms=AT-1):
    return {'ticker': 'JP225', 'activationId': 'request1', 'modelSha256': 'a'*64, 'threshold': .65,
            'engineFingerprint': ENGINE_FP, 'configFingerprint': 'b'*64,
            'fromMs': from_ms, 'toMs': to_ms, 'recentFromMs': max(from_ms, to_ms-monitor.RECENT_MS),
            'modelPath': '/tmp/archived-model.json', 'config': {'ticker': 'JP225'}, 'dataDir': '/tmp/history'}


def engine_result(params, at=AT, delta=-3, n=40):
    baseline = {'n': n, 'pnlR': 10, 'mdd': 1, 'wr': 50, 'pf': 2}
    active = dict(baseline, pnlR=10+delta, mdd=2)
    windows = {}; proofs = {}
    for name, start in (('cumulative', params['fromMs']), ('recent', max(params['fromMs'], params['toMs']-monitor.RECENT_MS))):
        windows[name] = {'fromMs': start, 'toMs': params['toMs'], 'baseline': baseline.copy(), 'active': active.copy(),
                         'deltaR': delta, 'status': 'sufficient' if n >= 30 else 'insufficient'}
        for enabled, metric in ((False, baseline), (True, active)):
            proofs[(start, enabled)] = {'fromMs': start, 'toMs': params['toMs'], 'metrics': metric.copy(),
                'gateVerified': enabled, 'modelSha256': params['modelSha256'] if enabled else None,
                'threshold': params['threshold'] if enabled else None,
                'terminalMs': params['toMs']-1, 'warmupStartMs': start-1000}
    body = {'schemaVersion': 1, 'scope': 'post_activation_replay', 'status': 'valid',
            **{k: params[k] for k in ('ticker','activationId','modelSha256','threshold','engineFingerprint','configFingerprint')},
            'evaluatedAt': at, 'dataThroughMs': params['toMs']-1, 'dataStale': False,
            'automaticAction': False, 'applyEligible': False,
            'rules': {'version': 1, 'minimumCompletedPerArm': 30}, 'windows': windows,
            'gateProofs': list(proofs.values()),
            'provenance': {'datasetFiles': [{'path': f'/tmp/history/{i}.csv', 'sha256': 'a'*64} for i in range(5)],
                           'sourceFiles': SOURCE_FILES, 'auxiliaryFiles': [],
                           'engineFingerprint': params['engineFingerprint'], 'configFingerprint': params['configFingerprint']}}
    body['baseSignal'] = monitor.classify(body, at)
    return body


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


class ReplayBoundaryTests(unittest.TestCase):
    def test_exact_result_with_reused_same_windows_is_valid(self):
        params = replay_params()
        self.assertTrue(monitor.validate_result(engine_result(params), params, AT))
        self.assertEqual(len(engine_result(params)['gateProofs']), 2)
        wide = replay_params(AT-6*WEEK)
        self.assertTrue(monitor.validate_result(engine_result(wide), wide, AT))
        self.assertEqual(len(engine_result(wide)['gateProofs']), 4)

    def test_context_provenance_metrics_and_future_data_fail_closed(self):
        params = replay_params()
        changes = [lambda r:r.update(ticker='EURUSD'), lambda r:r.update(activationId='another'),
                   lambda r:r.update(scope='retrospective_validation'), lambda r:r.update(automaticAction=True),
                   lambda r:r.update(evaluatedAt=AT+1), lambda r:r.update(dataThroughMs=AT+1),
                   lambda r:r['windows']['cumulative'].update(fromMs=params['fromMs']+1),
                   lambda r:r['windows']['recent'].update(deltaR=100),
                   lambda r:r['windows']['cumulative']['active'].update(pnlR=float('nan')),
                   lambda r:r['provenance'].update(datasetFiles=[]),
                   lambda r:r['provenance'].update(sourceFiles=[{'path':'another.ts','sha256':'f'*64}]),
                   lambda r:r['gateProofs'][1].update(gateVerified=False),
                   lambda r:r['gateProofs'][1].update(threshold=.5),
                   lambda r:r['gateProofs'][1].update(warmupStartMs=params['fromMs']),
                   lambda r:r.update(baseSignal='MAINTAIN')]
        for change in changes:
            body = copy.deepcopy(engine_result(params)); change(body)
            with self.assertRaises(monitor.MonitorIssue): monitor.validate_result(body, params, AT)
        unavailable = dict(engine_result(params), status='unavailable')
        self.assertFalse(monitor.validate_result(unavailable, params, AT))

    def test_real_engine_cli_flag_with_unknown_provenance_never_fits(self):
        # This executes the actual CLI on temporary metadata. No broker/config/model
        # writes and no training: the engine rejects legacy provenance before replay.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); path = root/'model.json'
            raw = json.dumps({'meta': {'ticker':'MONITORTEST','trained_at':'2020-01-01'}}).encode()
            path.write_bytes(raw)
            at = monitor.now()
            params = {'ticker':'MONITORTEST','activationId':'fixture','modelPath':str(path),
                      'modelSha256':hashlib.sha256(raw).hexdigest(),'threshold':.573,'config':{'ticker':'MONITORTEST'},
                      'fromMs':at-10000,'toMs':at-1,'recentFromMs':at-10000,'dataDir':str(root)}
            body = monitor.replay(params)
        self.assertEqual(body['status'], 'unavailable')
        self.assertEqual(body['reasonCode'], 'MODEL_PROVENANCE_UNKNOWN')
        self.assertFalse(body['automaticAction'])

    def test_unknown_and_prestart_history_are_not_zero_pnl(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); a=asset(); a['dataAvailableToMs']=AT-1
            with patch.object(monitor,'CACHE',root), patch.object(monitor,'archive_model',return_value=(root/'model.json',AT-500)), patch.object(monitor,'replay') as replay:
                row=monitor.assess_asset('JP225',a,ENGINE_FP,AT)
            replay.assert_not_called(); self.assertEqual(row['state'],'NO_DATA')
            self.assertNotIn('assessment',row)

    def test_epoch_clock_or_regressing_history_never_inherits_confirmation(self):
        first=monitor.advise(result(),{},AT,'epoch-one')
        next_week=monitor.advise(result(AT+WEEK,n=41),first,AT+WEEK,'epoch-one')
        self.assertEqual(next_week['confirmationCount'],2)
        other=monitor.advise(result(AT+2*WEEK,n=42),next_week,AT+2*WEEK,'epoch-two')
        self.assertEqual(other['confirmationCount'],1)
        backwards=monitor.advise(result(n=42),next_week,AT,'epoch-one')
        self.assertEqual(backwards['confirmationCount'],1)
        truncated=monitor.advise(result(AT+2*WEEK,n=39),next_week,AT+2*WEEK,'epoch-one')
        self.assertEqual(truncated['confirmationCount'],1)
        self.assertEqual(monitor.classify(dict(result(),dataThroughMs=AT+1),AT),'INSUFFICIENT_DATA')


class AssessmentCommitTests(unittest.TestCase):
    def fixture(self, root):
        a=asset();a['activation']['requestedAtMs']=AT-2*WEEK
        path=root/'scripts/hyperopt/models/ml_model_JP225.json';path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'meta':{'ticker':'JP225','available_at_ms':AT-3*WEEK,'train_end_ms':AT-4*WEEK}}))
        a['modelPath']=str(path);a['deployment']['modelSha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        a['dataAvailableToMs']=AT-1;a['dataDir']=str(root/'history')
        archive=root/'cache/models'/f"{a['deployment']['modelSha256']}.json"
        epoch,directory=monitor.create_epoch('JP225','request1',a['activation'],a['deployment'],a,ENGINE_FP,archive,AT-3*WEEK,AT-2*WEEK)
        return a,epoch,directory

    def test_main_vs_candidate_changed_snapshot_is_hidden(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            with patch.object(monitor,'ROOT',root),patch.object(monitor,'CACHE',root/'cache'),patch.object(monitor,'now',return_value=AT):
                a,e,d=self.fixture(root)
                def triple(*args):
                    p=replay_params(e['fromMs'],AT-1);body=engine_result(p)
                    provenance=copy.deepcopy(body['provenance']);provenance['datasetFiles'][0]['sha256']='c'*64
                    return {'status':'valid','toMs':AT-1,'engineFingerprint':ENGINE_FP,'configFingerprint':'b'*64,'provenance':provenance}
                with patch.object(monitor,'snapshot',return_value={'assets':{'JP225':a}}),patch.object(monitor,'replay',side_effect=engine_result),patch.object(monitor,'compare_candidate',side_effect=triple):
                    row=monitor.assess_asset('JP225',a,ENGINE_FP,AT)
                self.assertEqual(row['state'],'ASSESSED')
                self.assertEqual(row['candidateComparison']['status'],'unavailable')
                self.assertNotIn('candidate',row['candidateComparison'])
                self.assertEqual(row['confirmationCount'],1)
                self.assertEqual(row['confirmationState']['epochId'],e['epochId'])

    def test_changed_activation_during_replay_never_commits_confirmation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            with patch.object(monitor,'ROOT',root),patch.object(monitor,'CACHE',root/'cache'),patch.object(monitor,'now',return_value=AT):
                a,e,d=self.fixture(root);latest=copy.deepcopy(a)
                latest['ref']['activationId']='request2';latest['activation']['activationId']='request2'
                with patch.object(monitor,'snapshot',return_value={'assets':{'JP225':latest}}),patch.object(monitor,'replay',side_effect=engine_result),patch.object(monitor,'compare_candidate',return_value={'status':'unavailable'}):
                    with self.assertRaises(monitor.MonitorIssue):monitor.assess_asset('JP225',a,ENGINE_FP,AT)
                self.assertFalse((d/'state.json').exists())

    def test_other_ml_job_holding_shared_lock_never_assesses_or_confirms(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock=Path(tmp)/'shared.lock'
            with lock.open('a') as held:
                fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with patch.object(monitor,'SHARED_LOCK',lock),patch.object(sys,'argv',['monitor','refresh']),patch.object(monitor,'refresh') as refresh:
                    self.assertEqual(monitor.main(),3)
                refresh.assert_not_called()


    def test_timer_waits_for_shared_lock_instead_of_skipping_week(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock=Path(tmp)/'shared.lock';out=io.StringIO()
            body={'state':'IDLE','assets':{},'activeGateCount':0,'updatedAt':AT}
            with patch.object(monitor,'SHARED_LOCK',lock),patch.object(sys,'argv',['monitor','refresh','--wait-lock']),patch.object(monitor.fcntl,'flock') as flock,patch.object(monitor,'refresh',return_value=body) as refresh,contextlib.redirect_stdout(out):
                self.assertEqual(monitor.main(),0)
            self.assertEqual(flock.call_args.args[1],fcntl.LOCK_EX)
            refresh.assert_called_once()
            self.assertEqual(json.loads(out.getvalue())['state'],'IDLE')


class ForwardTripleTests(unittest.TestCase):
    def fixture(self, root):
        directory=root/'epoch';directory.mkdir()
        path=root/'data/ml_calibration/candidates/JP225-1.json';path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'meta':{'available_at_ms':AT-4*WEEK,'train_end_ms':AT-5*WEEK}}))
        info={'status':'eligible','strategyFingerprint':'b'*64,'modelPath':str(path),
              'modelSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'threshold':.5,
              'availableAtMs':AT-4*WEEK,'trainEndMs':AT-5*WEEK,'selectionAtMs':AT-3*WEEK,'selectionIdentity':'e'*64}
        (directory/('selection-'+'e'*64+'.json')).write_text(json.dumps({'selectionIdentity':'e'*64,'firstSelectionObservedMs':AT-2*WEEK}))
        epoch={'identity':{'strategyFingerprint':'b'*64,'activationId':'request1','engineFingerprint':ENGINE_FP},
               'epochId':'c'*64,'fromMs':AT-6*WEEK,'config':{'ticker':'JP225'},'modelArchive':str(root/'active.json')}
        return {'ticker':'JP225','dataDir':str(root/'history'),'candidate':info},epoch,directory

    def run_fixture(self, change=None, n=40):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); a,e,d=self.fixture(root);calls=[]
            def replay(params):
                calls.append(params)
                body=engine_result(params,delta=2 if params['modelSha256']==a['candidate']['modelSha256'] else -3,n=n)
                if len(calls)==2 and change: change(body)
                return body
            with patch.object(monitor,'ROOT',root),patch.object(monitor,'CACHE',root/'cache'),patch.object(monitor,'now',return_value=AT),patch.object(monitor,'replay',side_effect=replay):
                out=monitor.compare_candidate(a,e,d,{'modelSha256':'a'*64,'threshold':.65},AT-1,AT)
            return out,calls

    def test_common_forward_window_three_arms_are_bound_without_any_replacement(self):
        out,calls=self.run_fixture()
        self.assertEqual(out['status'],'valid')
        self.assertEqual(out['fromMs'],AT-2*WEEK)
        self.assertEqual(out['deltaActiveR'],-3);self.assertEqual(out['deltaCandidateR'],2)
        self.assertEqual(calls[0]['fromMs'],calls[1]['fromMs'])
        self.assertEqual(calls[0]['toMs'],calls[1]['toMs'])
        self.assertFalse(out['automaticAction']);self.assertFalse(out['applyEligible'])
        self.assertEqual(out['activeEpochId'],'c'*64)

    def test_three_arm_insufficient_sample_and_context_changes_never_make_figures_up(self):
        out,_=self.run_fixture(n=29);self.assertEqual(out['status'],'insufficient')
        for change in [lambda b:b.update(ticker='EURUSD'),lambda b:b.update(activationId='stale'),
                       lambda b:b['provenance']['datasetFiles'][0].update(sha256='c'*64),
                       lambda b:b['provenance'].update(auxiliaryFiles=[{'path':'forecast.json','sha256':'f'*64}]),
                       lambda b:b['windows']['cumulative']['baseline'].update(pnlR=999),
                       lambda b:b['gateProofs'][1].update(modelSha256='f'*64)]:
            out,_=self.run_fixture(change)
            self.assertEqual(out['status'],'unavailable',out)
            self.assertNotIn('candidate',out)


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
        self.assertIn('ml_gate_monitor.py refresh --wait-lock',service);self.assertNotIn('pm2',service)
        self.assertNotIn('SuccessExitStatus=3',service)


if __name__=='__main__':
    unittest.main()
