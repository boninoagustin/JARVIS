#!/usr/bin/env python3
"""Read-only production ML readiness; isolated candidates only, never promotion.
Run with hyperopt/.venv Python. A cross-process lock serializes refresh and fits.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import traceback

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data/ml_calibration'
STATUS = CACHE / 'status.json'
MIN_TRAIN = 50  # MLFilter.ts runtime model-load minimum
MIN_VALIDATION = 20


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
    result = {'train': partition(data['train'], MIN_TRAIN), 'validation': partition(data['validation'], MIN_VALIDATION),
              'ready': False, 'state': 'INSUFFICIENT', 'updatedAt': now(),
              'manifest': data['manifest'], 'counts': data['counts'],
              'recommendation': 'NOT_EVALUATED', 'minimumTrain': MIN_TRAIN, 'minimumValidation': MIN_VALIDATION}
    try:
        for name, minimum in (('train', MIN_TRAIN), ('validation', MIN_VALIDATION)):
            trainer.guard_samples(data[name], name, minimum)
        trainer.guard_freshness(data, old, 15, False)
        result.update(ready=True, state='READY', reason='Muestras y procedencia suficientes; candidato sin activar')
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
    data = trainer.collect_temporal_trades(directory, ticker, config)
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


def refresh():
    roster = snapshot()['assets']
    previous = read_status().get('assets', {})
    state = {'assets': {}, 'state': 'RUNNING', 'startedAt': now()}
    for ticker, asset in roster.items():
        state['assets'][ticker] = {**previous.get(ticker, {}), 'trade': asset['trade'],
            'ready': False, 'state': 'PENDING' if asset['trade'] else 'NOT_TRADE'}
    save(state)
    for ticker, asset in roster.items():
        if not asset['trade']:
            state['assets'][ticker].update(reason='Fuera de TRADE (enabled/disabledReason)', updatedAt=now())
            continue
        try:
            data, old, _, _ = collect(ticker, asset)
            result = readiness(data, old)
            result['trade'] = True
            if 'job' in previous.get(ticker, {}):
                result['job'] = previous[ticker]['job']
                if result['job'].get('state') in ('RUNNING', 'QUEUED'):
                    result['job'] = {'state': 'INTERRUPTED', 'reason': 'Worker anterior interrumpido; estado recuperado', 'finishedAt': now()}
            state['assets'][ticker] = result
        except Exception as exc:
            state['assets'][ticker] = {'state': 'ERROR', 'trade': True, 'ready': False,
                'reason': str(exc)[:500], 'updatedAt': now()}
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
        candidate = trainer.train_candidate(data, output, ticker, old, roster[ticker]['config'],
                                            min_train_samples=MIN_TRAIN, min_validation_samples=MIN_VALIDATION,
                                            min_new_trades=15, force=bool(bootstrap and result.get('bootstrapRequired')))
        # Explicit user-confirmed unknown-provenance bootstrap only; known-data
        # freshness and identical-source guards are never bypassed.
        state['assets'][ticker].update(ready=False, bootstrapRequired=False, state='CALIBRATED',
            reason='Candidato generado; se requieren datos nuevos para recalibrar otra vez')
        state['assets'][ticker]['job'] = {'state': 'CANDIDATE_SAVED', 'finishedAt': now(),
            'candidate': str(output.relative_to(ROOT)), 'promoted': False,
            'recommendation': 'NEEDS_RETURN_VALIDATION',
            'reason': 'Candidato aislado; falta validación PnL fuera de muestra. No se activó el gate.'}
    except trainer.InsufficientSamples as exc:
        state['assets'][ticker]['job'] = {'state': 'HOLD', 'reason': str(exc), 'finishedAt': now(), 'promoted': False}
    except Exception as exc:
        state['assets'][ticker]['job'] = {'state': 'ERROR', 'reason': str(exc)[:500], 'finishedAt': now(), 'promoted': False}
    save(state)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['refresh', 'recalibrate'])
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
