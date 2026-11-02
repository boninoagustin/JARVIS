"""Retrospective research WFA v2; not prospective evidence or execution permission.

All windows are half-open and anchored ONLY to caller-supplied M5 coverage (end
is last M5 timestamp + 1). Gap/embargo do not guarantee label purging; actual
close/availability filtering and context-only execution resets belong to worker.
Warmup/readiness is not certified here. No wall clock or HTF tail is consulted.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math

DAY = 86_400_000
HOUR = 3_600_000
MAX_SAFE_INTEGER = 2**53 - 1
DEFAULT_POLICY = {
    'is_days': 21, 'oos_days': 7, 'step_days': 7, 'history_days': 56,
    'warmup_days': 14, 'gap_hours': 8, 'embargo_hours': 12,
    'inner_validation_days': 7,
    'min_context_observations': {'5': 60, '15': 60, '60': 60, '240': 60, 'D': 60},
}


def _integer(value, name, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_SAFE_INTEGER:
        raise ValueError(f'{name}: expected nonnegative safe integer >= {minimum}')
    return value


def _duration(policy, key):
    return int(policy[key] * (HOUR if key.endswith('hours') else DAY))


def _policy(override):
    if override is not None and not isinstance(override, dict):
        raise ValueError('policy must be a dictionary')
    override = {} if override is None else override
    if set(override) - set(DEFAULT_POLICY):
        raise ValueError('unknown policy fields')
    p = deepcopy(DEFAULT_POLICY)
    p.update(deepcopy(override))
    for key in set(p) - {'min_context_observations'}:
        value = p[key]
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError('policy duration must be finite nonnegative numeric')
        if value == 0 and key not in ('warmup_days', 'gap_hours'):
            raise ValueError('policy duration must be positive')
        p[key] = int(value) if value == int(value) else value
        milliseconds = p[key] * (HOUR if key.endswith('hours') else DAY)
        if milliseconds > MAX_SAFE_INTEGER or milliseconds != int(milliseconds):
            raise ValueError('policy duration must resolve to safe integer milliseconds')
    counts = p['min_context_observations']
    if not isinstance(counts, dict) or set(counts) != {'5', '15', '60', '240', 'D'}:
        raise ValueError('min_context_observations requires exact TF keys')
    for key, value in counts.items():
        if type(value) is float and math.isfinite(value) and value.is_integer():
            value = counts[key] = int(value)
        _integer(value, key, 1)
    if p['step_days'] < p['oos_days']:
        raise ValueError('step_days must be >= oos_days: OOS cannot overlap')
    if p['inner_validation_days'] * DAY + p['embargo_hours'] * HOUR >= p['is_days'] * DAY:
        raise ValueError('IS must contain nonempty inner training, embargo and validation')
    return p


def _fingerprint(plan):
    payload = {key: value for key, value in plan.items() if key != 'fingerprint'}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def build_wfa_plan(ticker: str, m5_start_ms: int, m5_end_ms: int, *, policy: dict | None = None) -> dict:
    """Reserve the last OOS duration as blocked Vault, never shift it for fit.

    A short history with one development fold is coverage-only; gates require at
    least two development folds. History caps the entire development IS/OOS span.
    """
    if not isinstance(ticker, str) or not ticker.strip():
        raise ValueError('ticker must be nonempty')
    start = _integer(m5_start_ms, 'm5_start_ms')
    end = _integer(m5_end_ms, 'm5_end_ms')
    if start >= end:
        raise ValueError('M5 coverage must be increasing')
    p = _policy(policy)
    lower = max(start, end - _duration(p, 'history_days'))
    vault_start = end - _duration(p, 'oos_days')
    folds = []
    oos_end = vault_start
    while True:
        oos_start = oos_end - _duration(p, 'oos_days')
        is_end = oos_start - _duration(p, 'gap_hours')
        is_start = is_end - _duration(p, 'is_days')
        if is_start < lower:
            break
        val_start = is_end - _duration(p, 'inner_validation_days')
        folds.append(dict(id=0, is_start_ms=is_start, is_end_ms=is_end,
                          inner_train_end_ms=val_start - _duration(p, 'embargo_hours'),
                          inner_validation_start_ms=val_start, oos_start_ms=oos_start,
                          oos_end_ms=oos_end, fit_asof_ms=is_end,
                          context_policy='context-only-reset-execution-v1'))
        oos_end -= _duration(p, 'step_days')
    if not folds:
        raise ValueError('insufficient M5 history for one development fold plus fixed Vault')
    folds.reverse()
    for i, fold in enumerate(folds, 1):
        fold['id'] = i
    plan = dict(version=2, kind='rolling_wfa_shadow', ticker=ticker, clock='M5',
                coverage=dict(m5_start_ms=start, m5_end_ms=end), policy=p, folds=folds,
                vault=dict(from_ms=vault_start, to_ms=end, independence='unverified', access='blocked'),
                apply_eligible=False)
    plan['fingerprint'] = _fingerprint(plan)
    return plan


def validate_wfa_plan(plan) -> dict:
    """Strict canonical identity check, including all policy-derived boundaries."""
    fields = {'version', 'kind', 'ticker', 'clock', 'coverage', 'policy', 'folds',
              'vault', 'apply_eligible', 'fingerprint'}
    if not isinstance(plan, dict) or set(plan) != fields:
        raise ValueError('invalid WFA top-level fields')
    if not isinstance(plan['folds'], list) or any(not isinstance(f, dict) for f in plan['folds']):
        raise ValueError('folds must be a list of dictionaries')
    coverage = plan['coverage']
    if not isinstance(coverage, dict) or set(coverage) != {'m5_start_ms', 'm5_end_ms'}:
        raise ValueError('invalid coverage fields')
    if not isinstance(plan['policy'], dict) or set(plan['policy']) != set(DEFAULT_POLICY):
        raise ValueError('plan policy must be complete')
    expected = build_wfa_plan(plan['ticker'], coverage['m5_start_ms'], coverage['m5_end_ms'], policy=plan['policy'])
    try:
        # JSON comparison distinguishes bools/floats from integers, unlike dict ==.
        encoded = json.dumps(plan, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        canonical = json.dumps(expected, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError('WFA plan must be finite JSON') from exc
    if encoded != canonical or plan['fingerprint'] != _fingerprint(plan):
        raise ValueError('WFA fingerprint, fields or chronology mismatch')
    return deepcopy(expected)


def resolve_fold(plan, fold_id) -> dict:
    checked = validate_wfa_plan(plan)
    _integer(fold_id, 'fold_id')
    if fold_id == 0:
        p = checked['policy']
        start, end = checked['vault']['from_ms'], checked['vault']['to_ms']
        ie = start - _duration(p, 'gap_hours')
        vs = ie - _duration(p, 'inner_validation_days')
        return dict(id=0, is_start_ms=ie-_duration(p, 'is_days'), is_end_ms=ie,
                    inner_train_end_ms=vs-_duration(p, 'embargo_hours'),
                    inner_validation_start_ms=vs, oos_start_ms=start,
                    oos_end_ms=end, fit_asof_ms=ie,
                    context_policy='context-only-reset-execution-v1')
    if fold_id > len(checked['folds']):
        raise ValueError('unknown fold_id')
    return deepcopy(checked['folds'][fold_id - 1])


def assert_window_access(plan, from_ms, to_ms, *, role: str, fold_id: int) -> None:
    fold = resolve_fold(plan, fold_id)
    if fold_id == 0 and role == 'outer_oos':
        raise ValueError('Vault evaluation is blocked')
    bounds = {'inner_train': (fold['is_start_ms'], fold['inner_train_end_ms']),
              'inner_validation': (fold['inner_validation_start_ms'], fold['is_end_ms']),
              'is': (fold['is_start_ms'], fold['is_end_ms']),
              'outer_oos': (fold['oos_start_ms'], fold['oos_end_ms'])}
    _integer(from_ms, 'from_ms')
    _integer(to_ms, 'to_ms')
    if not isinstance(role, str) or role not in bounds or (from_ms, to_ms) != bounds[role]:
        raise ValueError('window access requires the exact registered role/fold bounds; Vault blocked')
