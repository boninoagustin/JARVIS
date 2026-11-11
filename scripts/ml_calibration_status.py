#!/usr/bin/env python3
"""Read-only production ML readiness; isolated candidates only, never promotion.
Run with hyperopt/.venv Python. A cross-process lock serializes refresh and fits.
"""
import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import time
import traceback
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data/ml_calibration'
STATUS = CACHE / 'status.json'
MIN_TRAIN = 50  # MLFilter.ts runtime model-load minimum
MIN_CALIBRATION = 20
MIN_VALIDATION = 30
THRESHOLD_PROTOCOL = {'version': 1, 'thresholds': [.5, .65, .8],
                      'minCalibrationTrades': MIN_CALIBRATION, 'minValidationTrades': MIN_VALIDATION}


def current_protocol(model):
    meta = (model or {}).get('meta', {})
    m = meta.get('evaluation_manifest', {})
    return (meta.get('threshold_calibration_protocol') == THRESHOLD_PROTOCOL
            and isinstance(m.get('validation_end_ms'), int)
            and isinstance(m.get('test_end_ms'), int)
            and m['validation_end_ms'] < m['test_end_ms'])


def three_window_manifest(manifest, ticker):
    import train_ml_model as trainer
    old = trainer.validate_manifest(manifest, ticker)
    start, end = old['train_end_ms'], old['validation_end_ms']
    middle = start + (end - start) // 2
    if not start < middle < end:
        raise trainer.ProtocolError('History cannot supply three nonempty chronological windows')
    return dict(old, validation_end_ms=middle, test_end_ms=end, test_independence='unverified')


def training_data(data):
    # Final C counts/labels must not reach fitting, paired accuracy or freshness.
    allowed = {'train', 'validation', 'manifest', 'counts', 'max_label_closed_at_ms',
               'embargo_ms', 'effective_config', 'dataset_source', 'old_model_source', 'old_source_sha256'}
    return {key: value for key, value in data.items() if key in allowed}


def now():
    return int(time.time() * 1000)


def save(value):
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = STATUS.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, allow_nan=False))
    os.replace(tmp, STATUS)


def read_status():
    try:
        return json.loads(STATUS.read_text())
    except (OSError, ValueError):
        return {'assets': {}, 'state': 'PENDING'}


def snapshot():
    env = os.environ.copy()
    env['PATH'] = '/root/.nvm/versions/node/v24.19.0/bin:' + env.get('PATH', '')
    result = subprocess.run(['node', '--import', 'tsx', str(ROOT / 'scripts/ml_calibration_snapshot.ts')],
                            cwd=ROOT, env=env, capture_output=True, text=True, timeout=90, check=True)
    return json.loads(result.stdout)


def partition(rows, minimum):
    wins = sum(r['label'] == 1 for r in rows)
    return {'accepted': len(rows), 'required': minimum, 'missing': max(0, minimum-len(rows)),
            'wins': wins, 'losses': len(rows)-wins, 'bothClasses': 0 < wins < len(rows)}


def readiness(data, old):
    import train_ml_model as trainer
    result = {'train': partition(data['train'], MIN_TRAIN),
              'calibration': partition(data['validation'], MIN_CALIBRATION),
              'validation': dict(data['final_readiness']),
              'ready': False, 'state': 'INSUFFICIENT', 'updatedAt': now(),
              'manifest': data['manifest'], 'counts': data['counts'],
              'thresholdProtocol': THRESHOLD_PROTOCOL,
              'recommendation': 'NOT_EVALUATED', 'minimumTrain': MIN_TRAIN,
              'minimumCalibration': MIN_CALIBRATION, 'minimumValidation': MIN_VALIDATION}
    try:
        for name, label, minimum in (('train', 'entrenamiento A', MIN_TRAIN), ('validation', 'calibración B', MIN_CALIBRATION)):
            trainer.guard_samples(data[name], label, minimum)
        final = result['validation']
        if final['accepted'] < MIN_VALIDATION or not final['bothClasses']:
            raise trainer.InsufficientSamples(f"HOLD: final C requires >= {MIN_VALIDATION} closed labelled samples and both WIN/LOSS classes; n={final['accepted']}")
        # Explicit one-time migration is allowed only after all three guards.
        # It does not recast the old two-window candidate as untouched holdout.
        if old is not None and not current_protocol(old):
            result.update(ready=True, bootstrapRequired=True, protocolBootstrapRequired=True,
                state='PROTOCOL_BOOTSTRAP_REQUIRED',
                reason='Confirmar nueva calibración de tres ventanas; el candidato anterior no tiene holdout C independiente. No se reducen mínimos ni se activa el gate.')
            return result
        trainer.guard_freshness(training_data(data), old, 15, False)
        result.update(ready=True, state='READY', reason='Tres ventanas y procedencia suficientes; candidato sin activar')
    except trainer.InsufficientSamples as exc:
        result['reason'] = str(exc)
        if 'FRESHNESS' in str(exc):
            result['state'] = 'HOLD_FRESHNESS'
        if 'HOLD_FRESHNESS_UNKNOWN' in str(exc):
            result.update(ready=True, bootstrapRequired=True, state='BOOTSTRAP_REQUIRED')
    return result


def collect(ticker, asset):
    import train_ml_model as trainer
    config = asset['config']
    directory = ROOT / 'logs' / ticker.lower() / 'history_exported'
    if not directory.is_dir():
        raise ValueError('No exported history available')
    rpc = trainer.WorkerRPC()
    try:
        params = {'ticker': ticker, 'log_dir': str(directory)}
        cache = (config.get('timesfm') or {}).get('cachePath')
        if cache:
            params['timesfm_cache'] = cache
        default = rpc('init', params)
        manifest = three_window_manifest(default.get('evaluation_manifest', default.get('manifest')), ticker)
        # The existing collector fits Train A / Validation B only. Keep its RPC
        # alive long enough to project C into readiness counts, never fit rows.
        def collect_rpc(method, arguments):
            return {} if method == 'shutdown' else rpc(method, arguments)
        data = trainer.collect_temporal_trades(directory, ticker, config, manifest, rpc=collect_rpc)
        final = rpc('evaluate_final', {'config': dict(config, mlGate={'enabled': False})})
        source = data['dataset_source']
        context = source['partitions']['validation']
        if (final.get('evaluation_manifest') != manifest
                or final.get('provenance') != source.get('worker_provenance')
                or final.get('effective_config') != data['effective_config']
                or final.get('config_fingerprint') != context.get('config_fingerprint')
                or final.get('ml_provenance', {}).get('enabled') is not False
                or final.get('test_evidence', {}).get('partition') != 'test'):
            raise trainer.ProtocolError('Final C readiness context/provenance mismatch')
        rows = final.get('test_trades')
        if not isinstance(rows, list):
            raise trainer.ProtocolError('Final C closed trade records missing')
        accepted = []
        start, end = manifest['validation_end_ms'], manifest['test_end_ms']
        for trade in rows:
            ts = trade.get('timestamp')
            close = trade.get('closeTimestamp', trade.get('closedAt', trade.get('closeTs')))
            r = trade.get('rMultiple')
            # evaluate_final deliberately returns normalized CLOSED records, not
            # raw result strings/features. Use return SIGN only to count labels;
            # discard magnitudes immediately (never compute C PnL for readiness).
            if (trade.get('label_status') == 'closed' and type(r) in (int, float)
                    and math.isfinite(r) and r != 0 and type(ts) is int and type(close) is int
                    and start <= ts < end and ts <= close < end):
                accepted.append({'label': int(r > 0)})
        data['final_readiness'] = partition(accepted, MIN_VALIDATION)
        data['final_readiness']['labelPolicy'] = 'closed_nonzero_return_sign_only'
        rpc('shutdown', {})
    finally:
        rpc.close()
    # Never substitute the generic model of another asset.
    path = trainer.MODELS_DIR / f'ml_model_{ticker}.json'
    # The latest isolated candidate is the freshness/paired-comparison reference
    # after a fit, even when never promoted. Re-clicking the same dataset must
    # not bootstrap against the same legacy active model again.
    candidates = sorted((CACHE / 'candidates').glob(f'{ticker}-*.json'))
    if candidates:
        path = candidates[-1]
    old = json.loads(path.read_text()) if path.is_file() else None
    old_bytes = path.read_bytes() if old is not None else None
    if old is not None:
        trainer.validate_export(old)
    data['old_model_source'] = str(path) if old is not None else None
    data['old_source_sha256'] = hashlib.sha256(old_bytes).hexdigest() if old_bytes else None
    return data, old, path, old_bytes


def latest_candidate(ticker):
    paths = sorted((CACHE / 'candidates').glob(f'{ticker}-*.json'))
    return paths[-1] if paths else None


def strategy_config(config):
    value = json.loads(json.dumps(config))
    for field in ('mlGate', 'mlGateEnabled', 'mlGateDeployment'):
        value.pop(field, None)
    return value


def candidate_binding(ticker, config):
    path = latest_candidate(ticker)
    if path is None:
        return None, None
    raw = path.read_bytes()
    binding = {'path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(raw).hexdigest()}
    model = json.loads(raw)
    meta = model.get('meta', {})
    if meta.get('ticker') != ticker:
        return binding, 'Candidate ticker mismatch'
    if not current_protocol(model):
        return binding, 'Protocolo anterior de dos ventanas: resultado obsoleto; no prueba selección de umbral con holdout C independiente'
    if strategy_config(meta.get('config', {})) != strategy_config(config):
        return binding, 'Current production config differs from candidate frozen config'
    files = meta.get('dataset_source', {}).get('worker_provenance', {}).get('dataset_files', [])
    if not files:
        return binding, 'Missing frozen dataset provenance'
    for item in files:
        p = Path(item['path'])
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != item.get('sha256'):
            return binding, 'Frozen candidate dataset changed'
    actual = sorted(str(p) for p in (ROOT/'logs'/ticker.lower()/'history_exported').glob('*.csv'))
    if actual != sorted(item['path'] for item in files):
        return binding, 'Frozen candidate dataset file set changed'
    # UI-only changes must not stale inference; actual replay/feature changes must.
    sources = meta.get('dataset_source', {}).get('worker_provenance', {}).get('source_files', [])
    for item in sources:
        p = Path(item['path'])
        critical = '/src/engine/' in str(p) or p.name in ('backtestEngine.ts', 'backtestTypes.ts', 'replayWindow.ts') or str(p).endswith(('/scripts/periodic_opt/selection_context.ts', '/scripts/hyperopt/evaluation_protocol.ts'))
        if critical and (not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != item.get('sha256')):
            return binding, 'Frozen candidate replay source changed'
    return binding, None


def preserve_comparison(row, previous, ticker, config):
    try:
        binding, issue = candidate_binding(ticker, config)
        if binding is None:
            return
        prior_binding = previous.get('candidate')
        if prior_binding and prior_binding.get('path') == binding['path'] and prior_binding.get('sha256') != binding['sha256']:
            issue = 'Immutable candidate raw bytes changed since saved binding'
            binding = prior_binding
        row['candidate'] = binding
        row['currentCandidateSha256'] = binding['sha256']
        comparison = previous.get('comparison')
        if comparison:
            if comparison.get('schemaVersion') != 2 or comparison.get('scope') != 'temporal_threshold_holdout':
                issue = 'Comparación obsoleta: se exige selección en calibración B y validación final C separadas'
            if comparison.get('candidateSha256') != binding['sha256'] or comparison.get('candidate') != binding['path']:
                issue = 'Comparison belongs to a different candidate'
            row['comparison'] = dict(comparison)
            if issue:
                row['comparison'].update(status='unavailable', recommendation='INSUFFICIENT_EVIDENCE', reason=issue)
        elif issue:
            row['comparison'] = {'schemaVersion': 2, 'status': 'unavailable', 'ticker': ticker,
                'candidate': binding['path'], 'candidateSha256': binding['sha256'],
                'scope': 'temporal_threshold_holdout', 'recommendation': 'INSUFFICIENT_EVIDENCE', 'reason': issue}
    except Exception as exc:
        row['comparison'] = {'schemaVersion': 2, 'status': 'unavailable', 'ticker': ticker,
            'scope': 'temporal_threshold_holdout', 'recommendation': 'INSUFFICIENT_EVIDENCE', 'reason': str(exc)[:500]}


def run_comparison(ticker, path, config):
    try:
        return _run_comparison(ticker, path, config)
    except Exception as exc:
        return {'schemaVersion': 2, 'status': 'error', 'ticker': ticker,
            'candidate': str(path.relative_to(ROOT)),
            'candidateSha256': hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None,
            'selectedThreshold': None, 'evaluatedAt': now(), 'scope': 'temporal_threshold_holdout',
            'applyEligible': False, 'recommendation': 'INSUFFICIENT_EVIDENCE', 'reason': str(exc)[:500]}


def _run_comparison(ticker, path, config):
    raw = path.read_bytes()
    expected_sha = hashlib.sha256(raw).hexdigest()
    env = os.environ.copy()
    env['PATH'] = '/root/.nvm/versions/node/v24.19.0/bin:' + env.get('PATH', '')
    with tempfile.TemporaryDirectory(prefix='jarvis-ml-compare-') as directory:
        current = Path(directory) / 'config.json'
        current.write_text(json.dumps(config))
        try:
            result = subprocess.run(['node', '--import', 'tsx', str(ROOT/'scripts/ml_candidate_compare.ts'),
                '--candidate', str(path), '--sha256', expected_sha, '--current-config', str(current)],
                cwd=ROOT, env=env, capture_output=True, text=True, timeout=660, check=True)
        except (OSError, subprocess.SubprocessError) as exc:
            return {'schemaVersion': 2, 'status': 'error', 'ticker': ticker,
                'candidate': str(path.relative_to(ROOT)), 'candidateSha256': expected_sha,
                'selectedThreshold': None, 'evaluatedAt': now(), 'scope': 'temporal_threshold_holdout',
                'applyEligible': False, 'recommendation': 'INSUFFICIENT_EVIDENCE', 'reason': str(exc)[:500]}
    marker = next((line for line in reversed(result.stdout.splitlines()) if line.startswith('ML_CANDIDATE_RESULT=')), None)
    if marker is None:
        raise ValueError('Candidate comparison result missing')
    comparison = json.loads(marker.split('=', 1)[1])
    if comparison.get('candidateSha256') != expected_sha or hashlib.sha256(path.read_bytes()).hexdigest() != expected_sha:
        raise ValueError('Candidate changed during comparison')
    return comparison


def compare_existing(ticker):
    if not ticker or not ticker.isalnum():
        raise ValueError('Invalid ticker')
    roster = snapshot()['assets']
    if ticker not in roster or not roster[ticker]['trade']:
        raise ValueError('Ticker is not a TRADE asset')
    path = latest_candidate(ticker)
    if path is None:
        raise ValueError('No calibration candidate exists')
    state = read_status()
    row = state['assets'].setdefault(ticker, {})
    prior_binding = row.get('candidate')
    preserve_comparison(row, row.copy(), ticker, roster[ticker]['config'])
    if prior_binding and prior_binding.get('path') == str(path.relative_to(ROOT)) and prior_binding.get('sha256') != hashlib.sha256(path.read_bytes()).hexdigest():
        row['comparison'] = {'schemaVersion': 2, 'status': 'unavailable', 'ticker': ticker,
            'candidate': row['candidate']['path'], 'candidateSha256': row['candidate']['sha256'],
            'scope': 'temporal_threshold_holdout', 'recommendation': 'INSUFFICIENT_EVIDENCE',
            'reason': 'Immutable candidate raw bytes changed since saved binding'}
        save(state)
        return row['comparison']
    _, issue = candidate_binding(ticker, roster[ticker]['config'])
    if issue:
        save(state)
        return row['comparison']
    row['comparison'] = run_comparison(ticker, path, roster[ticker]['config'])
    # Re-snapshot production after the replay: a concurrent config edit invalidates it.
    latest = snapshot()['assets'].get(ticker)
    preserve_comparison(row, row.copy(), ticker, latest['config'] if latest else {})
    save(state)
    return row['comparison']


def refresh():
    roster = snapshot()['assets']
    previous = read_status().get('assets', {})
    state = {'assets': {}, 'state': 'RUNNING', 'startedAt': now(),
             'schemaVersion': 2, 'thresholdProtocol': THRESHOLD_PROTOCOL}
    for ticker, asset in roster.items():
        state['assets'][ticker] = {**previous.get(ticker, {}), 'trade': asset['trade'],
            'ready': False, 'state': 'PENDING' if asset['trade'] else 'NOT_TRADE'}
    save(state)
    for ticker, asset in roster.items():
        if not asset['trade']:
            state['assets'][ticker].update(reason='Fuera de TRADE (enabled/disabledReason)', updatedAt=now())
            preserve_comparison(state['assets'][ticker], previous.get(ticker, {}), ticker, asset.get('config') or {})
            continue
        try:
            data, old, _, _ = collect(ticker, asset)
            result = readiness(data, old)
            result['trade'] = True
            if 'job' in previous.get(ticker, {}):
                result['job'] = previous[ticker]['job']
                if result['job'].get('state') in ('RUNNING', 'QUEUED'):
                    result['job'] = {'state': 'INTERRUPTED', 'reason': 'Worker anterior interrumpido; estado recuperado', 'finishedAt': now()}
            preserve_comparison(result, previous.get(ticker, {}), ticker, asset['config'])
            state['assets'][ticker] = result
        except Exception as exc:
            state['assets'][ticker] = {'state': 'ERROR', 'trade': True, 'ready': False,
                'reason': str(exc)[:500], 'updatedAt': now()}
            preserve_comparison(state['assets'][ticker], previous.get(ticker, {}), ticker, asset['config'])
        save(state)
    state.update(state='IDLE', updatedAt=now())
    save(state)


def recalibrate(ticker, bootstrap=False):
    import train_ml_model as trainer
    roster = snapshot()['assets']
    if ticker not in roster or not roster[ticker]['trade']:
        raise ValueError('Ticker is not an official TRADE asset')
    state = read_status()
    row = state['assets'].setdefault(ticker, {})
    row['job'] = {'state': 'RUNNING', 'startedAt': now()}
    save(state)
    try:
        data, old, path, old_bytes = collect(ticker, roster[ticker])
        result = readiness(data, old)
        state['assets'][ticker] = {**result, 'trade': True, 'job': row['job']}
        if not result['ready'] or (result.get('bootstrapRequired') and not bootstrap):
            raise trainer.InsufficientSamples(result.get('reason', 'Explicit bootstrap confirmation required'))
        if old_bytes is not None and path.read_bytes() != old_bytes:
            raise ValueError('Active model changed during collection')
        output = CACHE / 'candidates' / f'{ticker}-{now()}.json'
        output.parent.mkdir(parents=True, exist_ok=True)
        candidate = trainer.train_candidate(training_data(data), output, ticker, old, roster[ticker]['config'],
                                            min_train_samples=MIN_TRAIN, min_validation_samples=MIN_CALIBRATION,
                                            min_new_trades=15, force=bool(bootstrap and result.get('bootstrapRequired')),
                                            threshold_calibration_protocol=dict(THRESHOLD_PROTOCOL))
        # Explicit user-confirmed unknown-provenance bootstrap only; known-data
        # freshness and identical-source guards are never bypassed.
        state['assets'][ticker].update(ready=False, bootstrapRequired=False, state='CALIBRATED',
            reason='Candidato generado; se requieren datos nuevos para recalibrar otra vez')
        state['assets'][ticker]['job'] = {'state': 'CANDIDATE_SAVED', 'finishedAt': now(),
            'candidate': str(output.relative_to(ROOT)), 'promoted': False,
            'recommendation': 'NEEDS_RETURN_VALIDATION',
            'reason': 'Un solo entrenamiento; selección .50/.65/.80 en B y comprobación posterior en C, sin activación.'}
        preserve_comparison(state['assets'][ticker], {}, ticker, roster[ticker]['config'])
        save(state)
        state['assets'][ticker]['comparison'] = run_comparison(ticker, output, roster[ticker]['config'])
        latest = snapshot()['assets'].get(ticker)
        preserve_comparison(state['assets'][ticker], state['assets'][ticker].copy(), ticker, latest['config'] if latest else {})
    except trainer.InsufficientSamples as exc:
        state['assets'][ticker]['job'] = {'state': 'HOLD', 'reason': str(exc), 'finishedAt': now(), 'promoted': False}
    except Exception as exc:
        state['assets'][ticker]['job'] = {'state': 'ERROR', 'reason': str(exc)[:500], 'finishedAt': now(), 'promoted': False}
    save(state)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['refresh', 'recalibrate', 'compare'])
    parser.add_argument('--ticker')
    parser.add_argument('--bootstrap', action='store_true', help='explicit user confirmation of unknown provenance only')
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    with (CACHE / 'worker.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 3
        try:
            if args.action == 'refresh':
                refresh()
            elif args.action == 'compare':
                print(json.dumps(compare_existing(args.ticker), allow_nan=False))
            else:
                recalibrate(args.ticker, args.bootstrap)
            return 0
        except Exception as exc:
            state = read_status()
            state.update(state='ERROR', reason=str(exc)[:500], updatedAt=now())
            save(state)
            traceback.print_exc()
            return 1


if __name__ == '__main__':
    raise SystemExit(main())
