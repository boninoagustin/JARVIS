#!/usr/bin/env python3
"""Immutable per-(cycle_run_id, ticker) evaluation snapshots and preflight checks.

Guarantees that once an evaluation of a ticker begins, all subprocesses
(collect_triggers, precompute_forecasts, eval_production, run_hyperopt, auxiliary
selectors, train_ml_weekly, and weekly_rollout artifact verification) consume an
isolated, read-only, hash-manifested directory immune to concurrent writers.
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import time
from pathlib import Path

REQUIRED_TFS = ('M5', 'M15', 'H1', 'H4', 'D1')
TS_RE = re.compile(r'\|\s*TS:\s*(\d+)\b')
PING_M5_RE = re.compile(r'PING_PRICE\s*\|\s*TF:\s*(?:M5|5)\b')


class SnapshotPreflightError(RuntimeError):
    """Raised when exported SMC CSVs or frozen snapshots are missing, empty, truncated, or mismatched."""


def history_lock_path(ticker: str) -> Path:
    clean = re.sub(r'[^A-Z0-9_.-]', '', (ticker or '').strip().upper())
    if not clean:
        raise ValueError(f'invalid ticker for lock: {ticker!r}')
    lock_dir = Path(os.environ.get('JARVIS_HISTORY_LOCK_DIR', '/var/lock'))
    lock_dir.mkdir(parents=True, exist_ok=True)
    return lock_dir / f'jarvis_history_{clean}.lock'


@contextlib.contextmanager
def ticker_history_lock(ticker: str, *, shared: bool = False, timeout_sec: float = 300.0):
    lock_file = history_lock_path(ticker)
    fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR, 0o644)
    op = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
    deadline = time.monotonic() + timeout_sec
    try:
        while True:
            try:
                fcntl.flock(fd, op | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f'history lock timeout ({timeout_sec}s) for {ticker}: {lock_file}')
                time.sleep(0.1)
        yield lock_file
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def inspect_exported_csv(path: Path, tf: str) -> dict:
    if not path.exists() or not path.is_file():
        raise SnapshotPreflightError(f'missing exported CSV for {tf}: {path}')
    if path.is_symlink():
        raise SnapshotPreflightError(f'exported CSV must not be a symlink: {path}')
    raw = path.read_bytes()
    if not raw:
        raise SnapshotPreflightError(f'empty (0-byte) exported CSV for {tf}: {path}')
    if not raw.endswith(b'\n'):
        raise SnapshotPreflightError(f'truncated exported CSV (missing trailing newline) for {tf}: {path}')
    text = raw.decode('utf-8', errors='strict')
    lines = text.splitlines()
    if not lines or not (lines[0].startswith('Fecha,Mensaje') or lines[0].startswith('"Fecha"')):
        raise SnapshotPreflightError(f'invalid CSV header for {tf}: {path}')
    data_rows = 0
    ping_rows = 0
    first_ts = None
    last_ts = None
    for idx, line in enumerate(lines[1:], start=2):
        s = line.strip()
        if not s:
            continue
        m = TS_RE.search(s)
        if not m:
            raise SnapshotPreflightError(f'malformed/truncated row without TS at {path}:{idx}')
        ts = int(m.group(1))
        if last_ts is not None and ts < last_ts:
            raise SnapshotPreflightError(f'out-of-order timestamp at {path}:{idx} ({ts} < {last_ts})')
        if first_ts is None:
            first_ts = ts
        last_ts = ts
        data_rows += 1
        if tf == 'M5' and PING_M5_RE.search(s):
            ping_rows += 1
    if data_rows == 0 or first_ts is None or last_ts is None:
        raise SnapshotPreflightError(f'exported CSV has 0 data lines for {tf}: {path}')
    if tf == 'M5' and ping_rows == 0:
        raise SnapshotPreflightError(f'exported M5 CSV has 0 PING_PRICE observations: {path}')
    return {
        'tf': tf,
        'name': path.name,
        'bytes': len(raw),
        'sha256': hashlib.sha256(raw).hexdigest(),
        'rows': data_rows,
        'ping_rows': ping_rows,
        'first_ts': first_ts,
        'last_ts': last_ts,
    }


def validate_exported_dir(
    source_dir: Path,
    ticker: str,
    *,
    required_tfs: tuple[str, ...] = REQUIRED_TFS,
    min_m5_close_ms: int = 0,
) -> dict[str, dict]:
    source_dir = Path(source_dir)
    if not source_dir.exists() or not source_dir.is_dir():
        raise SnapshotPreflightError(f'{ticker}: exported directory missing: {source_dir}')
    inspected: dict[str, dict] = {}
    for tf in required_tfs:
        csv_path = source_dir / f'pine-logs-SMC Master_{tf}.csv'
        inspected[tf] = inspect_exported_csv(csv_path, tf)
    if min_m5_close_ms > 0 and 'M5' in inspected:
        if inspected['M5']['last_ts'] < min_m5_close_ms:
            raise SnapshotPreflightError(
                f"{ticker}: stale M5 export ({inspected['M5']['last_ts']} < expected candle {min_m5_close_ms})"
            )
    return inspected


def _fsync_dir(path: Path) -> None:
    fd = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _copy_verified(src: Path, dst: Path, expected_sha256: str) -> None:
    tmp = dst.with_name(f'.{dst.name}.{os.getpid()}.tmp')
    with src.open('rb') as rfd, tmp.open('wb') as wfd:
        shutil.copyfileobj(rfd, wfd, length=1024 * 1024)
        wfd.flush()
        os.fsync(wfd.fileno())
    actual = sha256_file(tmp)
    if actual != expected_sha256:
        tmp.unlink(missing_ok=True)
        raise SnapshotPreflightError(f'concurrent write detected while snapshotting {src}')
    os.chmod(tmp, 0o444)
    os.replace(tmp, dst)


def _unlock_tree_permissions(directory: Path) -> None:
    if not directory.exists():
        return
    for root, dirs, files in os.walk(directory):
        os.chmod(root, 0o755)
        for d in dirs:
            os.chmod(Path(root) / d, 0o755)
        for f in files:
            p = Path(root) / f
            if not p.is_symlink():
                os.chmod(p, 0o644)


def freeze_ticker_snapshot(
    ticker: str,
    source_dir: Path,
    snapshots_root: Path,
    *,
    cycle_run_id: str | None,
    cycle_week: str | None,
    started_at: int,
    min_m5_close_ms: int = 0,
    required_tfs: tuple[str, ...] = REQUIRED_TFS,
) -> dict:
    ticker_u = ticker.strip().upper()
    if not re.fullmatch(r'[A-Z0-9]+', ticker_u):
        raise ValueError(f'invalid ticker: {ticker!r}')
    run_tag = f"{cycle_run_id or 'standalone'}_{started_at}"
    run_root = Path(snapshots_root).resolve() / run_tag
    run_root.mkdir(parents=True, exist_ok=True)
    target_dir = run_root / ticker_u.lower()
    staging_dir = run_root / f'.{ticker_u.lower()}.staging.{os.getpid()}.{time.time_ns()}'
    if staging_dir.exists():
        _unlock_tree_permissions(staging_dir)
        shutil.rmtree(staging_dir)

    with ticker_history_lock(ticker_u, shared=True):
        inspected = validate_exported_dir(
            source_dir,
            ticker_u,
            required_tfs=required_tfs,
            min_m5_close_ms=min_m5_close_ms,
        )
        staging_dir.mkdir(parents=True, exist_ok=False)
        try:
            manifest_files = {}
            for tf, meta in inspected.items():
                src_file = Path(source_dir) / meta['name']
                dst_file = staging_dir / meta['name']
                _copy_verified(src_file, dst_file, meta['sha256'])
                # Re-check source did not change during multi-TF copy
                if sha256_file(src_file) != meta['sha256']:
                    raise SnapshotPreflightError(f'source CSV changed mid-snapshot: {src_file}')
                manifest_files[tf] = {**meta, 'path': str(target_dir / meta['name'])}

            manifest = {
                'version': 1,
                'ticker': ticker_u,
                'cycle_run_id': cycle_run_id,
                'cycle_week': cycle_week,
                'started_at': started_at,
                'created_at_ms': int(time.time() * 1000),
                'source_dir': str(Path(source_dir).resolve()),
                'snapshot_dir': str(target_dir),
                'files': manifest_files,
            }
            manifest_tmp = staging_dir / '.snapshot_manifest.json.tmp'
            with manifest_tmp.open('w') as mf:
                json.dump(manifest, mf, indent=2, sort_keys=True)
                mf.write('\n')
                mf.flush()
                os.fsync(mf.fileno())
            os.chmod(manifest_tmp, 0o444)
            os.replace(manifest_tmp, staging_dir / 'snapshot_manifest.json')
            _fsync_dir(staging_dir)

            if target_dir.exists():
                old_dir = run_root / f'.{ticker_u.lower()}.old.{os.getpid()}.{time.time_ns()}'
                os.replace(target_dir, old_dir)
                _unlock_tree_permissions(old_dir)
                shutil.rmtree(old_dir)
            os.replace(staging_dir, target_dir)
            _fsync_dir(run_root)
        except Exception:
            if staging_dir.exists():
                _unlock_tree_permissions(staging_dir)
                shutil.rmtree(staging_dir, ignore_errors=True)
            raise

    verified = verify_ticker_snapshot(
        target_dir,
        expected_ticker=ticker_u,
        expected_run_id=cycle_run_id,
        expected_started_at=started_at,
        required_tfs=required_tfs,
    )
    return verified


def freeze_forecast_cache(cache_source: Path, snapshot_dir: Path) -> Path:
    cache_source = Path(cache_source)
    snapshot_dir = Path(snapshot_dir)
    if not cache_source.exists() or not cache_source.is_file():
        raise SnapshotPreflightError(f'forecast cache missing: {cache_source}')
    raw = cache_source.read_bytes()
    if not raw or not raw.endswith(b'\n'):
        raise SnapshotPreflightError(f'forecast cache empty or truncated: {cache_source}')
    expected = hashlib.sha256(raw).hexdigest()
    dst = snapshot_dir / 'forecasts_m5.jsonl'
    if dst.exists():
        os.chmod(dst, 0o644)
    _copy_verified(cache_source, dst, expected)
    _fsync_dir(snapshot_dir)
    return dst


def verify_ticker_snapshot(
    snapshot_dir: Path,
    *,
    expected_ticker: str,
    expected_run_id: str | None = None,
    expected_started_at: int | None = None,
    required_tfs: tuple[str, ...] = REQUIRED_TFS,
) -> dict:
    snapshot_dir = Path(snapshot_dir).resolve()
    manifest_path = snapshot_dir / 'snapshot_manifest.json'
    if not manifest_path.exists():
        raise SnapshotPreflightError(f'snapshot manifest missing in {snapshot_dir}')
    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception as exc:
        raise SnapshotPreflightError(f'corrupt snapshot manifest in {snapshot_dir}: {exc}') from exc
    if manifest.get('version') != 1:
        raise SnapshotPreflightError(f'unsupported snapshot manifest version in {snapshot_dir}')
    if manifest.get('ticker') != expected_ticker.upper():
        raise SnapshotPreflightError(
            f"snapshot ticker mismatch: expected {expected_ticker.upper()}, got {manifest.get('ticker')}"
        )
    if expected_run_id is not None and manifest.get('cycle_run_id') != expected_run_id:
        raise SnapshotPreflightError(
            f"snapshot belongs to another run: expected {expected_run_id}, got {manifest.get('cycle_run_id')}"
        )
    if expected_started_at is not None and manifest.get('started_at') != expected_started_at:
        raise SnapshotPreflightError(
            f"snapshot started_at mismatch: expected {expected_started_at}, got {manifest.get('started_at')}"
        )
    files = manifest.get('files') or {}
    for tf in required_tfs:
        entry = files.get(tf)
        if not isinstance(entry, dict):
            raise SnapshotPreflightError(f'snapshot missing required timeframe {tf} in {snapshot_dir}')
        fpath = snapshot_dir / entry.get('name', '')
        if not fpath.exists() or fpath.resolve() != Path(entry.get('path', '')).resolve():
            raise SnapshotPreflightError(f'snapshot file path mismatch for {tf}: {fpath}')
        st = fpath.stat()
        if st.st_size != entry.get('bytes') or entry.get('rows', 0) <= 0:
            raise SnapshotPreflightError(f'snapshot file size/row mismatch for {tf}: {fpath}')
        if tf == 'M5' and entry.get('ping_rows', 0) <= 0:
            raise SnapshotPreflightError(f'snapshot M5 has 0 PING_PRICE rows: {fpath}')
        if sha256_file(fpath) != entry.get('sha256'):
            raise SnapshotPreflightError(f'snapshot hash mismatch for {tf}: {fpath}')
    return manifest


def prune_unreferenced_snapshots(
    snapshots_root: Path,
    reports_dir: Path,
    *,
    keep_run_tag: str | None = None,
    max_age_ms: int = 14 * 86400 * 1000,
    now_ms: int | None = None,
) -> list[str]:
    snapshots_root = Path(snapshots_root)
    if not snapshots_root.exists():
        return []
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    referenced_paths: set[Path] = set()
    scan_files = list(Path(reports_dir).glob('*.json'))
    rollouts_dir = Path(reports_dir) / 'rollouts'
    if rollouts_dir.exists():
        scan_files.extend(rollouts_dir.glob('*.json'))
    state_dir = Path(reports_dir) / 'selection_state'
    if state_dir.exists():
        scan_files.extend(state_dir.glob('*.json'))
    for jf in scan_files:
        try:
            data = json.loads(jf.read_text())
        except Exception:
            continue
        objs = [data]
        if isinstance(data, dict) and isinstance(data.get('candidate'), dict):
            objs.append(data['candidate'])
        for obj in objs:
            if not isinstance(obj, dict):
                continue
            prov = obj.get('evaluation_provenance') or {}
            for group in ('dataset_files', 'cache_files', 'manifest_files'):
                for item in prov.get(group) or []:
                    if isinstance(item, dict) and isinstance(item.get('path'), str):
                        referenced_paths.add(Path(item['path']).resolve())
            for group in ('dataset_files', 'cache_files'):
                for item in obj.get(group) or []:
                    if isinstance(item, dict) and isinstance(item.get('path'), str):
                        referenced_paths.add(Path(item['path']).resolve())

    removed: list[str] = []
    for entry in snapshots_root.iterdir():
        if not entry.is_dir() or entry.name == keep_run_tag:
            continue
        age_ms = now - int(entry.stat().st_mtime * 1000)
        if age_ms < max_age_ms:
            continue
        entry_resolved = entry.resolve()
        if any(entry_resolved in ref.parents for ref in referenced_paths):
            continue
        _unlock_tree_permissions(entry)
        shutil.rmtree(entry, ignore_errors=True)
        removed.append(str(entry))
    return removed
