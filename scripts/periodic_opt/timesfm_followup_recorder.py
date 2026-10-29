#!/usr/bin/env python3
"""Observe ONLY the bridge's memory-only GET /forecast/latest endpoint.

No cache conversion, inference, ingest, trading imports, or availability synthesis.
The JSONL ledger is independent of precompute caches and never replaced/truncated.
"""
import argparse
import hashlib
from http.client import HTTPException
import ipaddress
import json
import math
import os
from contextlib import contextmanager
import fcntl
from pathlib import Path
import re
import signal
import stat
import struct
import sys
import threading
import time
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener
import uuid

MAX_ROW_BYTES = 2 * 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


FINGERPRINT_VERSION = 'ieee754-v1'


def forecast_fingerprint(value):
    """Hash JSON semantics, not Python/JS number spellings; never change raw rows.

    Type tags + big-endian uint32 lengths make the encoding unambiguous. Strings
    and sorted object keys use UTF-16BE (JS code units); numbers use finite binary64
    with zero normalized, exactly the Number semantics used by the replay engine.
    """
    def text(s):
        data = s.encode('utf-16-be', errors='surrogatepass')
        return b's' + struct.pack('>I', len(data)) + data

    def encode(v):
        if v is None:
            return b'z'
        if type(v) is bool:
            return b't' if v else b'f'
        if type(v) in (int, float):
            n = float(v)
            if not math.isfinite(n):
                raise ValueError('fingerprint_numbers_must_be_finite')
            return b'n' + struct.pack('>d', n if n else 0.0)
        if isinstance(v, str):
            return text(v)
        if isinstance(v, list):
            return b'a' + struct.pack('>I', len(v)) + b''.join(encode(x) for x in v)
        if isinstance(v, dict) and all(isinstance(k, str) for k in v):
            keys = sorted(v, key=lambda k: k.encode('utf-16-be', errors='surrogatepass'))
            return b'o' + struct.pack('>I', len(keys)) + b''.join(text(k) + encode(v[k]) for k in keys)
        raise ValueError('fingerprint_requires_JSON_values')

    return hashlib.sha256(encode(value)).hexdigest()


def safe_path(value, root=None):
    path = Path(value)
    if '..' in path.parts:
        raise ValueError('path_traversal_rejected')
    path = Path(os.path.abspath(path))
    if root is not None and (path == root or root not in path.parents):
        raise ValueError('ledger_outside_logs_root')
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('symlink_path_rejected')
    return path


@contextmanager
def parent_fd(path, create=False):
    """Walk directory FDs without following links, including during mkdir races."""
    path = safe_path(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parent.parts[1:]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


def check_regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('ledger_must_be_regular_single_link_file')


def tail_rows(fd):
    size = os.fstat(fd).st_size
    if not size:
        return []
    data = os.pread(fd, min(size, MAX_ROW_BYTES + 1), max(0, size - MAX_ROW_BYTES - 1))
    if not data.endswith(b'\n'):
        raise ValueError('ledger_partial_trailing_row_no_repair')
    lines = data.splitlines()
    if size > len(data):
        lines = lines[1:]
    rows = [json.loads(line) for line in lines]
    if not rows or any(not isinstance(r, dict) or type(r.get('observedAt')) is not int
                       or r.get('schema_version') != 1 for r in rows):
        raise ValueError('invalid_existing_ledger_tail')
    return rows


def write_all(fd, data):
    # Build each complete row before touching the ledger; hold flock throughout.
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        if count <= 0:
            raise OSError('zero_length_write')
        view = view[count:]
    os.fsync(fd)


def atomic_health(path, value):
    path = safe_path(path)
    with parent_fd(path, create=True) as directory:
        name = f'.{path.name}.{uuid.uuid4().hex}.tmp'
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            write_all(fd, canonical(value) + b'\n')
            os.close(fd)
            fd = None
            safe_path(path)
            os.replace(name, path.name, src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(name, dir_fd=directory)
            except FileNotFoundError:
                pass


def bridge_url(value):
    parsed = urlsplit(value)
    host = parsed.hostname
    if host == 'localhost':
        host = '127.0.0.1'
    if (parsed.scheme != 'http' or not host or not ipaddress.ip_address(host).is_loopback
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('bridge_must_be_plain_loopback_http_origin')
    port = parsed.port or 80
    return f'http://[{host}]:{port}' if ':' in host else f'http://{host}:{port}'


def verify_prefix(path, metadata):
    size, digest = metadata.get('prefix_size_bytes'), metadata.get('prefix_sha256')
    if type(size) is not int or size < 0 or not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
        raise ValueError('invalid_ledger_prefix_registration')
    hasher = hashlib.sha256()
    try:
        with parent_fd(path) as directory:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                check_regular(fd)
                fcntl.flock(fd, fcntl.LOCK_SH)
                remaining = size
                while remaining:
                    data = os.read(fd, min(remaining, 65536))
                    if not data:
                        raise ValueError('ledger_registered_prefix_truncated')
                    hasher.update(data)
                    remaining -= len(data)
                tail_rows(fd)
            finally:
                os.close(fd)
    except FileNotFoundError:
        if size:
            raise ValueError('ledger_registered_prefix_missing')
    if hasher.hexdigest() != digest:
        raise ValueError('ledger_registered_prefix_changed')


def validate_forecast(value, ticker, tf, model, observed):
    if not isinstance(value, dict):
        raise ValueError('forecast_not_an_object')
    if (not isinstance(value.get('ticker'), str) or value['ticker'].upper() != ticker
            or type(value.get('tf')) is not int or value['tf'] != tf
            or value.get('model_version') != model):
        raise ValueError('forecast_identity_mismatch')
    if (type(value.get('schema_version')) is not int or value['schema_version'] != 2
            or value.get('timestamp_convention') != 'context_close_ms_v2'):
        raise ValueError('native_schema_v2_required')
    fields = ('ts', 'contextCloseTimeMs', 'computedAt', 'availableAt')
    if any(type(value.get(k)) is not int or value[k] <= 0 for k in fields):
        raise ValueError('native_causal_timestamps_required')
    if (value['contextCloseTimeMs'] != value['ts'] or value['ts'] % (tf * 60000)
            or not value['ts'] <= value['computedAt'] <= value['availableAt'] <= observed):
        raise ValueError('invalid_causal_order_or_future_availability')
    horizon = value.get('horizon')
    if type(horizon) is not int or not 1 <= horizon <= 4096:
        raise ValueError('invalid_horizon')
    for name in ('point', 'q10', 'q50', 'q90'):
        array = value.get(name)
        if (not isinstance(array, list) or len(array) != horizon
                or any(type(n) not in (int, float) or not math.isfinite(n) for n in array)):
            raise ValueError('invalid_forecast_array_' + name)
    canonical(value)  # Also reject nonfinite values outside the required arrays.


class Recorder:
    def __init__(self, reports_dir, logs_root, *, opener=None, clock=None, health_file=None):
        self.reports_dir = safe_path(reports_dir)
        self.logs_root = safe_path(logs_root)
        self.opener = opener or build_opener(ProxyHandler({}), NoRedirect()).open
        self.clock = clock or (lambda: time.time_ns() // 1_000_000)
        self.health_file = safe_path(health_file or self.reports_dir / 'timesfm_followup_recorder_health.json')
        if self.health_file.suffix != '.json':
            raise ValueError('health_destination_must_be_json_not_jsonl_ledger')
        self.producer_epoch = str(uuid.uuid4())
        self.started = set()
        self.states = {}
        self.sources = {}
        self.lock = threading.RLock()

    def discover(self, result):
        targets = {}
        for file in sorted((self.reports_dir / 'rollouts').glob('*.json')):
            try:
                track = json.loads(safe_path(file).read_text())
                enabled = [track.get(k, {}).get('timesfm', {}) for k in ('beforeAsset', 'appliedAsset')
                           if track.get(k, {}).get('timesfm', {}).get('enabled') is True]
                if not enabled:
                    continue
                ticker = track['ticker']
                if not isinstance(ticker, str) or not re.fullmatch('[A-Z][A-Z0-9]{0,20}', ticker):
                    raise ValueError('invalid_registry_ticker')
                metadata = track['live_forecast_ledger']
                model = metadata['model_version']
                if not isinstance(model, str) or not model.strip():
                    raise ValueError('registered_model_version_required')
                at = metadata.get('registered_at_ms')
                if type(at) is not int or not 0 < at <= self.clock():
                    raise ValueError('invalid_registration_time')
                path = safe_path(metadata.get('path') or self.logs_root / ticker.lower() / 'forecasts/live_followup_ledger.jsonl', self.logs_root)
                if path.suffix != '.jsonl' or path == self.health_file:
                    raise ValueError('ledger_requires_separate_jsonl_destination')
                bridges = {bridge_url(t.get('bridgeUrl') or 'http://127.0.0.1:8788') for t in enabled}
                if len(bridges) != 1:
                    raise ValueError('conflicting_enabled_bridge_origins')
                bridge = bridges.pop()
                verify_prefix(path, metadata)
                key = (ticker, str(path), model, bridge)
                targets[key] = (path, ticker, model, bridge)
                result['registered_tracks'].append(str(file))
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
                result['errors'].append(dict(track=str(file), reason=f'{type(error).__name__}: {error}'))
        by_path = {}
        for key in targets:
            by_path.setdefault(key[1], set()).add((key[0], key[2], key[3]))
        conflicts = {path for path, identities in by_path.items() if len(identities) != 1}
        for path in sorted(conflicts):
            result['errors'].append(dict(path=path, reason='conflicting_ledger_registrations'))
        return [target for target in targets.values() if str(target[0]) not in conflicts]

    def append(self, path, ticker, tf, kind, **fields):
        with self.lock:
            path = safe_path(path, self.logs_root)
            with parent_fd(path, create=True) as directory:
                fd = os.open(path.name, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                             0o600, dir_fd=directory)
                try:
                    check_regular(fd)
                    fcntl.flock(fd, fcntl.LOCK_EX)
                    self._append_locked(fd, path, ticker, tf, kind, fields)
                    os.fsync(directory)
                finally:
                    os.close(fd)

    def _append_locked(self, fd, path, ticker, tf, kind, fields):
        key = (str(path), ticker, tf)
        now = self.clock()
        rows = tail_rows(fd)
        if type(now) is not int or now <= 0 or rows and now < rows[-1]['observedAt']:
            raise ValueError('out_of_order_observation_clock')
        latest = next((r for r in reversed(rows) if r.get('ticker') == ticker and r.get('tf') == tf), None)
        if kind == 'forecast':
            forecast = fields['forecast']
            validate_forecast(forecast, ticker, tf, forecast['model_version'], now)
            if latest and latest.get('producer_epoch') != self.producer_epoch:
                reset = dict(schema_version=1, kind='unavailable', ticker=ticker, tf=tf,
                             observedAt=now, producer_epoch=self.producer_epoch, reason='recorder_epoch_start')
                write_all(fd, canonical(reset) + b'\n')
                self.states.pop(key, None)
        previous = self.states.get(key)
        state = (kind, fields.get('forecastFingerprint'), fields.get('reason'))
        if previous and previous[0] == state:
            if now - previous[1] < 15000:
                return
            if kind == 'forecast':
                kind = 'heartbeat'
                fields = dict(forecastFingerprint=fields['forecastFingerprint'],
                              forecastFingerprintVersion=fields['forecastFingerprintVersion'])
        row = dict(schema_version=1, kind=kind, ticker=ticker, tf=tf,
                   observedAt=now, producer_epoch=self.producer_epoch, **fields)
        data = canonical(row) + b'\n'
        if len(data) > MAX_ROW_BYTES:
            raise ValueError('ledger_row_too_large')
        write_all(fd, data)
        self.states[key] = (state, now)

    def run_once(self):
        with self.lock:
            return self._run_once()

    def _run_once(self):
        result = dict(lastRoundAt=self.clock(), tickers=[], successful=0, errors=[], registered_tracks=[])
        targets = self.discover(result)
        active = {(str(path), ticker, tf): (model, bridge)
                  for path, ticker, model, bridge in targets for tf in (5, 15)}
        self.started = {key for key in self.started if key in active and self.sources.get(key) == active[key]}
        self.states = {key: state for key, state in self.states.items() if key in self.started}
        self.sources = active
        for path, ticker, model, bridge in targets:
            if ticker not in result['tickers']:
                result['tickers'].append(ticker)
            for tf in (5, 15):
                key = (str(path), ticker, tf)
                url = bridge + '/forecast/latest?' + urlencode(dict(ticker=ticker, tf=tf))
                try:
                    if key not in self.started:
                        self.append(path, ticker, tf, 'unavailable', reason='recorder_epoch_start')
                        self.started.add(key)
                    with self.opener(url, timeout=3) as response:
                        data = response.read(MAX_ROW_BYTES + 1)
                        if len(data) > MAX_ROW_BYTES:
                            raise ValueError('bridge_response_too_large')
                        forecast = json.loads(data)
                    validate_forecast(forecast, ticker, tf, model, self.clock())
                    self.append(path, ticker, tf, 'forecast', forecast=forecast,
                                forecastFingerprint=forecast_fingerprint(forecast),
                                forecastFingerprintVersion=FINGERPRINT_VERSION)
                    result['successful'] += 1
                except (OSError, ValueError, HTTPException) as error:
                    reason = f'{type(error).__name__}: {error}'
                    try:
                        self.append(path, ticker, tf, 'unavailable', reason=reason)
                    except (OSError, ValueError) as ledger_error:
                        reason += f'; ledger_write_failed: {ledger_error}'
                    result['errors'].append(dict(ticker=ticker, tf=tf, reason=reason))
        atomic_health(self.health_file, result)
        return result


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--once', action='store_true', help='one round, print JSON summary, exit 1 on errors')
    parser.add_argument('--reports-dir', default=str(Path(__file__).resolve().parent / 'reports'))
    parser.add_argument('--logs-root', default='/opt/JARVIS/logs')
    parser.add_argument('--interval', type=float, default=5, help='poll seconds, >0 and <=15 (default: 5)')
    parser.add_argument('--health-file', help='explicit local JSON health destination; default: REPORTS_DIR/timesfm_followup_recorder_health.json')
    args = parser.parse_args(argv)
    if not math.isfinite(args.interval) or not 0 < args.interval <= 15:
        parser.error('--interval must be >0 and <=15 seconds')
    return args


def main(argv=None):
    args = parse_args(argv)
    recorder = Recorder(args.reports_dir, args.logs_root, health_file=args.health_file)
    if args.once:
        result = recorder.run_once()
        print(json.dumps(result, sort_keys=True), flush=True)
        return int(bool(result['errors']))
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    while not stop.is_set():
        started = time.monotonic()
        try:
            result = recorder.run_once()
            if result['errors']:
                print(json.dumps(result, sort_keys=True), file=sys.stderr, flush=True)
        except (OSError, ValueError) as error:
            print(f'recorder_round_failed: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
        stop.wait(max(0, args.interval - (time.monotonic() - started)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
