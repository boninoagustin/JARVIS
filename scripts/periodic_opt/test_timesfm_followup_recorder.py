"""Offline contract tests; synthetic HTTP envelopes never touch production."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).with_name('timesfm_followup_recorder.py')


def load_module():
    if not MODULE.exists():
        raise AssertionError('live observation recorder does not exist')
    spec = importlib.util.spec_from_file_location('timesfm_followup_recorder', MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.reports = self.root / 'reports'
        (self.reports / 'rollouts').mkdir(parents=True)
        self.logs = self.root / 'logs'
        self.path = self.logs / 'usdjpy/forecasts/live_followup_ledger.jsonl'
        self.now = 1800000000000
        self.calls = []
        self.responses = {}
        self.track = {
            'ticker': 'USDJPY',
            'beforeAsset': {'timesfm': {'enabled': True}},
            'appliedAsset': {'timesfm': {'enabled': False}},
            'live_forecast_ledger': {
                'path': str(self.path), 'model_version': 'test-native-v2',
                'registered_at_ms': self.now - 1000,
                'prefix_sha256': __import__('hashlib').sha256(b'').hexdigest(),
                'prefix_size_bytes': 0,
            },
        }
        self.save_track()

    def save_track(self):
        (self.reports / 'rollouts/USDJPY_week.json').write_text(json.dumps(self.track))

    def envelope(self, tf):
        return {
            'ticker': 'usdjpy', 'tf': tf, 'schema_version': 2,
            'timestamp_convention': 'context_close_ms_v2',
            'ts': self.now - self.now % (tf * 60000) - tf * 60000,
            'contextCloseTimeMs': self.now - self.now % (tf * 60000) - tf * 60000,
            'computedAt': self.now - 20, 'availableAt': self.now - 10,
            'model_version': 'test-native-v2', 'horizon': 2,
            'point': [149.1, 149.2], 'q10': [149.0, 149.1],
            'q50': [149.1, 149.2], 'q90': [149.2, 149.3],
        }

    def opener(self, url, timeout):
        from urllib.parse import parse_qs, urlsplit
        self.calls.append(url)
        tf = int(parse_qs(urlsplit(url).query)['tf'][0])
        value = self.responses.get(tf, self.envelope(tf))
        if isinstance(value, Exception):
            raise value
        return io.BytesIO(json.dumps(value).encode())

    def recorder(self):
        return load_module().Recorder(self.reports, self.logs, opener=self.opener,
                                      clock=lambda: self.now)

    def rows(self):
        return [json.loads(s) for s in self.path.read_text().splitlines()]

    def test_first_round_records_raw_native_forecasts_after_boot_resets(self):
        recorder = self.recorder()
        result = recorder.run_once()
        rows = self.rows()
        self.assertEqual(result['successful'], 2)
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['tickers'], ['USDJPY'])
        self.assertEqual(len(result['registered_tracks']), 1)
        self.assertEqual(len(self.calls), 2)
        for tf in (5, 15):
            pair = [r for r in rows if r['tf'] == tf]
            self.assertEqual([r['kind'] for r in pair], ['unavailable', 'forecast'])
            self.assertEqual(pair[0]['reason'], 'recorder_epoch_start')
            self.assertEqual(pair[1]['forecast'], self.envelope(tf))
            self.assertEqual(pair[1]['observedAt'], self.now)
            self.assertEqual(pair[1]['ticker'], 'USDJPY')
            self.assertEqual(pair[1]['schema_version'], 1)
            self.assertEqual(pair[0]['producer_epoch'], pair[1]['producer_epoch'])
            self.assertEqual(len(pair[1]['forecastFingerprint']), 64)
        health = json.loads((self.reports / 'timesfm_followup_recorder_health.json').read_text())
        self.assertEqual(health, result)

    def test_invalid_and_legacy_envelopes_never_create_forecasts(self):
        cases = {
            'legacy': {'schema_version': None},
            'wrong_convention': {'timestamp_convention': 'legacy'},
            'wrong_identity': {'ticker': 'EURUSD'},
            'wrong_tf': {'tf': 15},
            'wrong_model': {'model_version': 'other'},
            'retroavailability': {'availableAt': self.now + 1},
            'future_computation': {'computedAt': self.now + 1},
            'causal_order': {'computedAt': self.now - 5},
            'wrong_close': {'contextCloseTimeMs': self.now + 1},
            'missing_arrays': {'q50': None},
            'array_size': {'q90': [149.2]},
            'nonfinite': {'point': [float('nan'), 1]},
            'bool_time': {'availableAt': True},
            'fractional_tf': {'tf': 5.0},
            'empty': {},
        }
        recorder = self.recorder()
        for name, updates in cases.items():
            with self.subTest(name=name):
                updates = dict(updates)
                if name == 'retroavailability':
                    updates['availableAt'] = self.now + 1
                elif name == 'future_computation':
                    updates['computedAt'] = self.now + 1
                elif name == 'causal_order':
                    updates['computedAt'] = self.now - 5
                self.responses[5] = {} if name == 'empty' else dict(self.envelope(5), **updates)
                result = recorder.run_once()
                self.assertEqual(result['successful'], 1)
                self.assertTrue(result['errors'])
                self.assertFalse(any(r['kind'] == 'forecast' and r['tf'] == 5 for r in self.rows()))
                self.assertEqual([r for r in self.rows() if r['tf'] == 5][-1]['kind'], 'unavailable')
                self.now += 15000

    def test_http_failures_record_real_reason_without_response_data(self):
        from urllib.error import HTTPError
        self.responses[5] = HTTPError('http://local', 404, 'no forecast', {}, None)
        result = self.recorder().run_once()
        self.assertEqual(result['successful'], 1)
        row = [r for r in self.rows() if r['tf'] == 5][-1]
        self.assertEqual(row['kind'], 'unavailable')
        self.assertIn('404', row['reason'])
        self.assertNotIn('forecast', row)

    def test_unchanged_heartbeat_change_failure_recovery_and_restart(self):
        self.responses = {tf: self.envelope(tf) for tf in (5, 15)}
        recorder = self.recorder()
        recorder.run_once()
        prefix = self.path.read_bytes()
        self.now += 5000
        recorder.run_once()
        self.assertEqual(self.path.read_bytes(), prefix)
        self.now += 10000
        recorder.run_once()
        for tf in (5, 15):
            pair = [r for r in self.rows() if r['tf'] == tf]
            self.assertEqual(pair[-1]['kind'], 'heartbeat')
            self.assertEqual(pair[-1]['forecastFingerprint'], pair[1]['forecastFingerprint'])
            self.assertNotIn('forecast', pair[-1])
        self.responses[5]['point'][0] += 0.01
        self.now += 1
        recorder.run_once()
        self.assertEqual([r for r in self.rows() if r['tf'] == 5][-1]['kind'], 'forecast')
        self.responses[5] = OSError('bridge down')
        self.now += 1
        recorder.run_once()
        failed = self.path.read_bytes()
        self.now += 5000
        recorder.run_once()
        self.assertEqual(self.path.read_bytes(), failed)
        self.now += 10000
        recorder.run_once()
        self.assertGreater(len(self.path.read_bytes()), len(failed))
        self.responses[5] = self.envelope(5)
        self.now += 1
        recorder.run_once()
        self.assertEqual([r for r in self.rows() if r['tf'] == 5][-1]['kind'], 'forecast')
        old_epoch = self.rows()[-1]['producer_epoch']
        prefix = self.path.read_bytes()
        self.now += 1
        self.recorder().run_once()
        self.assertTrue(self.path.read_bytes().startswith(prefix))
        new = [json.loads(r) for r in self.path.read_bytes()[len(prefix):].splitlines()]
        for tf in (5, 15):
            pair = [r for r in new if r['tf'] == tf]
            self.assertEqual([r['kind'] for r in pair], ['unavailable', 'forecast'])
            self.assertEqual(pair[0]['reason'], 'recorder_epoch_start')
            self.assertNotEqual(pair[0]['producer_epoch'], old_epoch)

    def test_registry_rejects_unsafe_tickers_paths_bridges_and_prefixes_before_http(self):
        import copy
        original = copy.deepcopy(self.track)
        cases = ('ticker', 'outside', 'traversal', 'symlink', 'remote', 'credentials',
                 'bridge_path', 'bridge_query', 'missing_model', 'prefix', 'registration')
        for name in cases:
            with self.subTest(name=name):
                self.track = copy.deepcopy(original)
                ledger = self.track['live_forecast_ledger']
                if name == 'ticker': self.track['ticker'] = '../USDJPY'
                if name == 'outside': ledger['path'] = str(self.root / 'outside.jsonl')
                if name == 'traversal': ledger['path'] = str(self.logs / 'x/../ledger.jsonl')
                if name == 'symlink':
                    outside = self.root / 'outside'
                    outside.mkdir(exist_ok=True)
                    self.logs.mkdir(exist_ok=True)
                    (self.logs / 'link').symlink_to(outside, target_is_directory=True)
                    ledger['path'] = str(self.logs / 'link/ledger.jsonl')
                if name == 'remote': self.track['beforeAsset']['timesfm']['bridgeUrl'] = 'http://example.com:8788'
                if name == 'credentials': self.track['beforeAsset']['timesfm']['bridgeUrl'] = 'http://user:secret@127.0.0.1:8788'
                if name == 'bridge_path': self.track['beforeAsset']['timesfm']['bridgeUrl'] = 'http://127.0.0.1:8788/ingest'
                if name == 'bridge_query': self.track['beforeAsset']['timesfm']['bridgeUrl'] = 'http://127.0.0.1:8788?x=1'
                if name == 'missing_model': del ledger['model_version']
                if name == 'prefix': ledger['prefix_sha256'] = 'a' * 64
                if name == 'registration': ledger['registered_at_ms'] = self.now + 1000
                self.save_track()
                result = self.recorder().run_once()
                self.assertTrue(result['errors'])
                self.assertEqual(self.calls, [])
                self.assertFalse(self.path.exists())

    def test_default_path_applied_enabled_duplicate_tracks_and_configured_loopback_port(self):
        del self.track['live_forecast_ledger']['path']
        self.track['beforeAsset']['timesfm']['enabled'] = False
        self.track['appliedAsset']['timesfm'] = {'enabled': True, 'bridgeUrl': 'http://127.0.0.1:9988/'}
        self.save_track()
        (self.reports / 'rollouts/USDJPY_next.json').write_text(json.dumps(self.track))
        result = self.recorder().run_once()
        self.assertEqual(result['successful'], 2)
        self.assertEqual(len(result['registered_tracks']), 2)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(all(u.startswith('http://127.0.0.1:9988/forecast/latest?') for u in self.calls))
        self.assertEqual(len(self.rows()), 4)

    def test_malformed_registry_is_reported_and_disabled_assets_not_polled(self):
        self.track['beforeAsset']['timesfm']['enabled'] = False
        self.save_track()
        (self.reports / 'rollouts/bad.json').write_text('{')
        result = self.recorder().run_once()
        self.assertEqual(self.calls, [])
        self.assertTrue(result['errors'])
        self.assertEqual(result['tickers'], [])

    def test_clock_regression_is_rejected_without_appending_and_rechecked_after_http(self):
        recorder = self.recorder()
        recorder.run_once()
        prefix = self.path.read_bytes()
        self.now -= 100
        result = recorder.run_once()
        self.assertTrue(result['errors'])
        self.assertEqual(self.path.read_bytes(), prefix)
        result = self.recorder().run_once()
        self.assertTrue(result['errors'])
        self.assertEqual(self.path.read_bytes(), prefix)

    def test_partial_existing_row_is_never_repaired_or_extended(self):
        self.path.parent.mkdir(parents=True)
        original = b'{"schema_version":1'
        self.path.write_bytes(original)
        result = self.recorder().run_once()
        self.assertTrue(result['errors'])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.path.read_bytes(), original)

    def test_threaded_rounds_are_serialized_and_fsynced(self):
        from concurrent.futures import ThreadPoolExecutor
        from unittest.mock import patch
        import os
        recorder = self.recorder()
        real_fsync = os.fsync
        with patch.object(os, 'fsync', wraps=real_fsync) as fsync:
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: recorder.run_once(), range(4)))
            self.assertTrue(all(r['successful'] == 2 for r in results))
            self.assertGreaterEqual(fsync.call_count, 4)
        self.assertEqual(len(self.rows()), 4)

    def test_health_uses_atomic_replace_never_writes_through_symlinks(self):
        from unittest.mock import patch
        import os
        recorder = self.recorder()
        real_replace = os.replace
        with patch.object(os, 'replace', wraps=real_replace) as replace:
            recorder.run_once()
            self.assertTrue(replace.called)
        external = self.root / 'external-health'
        external.write_text('untouched')
        health = self.reports / 'unsafe-health.json'
        health.symlink_to(external)
        with self.assertRaises(ValueError):
            load_module().Recorder(self.reports, self.logs, opener=self.opener,
                                   clock=lambda: self.now, health_file=health)
        self.assertEqual(external.read_text(), 'untouched')

    def test_file_symlink_and_hardlink_are_never_appended(self):
        self.path.parent.mkdir(parents=True)
        external = self.root / 'outside-ledger'
        external.write_bytes(b'')
        self.path.symlink_to(external)
        result = self.recorder().run_once()
        self.assertTrue(result['errors'])
        self.assertEqual(external.read_bytes(), b'')
        self.path.unlink()
        __import__('os').link(external, self.path)
        result = self.recorder().run_once()
        self.assertTrue(result['errors'])
        self.assertEqual(external.read_bytes(), b'')

    def test_real_local_http_does_not_follow_redirects_or_proxy_environment(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        from unittest.mock import patch
        import threading
        observed = []
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                from urllib.parse import parse_qs, urlsplit
                observed.append(self.path)
                tf = int(parse_qs(urlsplit(self.path).query).get('tf', ['5'])[0])
                if tf == 5:
                    self.send_response(302)
                    self.send_header('Location', '/must-not-follow')
                    self.end_headers()
                else:
                    body = json.dumps(test.envelope(tf)).encode()
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            self.track['beforeAsset']['timesfm']['bridgeUrl'] = f'http://127.0.0.1:{server.server_port}'
            self.save_track()
            with patch.dict('os.environ', {'http_proxy': 'http://127.0.0.1:1', 'no_proxy': ''}):
                # Exercise the production opener: no redirects, no proxy inheritance.
                recorder = load_module().Recorder(self.reports, self.logs, clock=lambda: self.now)
                result = recorder.run_once()
            self.assertEqual(result['successful'], 1)
            self.assertEqual(len(observed), 2)
            self.assertTrue(all(p.startswith('/forecast/latest?') for p in observed))
            self.assertIn('302', result['errors'][0]['reason'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_cli_once_outputs_summary_and_daemon_arguments_have_safe_defaults(self):
        import subprocess
        empty = self.root / 'empty-reports'
        empty.mkdir()
        command = ['python3', '-B', str(MODULE), '--once', '--reports-dir', str(empty),
                   '--logs-root', str(self.logs), '--health-file', str(empty / 'health.json')]
        run = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(run.returncode, 0, run.stderr)
        summary = json.loads(run.stdout)
        self.assertEqual(summary['tickers'], [])
        self.assertEqual(summary['successful'], 0)
        self.assertEqual(json.loads((empty / 'health.json').read_text()), summary)
        args = load_module().parse_args([])
        self.assertEqual(args.interval, 5)
        self.assertEqual(args.logs_root, '/opt/JARVIS/logs')
        bad = subprocess.run(command + ['--interval', '0'], capture_output=True, timeout=5)
        self.assertNotEqual(bad.returncode, 0)

    def test_incomplete_http_json_and_oversized_payload_are_unavailable_not_fatal(self):
        import http.client
        values = [http.client.IncompleteRead(b'{'), b'{', b'x' * (2 * 1024 * 1024 + 1)]
        recorder = self.recorder()
        normal = recorder.opener
        for value in values:
            def opener(url, timeout):
                if 'tf=15' in url:
                    return normal(url, timeout)
                if isinstance(value, Exception):
                    raise value
                return io.BytesIO(value)
            recorder.opener = opener
            result = recorder.run_once()
            self.assertEqual(result['successful'], 1)
            self.assertTrue(result['errors'])
            self.assertEqual([r for r in self.rows() if r['tf'] == 5][-1]['kind'], 'unavailable')
            self.now += 15000

    def test_missing_native_metadata_is_not_inferred_from_legacy_fields(self):
        native = self.envelope(5)
        recorder = self.recorder()
        for missing in ('schema_version', 'timestamp_convention', 'contextCloseTimeMs', 'computedAt', 'availableAt'):
            legacy = dict(native, computed_at=self.now - 20, observedAt=self.now - 10)
            del legacy[missing]
            self.responses[5] = legacy
            result = recorder.run_once()
            self.assertEqual(result['successful'], 1)
            self.assertFalse(any(r['tf'] == 5 and r['kind'] == 'forecast' for r in self.rows()))
            self.now += 15000

    def test_conflicting_registrations_cannot_interleave_models_in_same_ledger(self):
        import copy
        other = copy.deepcopy(self.track)
        other['live_forecast_ledger']['model_version'] = 'conflicting-model'
        (self.reports / 'rollouts/USDJPY_conflict.json').write_text(json.dumps(other))
        result = self.recorder().run_once()
        self.assertTrue(result['errors'])
        self.assertEqual(self.calls, [])
        self.assertFalse(self.path.exists())

    def test_health_destination_cannot_replace_ledger(self):
        with self.assertRaises(ValueError):
            load_module().Recorder(self.reports, self.logs, opener=self.opener,
                                   clock=lambda: self.now, health_file=self.path)

    def test_later_observed_time_never_backdates_to_bridge_available_time(self):
        forecast = self.envelope(5)
        self.responses[5] = forecast
        recorder = self.recorder()
        original = recorder.opener
        def delayed(url, timeout):
            response = original(url, timeout)
            self.now += 4000
            return response
        recorder.opener = delayed
        recorder.run_once()
        row = [r for r in self.rows() if r['tf'] == 5 and r['kind'] == 'forecast'][0]
        self.assertEqual(row['observedAt'], forecast['availableAt'] + 4010)
        self.assertEqual(row['forecast'], forecast)

    def test_persistence_preserves_prefix_validates_registered_nonempty_prefix_and_flock(self):
        from unittest.mock import patch
        import fcntl
        import hashlib
        self.recorder().run_once()
        prefix = self.path.read_bytes()
        self.track['live_forecast_ledger'].update(prefix_size_bytes=len(prefix), prefix_sha256=hashlib.sha256(prefix).hexdigest())
        self.save_track()
        self.now += 1
        recorder = self.recorder()
        original = fcntl.flock
        with patch.object(fcntl, 'flock', wraps=original) as flock:
            result = recorder.run_once()
            self.assertEqual(result['successful'], 2)
            self.assertTrue(any(call.args[1] == fcntl.LOCK_EX for call in flock.call_args_list))
        self.assertTrue(self.path.read_bytes().startswith(prefix))
        self.track['live_forecast_ledger']['prefix_sha256'] = 'f' * 64
        self.save_track()
        self.calls.clear()
        before = self.path.read_bytes()
        result = recorder.run_once()
        self.assertTrue(result['errors'])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.path.read_bytes(), before)

    def test_independent_processes_append_complete_rows_with_real_file_locks(self):
        import multiprocessing
        context = multiprocessing.get_context('fork')
        processes = [context.Process(target=lambda: self.recorder().run_once()) for _ in range(3)]
        for process in processes:
            process.start()
        for process in processes:
            process.join(timeout=5)
            if process.is_alive():
                process.terminate()
                process.join()
                self.fail('recorder process hung')
            self.assertEqual(process.exitcode, 0)
        rows = self.rows()
        self.assertEqual(sum(r['kind'] == 'forecast' for r in rows), 6)
        self.assertEqual(len({r['producer_epoch'] for r in rows}), 3)
        self.assertTrue(self.path.read_bytes().endswith(b'\n'))
        for tf in (5, 15):
            for epoch in {r['producer_epoch'] for r in rows}:
                group = [r for r in rows if r['tf'] == tf and r['producer_epoch'] == epoch]
                self.assertEqual(group[0]['reason'], 'recorder_epoch_start')
                self.assertEqual(group[-1]['kind'], 'forecast')

    def test_short_writes_finish_complete_row_and_io_failures_are_visible(self):
        from unittest.mock import patch
        import os
        recorder = self.recorder()
        original = os.write
        def short(fd, data):
            return original(fd, data[:17])
        with patch.object(os, 'write', side_effect=short):
            result = recorder.run_once()
        self.assertEqual(result['successful'], 2)
        self.assertEqual(len(self.rows()), 4)
        prefix = self.path.read_bytes()
        self.now += 1
        recorder = self.recorder()

        # A failed row must not be announced as a successful forecast.
        with patch.dict(recorder.append.__globals__, {'write_all': lambda *_: (_ for _ in ()).throw(OSError('disk full'))}):
            with self.assertRaises(OSError):  # Health persistence fails too: caller sees the storage failure.
                recorder.run_once()
        self.assertEqual(self.path.read_bytes(), prefix)

    def test_removed_and_reregistered_track_does_not_use_stale_in_memory_heartbeat(self):
        self.responses = {tf: self.envelope(tf) for tf in (5, 15)}
        recorder = self.recorder()
        recorder.run_once()
        registry = self.reports / 'rollouts/USDJPY_week.json'
        registry.unlink()
        self.now += 1000
        recorder.run_once()
        self.save_track()
        self.now += 1000
        prefix = self.path.read_bytes()
        recorder.run_once()
        new = [json.loads(line) for line in self.path.read_bytes()[len(prefix):].splitlines()]
        for tf in (5, 15):
            pair = [r for r in new if r['tf'] == tf]
            self.assertEqual([r['kind'] for r in pair], ['unavailable', 'forecast'])
            self.assertEqual(pair[0]['reason'], 'recorder_epoch_start')

    def test_daemon_cli_exits_cleanly_on_sigterm_using_only_temporary_health(self):
        import subprocess
        import time
        empty = self.root / 'daemon-reports'
        empty.mkdir()
        health = empty / 'health.json'
        process = subprocess.Popen(['python3', '-B', str(MODULE), '--reports-dir', str(empty),
                                    '--logs-root', str(self.logs), '--health-file', str(health),
                                    '--interval', '0.1'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while not health.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(health.exists())
            self.assertEqual(json.loads(health.read_text())['tickers'], [])
            process.terminate()
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(stdout, '')
            self.assertEqual(stderr, '')
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()


if __name__ == '__main__':
    unittest.main()
