"""Durable successful-selection state, independent of latest attempt reports.

A checkpoint is selection evidence, not deployment permission. Never promote legacy
attempt timestamps to input watermarks. Missing/corrupt evidence requires evaluation.
"""
from __future__ import annotations
import copy
import json
import os
from pathlib import Path
import tempfile

SUCCESS_STATUSES = {'HOLD', 'RECOMMEND', 'HOLD_MC', 'HOLD_DSR'}


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2, allow_nan=False, default=str)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def successful_selection(report: dict, validate) -> bool:
    if not isinstance(report, dict) or report.get('status') not in SUCCESS_STATUSES:
        return False
    if report.get('selection_outcome') == 'skipped':
        return False
    if any(k.endswith('_error') for k in report):
        return False
    if not isinstance(report.get('proposal_validation'), dict) or not report['proposal_validation']:
        return False
    if not isinstance(report.get('production_validation'), dict) or not report['production_validation']:
        return False
    provenance = report.get('evaluation_provenance') or {}
    if not provenance.get('dataset_files') or not report.get('evaluation_certificate'):
        return False
    if (report.get('montecarlo') or {}).get('error'):
        return False
    try:
        return bool(validate(copy.deepcopy(report)))
    except Exception:
        # Hash tooling failure is not proof that a saved candidate is valid.
        return False


def load_checkpoint(path: Path, ticker: str, validate) -> dict | None:
    try:
        state = json.loads(path.read_text())
        watermark = state['watermark']
        candidate = state['candidate']
        if (state.get('version') != 1 or state.get('ticker') != ticker
                or candidate.get('ticker') != ticker
                or not all(type(watermark.get(k)) is int and watermark[k] >= 0
                           for k in ('candle_ms', 'journal_since_ms'))
                or watermark['journal_since_ms'] != candidate.get('timestamp')
                or not successful_selection(candidate, validate)):
            return None
        return state
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def needs_selection(state: dict | None, candle_ms: int, new_trades: int,
                    min_new_trades: int = 20) -> bool:
    # Unknown candle input is not proof of unchanged data.
    return (state is None or candle_ms <= 0
            or candle_ms != state['watermark']['candle_ms']
            or new_trades >= max(1, min_new_trades))


def save_success(path: Path, report: dict, candle_ms: int, validate) -> dict | None:
    if not successful_selection(report, validate):
        return None
    state = {'version': 1, 'ticker': report['ticker'],
             'watermark': {'candle_ms': candle_ms, 'journal_since_ms': report['timestamp']},
             'candidate': copy.deepcopy(report)}
    atomic_json(path, state)
    return state


def previous_selection(state: dict | None, path: Path) -> dict | None:
    if state is None:
        return None
    candidate = state['candidate']
    return {'path': str(path), 'timestamp': candidate['timestamp'],
            'status': candidate['status'], 'config_fingerprint': candidate.get('config_fingerprint'),
            'evaluation_fingerprint': candidate.get('evaluation_fingerprint'),
            'watermark': copy.deepcopy(state['watermark']), 'fresh_for_this_attempt': False,
            'apply_eligible': False}
