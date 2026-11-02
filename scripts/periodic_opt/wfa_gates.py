"""Experimental retrospective WFA shadow diagnostics; no production actions.

Stationary blocks model closed-trade/calendar dependence, not account-equity
limits. A positive final bootstrap PnL is NOT a drawdown/sizing guarantee.
"""
from __future__ import annotations

import math
import random
from copy import deepcopy
from pathlib import Path
import sys

# Both package and direct-script callers resolve the same canonical source.
try:
    from scripts.hyperopt.metrics import compute_metrics, to_dict
except ModuleNotFoundError as exc:
    if exc.name not in ('scripts', 'scripts.hyperopt', 'scripts.hyperopt.metrics'):
        raise
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from scripts.hyperopt.metrics import compute_metrics, to_dict

GATE_POLICY = {
    'version': 'wfa_gates_shadow_v1', 'experimental': True,
    'min_n': 25, 'min_folds': 2, 'min_wfe': .45, 'max_wfe': None,
    'min_expectancy': .10, 'min_positive_fold_fraction': .75,
    'max_fold_drawdown_r': 4, 'min_dsr': .90, 'min_mc_survival': .85,
    'min_delta_expectancy': .06, 'max_dd_ratio': 1.05,
    'min_dd_improvement': .20, 'min_net_pnl_retention': .90,
}


def _gate_policy(override):
    if override is not None and not isinstance(override, dict):
        raise ValueError('gate policy must be a dictionary')
    override = {} if override is None else override
    if set(override) - set(GATE_POLICY):
        raise ValueError('unknown gate policy field')
    p = deepcopy(GATE_POLICY)
    p.update(deepcopy(override))
    if p['version'] != GATE_POLICY['version'] or p['experimental'] is not True:
        raise ValueError('unsupported gate policy version or experimental flag')
    for key in ('min_n', 'min_folds'):
        if type(p[key]) is not int or p[key] < (25 if key == 'min_n' else 2):
            raise ValueError(f'{key} cannot relax the minimum evidence requirement')
    for key in set(p) - {'version', 'experimental', 'min_n', 'min_folds'}:
        if key == 'max_wfe' and p[key] is None:
            continue
        p[key] = _number(p[key], key)
        if p[key] < 0:
            raise ValueError(f'{key} must be nonnegative')
    for key in ('min_positive_fold_fraction', 'min_dsr', 'min_mc_survival',
                'min_dd_improvement', 'min_net_pnl_retention'):
        if p[key] > 1:
            raise ValueError(f'{key} must be <= 1')
    if p['max_wfe'] is not None and p['max_wfe'] < p['min_wfe']:
        raise ValueError('max_wfe must be >= min_wfe')
    return p


def summarize_series(records: list[dict], start_ms: int, end_ms: int) -> dict:
    """Reject out-of-window entries/closes; never silently lose observations.

    Canonical compute_metrics orders by closure and computes all R statistics.
    Record censoring/availability before calling this API is caller-owned.
    """
    for value in (start_ms, end_ms):
        if type(value) is not int or not 0 <= value <= 2**53 - 1:
            raise ValueError('bounds must be nonnegative safe integer milliseconds')
    if start_ms >= end_ms or not isinstance(records, list):
        raise ValueError('expected increasing half-open bounds and record list')
    for row in records:
        if not isinstance(row, dict):
            raise ValueError('record must be a dictionary')
        for key in ('timestamp', 'closeTimestamp'):
            value = row.get(key)
            if type(value) is not int or not start_ms <= value < end_ms:
                raise ValueError(f'{key} outside half-open bounds or not an integer')
        if row['closeTimestamp'] < row['timestamp'] or row.get('rMultiple') is None:
            raise ValueError('record requires closed finite R and close >= entry')
        _number(row['rMultiple'], 'rMultiple')
    return to_dict(compute_metrics(records, time_bounds=(start_ms, end_ms)))


_ALIASES = {'trade_count': ('trade_count', 'n', 'trades'),
            'expectancy': ('expectancy', 'exp'),
            'max_drawdown_r': ('max_drawdown_r', 'max_dd', 'dd'),
            'net_pnl_r': ('net_pnl_r', 'net_pnl', 'netPnl')}


def _metric(row):
    if not isinstance(row, dict):
        raise ValueError('metrics must be a dictionary')
    out = {}
    for key, aliases in _ALIASES.items():
        present = [row[a] for a in aliases if a in row]
        if not present:
            raise ValueError(f'missing {key}')
        values = [_number(v, key) for v in present]
        if any(v != values[0] for v in values):
            raise ValueError(f'conflicting aliases for {key}')
        if key == 'trade_count' and any(type(v) is not int or v < 0 for v in present):
            raise ValueError('trade_count must be nonnegative integer')
        if key == 'max_drawdown_r' and values[0] < 0:
            raise ValueError('drawdown must be nonnegative')
        out[key] = values[0]
    if out['trade_count'] == 0 and any(out[key] != 0 for key in _ALIASES if key != 'trade_count'):
        raise ValueError('zero trade_count requires zero expectancy, net PnL and drawdown')
    return out


def _probability(value, name):
    result = _number(value, name)
    if not 0 <= result <= 1:
        raise ValueError(f'{name} must be in [0,1]')
    return result


def _mc(result):
    if not isinstance(result, dict):
        raise ValueError('MC result must be a dictionary')
    if 'skip' in result and type(result['skip']) is not bool:
        raise ValueError('MC skip must be boolean')
    if result.get('survival') is not None:
        _probability(result['survival'], 'survival')
    for key in ('dd_p95', 'ruin_probability'):
        if result.get(key) is not None:
            value = _number(result[key], key)
            if value < 0 or (key == 'ruin_probability' and value > 1):
                raise ValueError(f'invalid {key}')
    if result.get('skip') is True:
        return None
    return _probability(result.get('survival'), 'survival')


def _dsr(result):
    if not isinstance(result, dict):
        raise ValueError('DSR result must be a dictionary')
    if 'skip' in result and type(result['skip']) is not bool:
        raise ValueError('DSR skip must be boolean')
    value = result.get('dsr')
    if value is not None:
        value = _probability(value, 'dsr')
    sigma = result.get('trials_sr_std')
    if sigma is not None and _number(sigma, 'trials_sr_std') < 0:
        raise ValueError('negative DSR calibration dispersion')
    if result.get('skip') is not False or value is None:
        return None
    context = result.get('calibration_context')
    # Scope is declared by provenance owner, never certified by this module.
    if not isinstance(context, dict) or context.get('valid') is not True or context.get('scope') != 'complete_selection':
        return None
    trials = result.get('trials', result.get('n_trials_reference'))
    if type(trials) is not int or trials <= 1:
        return None  # N=1 is PSR, not a multiple-selection correction.
    status = result.get('calibration_status')
    if status == 'provided' and sigma is not None:
        return value
    if status == 'benchmark_override' and result.get('selection_bar') is not None:
        _number(result['selection_bar'], 'selection_bar')
        return value
    return None


def evaluate_wfa_gates(prop_is: dict, prop_stitched: dict, prod_stitched: dict,
                       prop_folds: list[dict], dsr_result: dict, mc_prop: dict,
                       mc_prod: dict, *, paired_result: dict | None = None,
                       policy: dict | None = None) -> dict:
    """Common-OOS comparison only; all thresholds experimental, not validated.

    DSR requires skip=False, N>1 calibration plus caller-declared
    calibration_context={valid: True, scope: 'complete_selection'}. Missing
    calibration/scope is unknown, not a fabricated zero. Paired inference is
    diagnostic, not a significance claim or a mandatory promotion gate.
    """
    names = ('sample_size', 'fold_coverage', 'wfe', 'expectancy', 'fold_consistency',
             'fold_drawdown', 'dsr', 'mc_survival', 'superiority', 'paired_evidence')
    gates = dict.fromkeys(names)
    diagnostics = dict(threshold_status='experimental_not_validated',
                       research_role='retrospective_not_prospective',
                       no_actions=['OFF', 'HIBERNATION', 'SIZING', 'PROMOTION'],
                       dsr_scope_certified=False, paired_significance='not_evaluated',
                       unknown=[], errors=[])
    output = dict(status='HOLD_INVALID_DATA', gates=gates, failed=[],
                  changes_production=False, apply_eligible=False, diagnostics=diagnostics)
    try:
        p = _gate_policy(policy)
        diagnostics['policy'] = deepcopy(p)
        diagnostics['policy_version'] = p['version']
        ins, prop, prod = map(_metric, (prop_is, prop_stitched, prod_stitched))
        if not isinstance(prop_folds, list):
            raise ValueError('prop_folds must be a list')
        folds = [_metric(f) for f in prop_folds]
        surv_prop, surv_prod = _mc(mc_prop), _mc(mc_prod)
        dsr = _dsr(dsr_result)
        gates['sample_size'] = all(m['trade_count'] >= p['min_n'] for m in (ins, prop, prod))
        gates['fold_coverage'] = len(folds) >= p['min_folds']
        wfe = prop['expectancy'] / ins['expectancy'] if ins['expectancy'] > 0 else None
        if wfe is not None and not math.isfinite(wfe):
            raise ValueError('WFE overflow')
        diagnostics['wfe'] = wfe
        gates['wfe'] = None if wfe is None else (wfe >= p['min_wfe'] and
                            (p['max_wfe'] is None or wfe <= p['max_wfe']))
        gates['expectancy'] = prop['expectancy'] >= p['min_expectancy']
        empty_fold_indices = [i for i, f in enumerate(folds) if f['trade_count'] == 0]
        diagnostics['empty_fold_indices'] = empty_fold_indices
        # Calendar coverage is preserved, but an empty fold proves neither
        # consistency nor risk safety; do not substitute its canonical DD=0.
        fold_evidence = bool(folds) and not empty_fold_indices
        fraction = sum(f['net_pnl_r'] > 0 for f in folds) / len(folds) if fold_evidence else None
        max_dd = max(f['max_drawdown_r'] for f in folds) if fold_evidence else None
        diagnostics.update(positive_fold_fraction=fraction, max_fold_drawdown_r=max_dd,
                           stitched_drawdown_r=prop['max_drawdown_r'])
        gates['fold_consistency'] = None if fraction is None else fraction >= p['min_positive_fold_fraction']
        gates['fold_drawdown'] = None if max_dd is None else max_dd <= p['max_fold_drawdown_r']
        gates['dsr'] = None if dsr is None else dsr >= p['min_dsr']
        gates['mc_survival'] = None if surv_prop is None or surv_prod is None else (
            surv_prop >= p['min_mc_survival'] and surv_prop >= surv_prod)
        delta = prop['expectancy'] - prod['expectancy']
        if not math.isfinite(delta):
            raise ValueError('expectancy difference overflow')
        exp_route = delta >= p['min_delta_expectancy'] and prop['max_drawdown_r'] <= p['max_dd_ratio'] * prod['max_drawdown_r']
        dd_route = (prod['max_drawdown_r'] > 0 and
                    prop['max_drawdown_r'] <= (1 - p['min_dd_improvement']) * prod['max_drawdown_r'] and
                    prod['net_pnl_r'] > 0 and prop['net_pnl_r'] >= p['min_net_pnl_retention'] * prod['net_pnl_r'])
        gates['superiority'] = exp_route or dd_route
        diagnostics.update(delta_expectancy=delta, superiority_routes={'expectancy': exp_route, 'drawdown_net_retention': dd_route})
        if paired_result is not None:
            if not isinstance(paired_result, dict) or paired_result.get('scope') != 'paired_calendar' or type(paired_result.get('skip')) is not bool:
                raise ValueError('invalid paired calendar result')
            supplied_ci = paired_result.get('delta_mean_ci95')
            if supplied_ci is not None:
                if not isinstance(supplied_ci, list) or len(supplied_ci) != 2:
                    raise ValueError('paired CI requires two finite bounds')
                for bound in supplied_ci:
                    _number(bound, 'paired CI')
            if paired_result.get('prob_delta_positive') is not None:
                _probability(paired_result['prob_delta_positive'], 'paired probability')
            if not paired_result['skip']:
                ci = paired_result.get('delta_mean_ci95')
                if not isinstance(ci, list) or len(ci) != 2:
                    raise ValueError('paired CI requires two finite bounds')
                lo, hi = (_number(v, 'paired CI') for v in ci)
                if lo > hi:
                    raise ValueError('paired CI bounds reversed')
                probability = _probability(paired_result.get('prob_delta_positive'), 'paired probability')
                gates['paired_evidence'] = lo > 0
                diagnostics.update(paired_significance='diagnostic_only_not_a_required_gate',
                                   paired={'delta_mean_ci95': [lo, hi], 'prob_delta_positive': probability})
        required = [key for key in names if key != 'paired_evidence']
        output['failed'] = [key for key in required if gates[key] is False]
        diagnostics['unknown'] = [key for key in required if gates[key] is None]
        insufficient = not gates['sample_size'] or not gates['fold_coverage'] or bool(diagnostics['unknown'])
        output['status'] = ('HOLD_INSUFFICIENT_DATA' if insufficient else
                            'HOLD' if output['failed'] else 'RECOMMEND_SHADOW')
    except (ValueError, TypeError, OverflowError) as exc:
        diagnostics['errors'].append(str(exc))
        output['failed'] = [key for key, value in gates.items() if value is False]
    return output


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'{name}: expected finite numeric value (not boolean)')
    try:
        value = float(value)
    except OverflowError as exc:
        raise ValueError(f'{name}: overflow') from exc
    if not math.isfinite(value):
        raise ValueError(f'{name}: expected finite number')
    return value


def _values(values):
    if not isinstance(values, list):
        raise ValueError('returns must be a list')
    return [_number(value, 'return') for value in values]


def _bootstrap_options(iterations, mean_block_size, seed):
    if type(iterations) is not int or iterations < 1:
        raise ValueError('iterations must be a positive integer')
    if type(seed) is not int:
        raise ValueError('seed must be an integer')
    block = _number(mean_block_size, 'mean_block_size')
    if block < 1:
        raise ValueError('mean_block_size must be >= 1')
    return block


def _indices(n, block, rng):
    """Uniform starts, geometric block lengths, circular support (Politis/Romano)."""
    index = rng.randrange(n)
    for i in range(n):
        if i:
            index = rng.randrange(n) if rng.random() < 1.0 / block else (index + 1) % n
        yield index


def _quantile(values, p):
    ordered = sorted(values)
    position = (len(ordered) - 1) * p
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def stationary_bootstrap(returns: list[float], *, iterations: int = 1000,
                         mean_block_size: float = 5.0, seed: int = 42,
                         ruin_r: float = 10.0) -> dict:
    values = _values(returns)
    block = _bootstrap_options(iterations, mean_block_size, seed)
    threshold = _number(ruin_r, 'ruin_r')
    if threshold <= 0:
        raise ValueError('ruin_r must be positive')
    result = dict(survival=None, ruin_probability=None, dd_p95=None, seed=seed,
                  method='stationary', mean_block_size=block, iterations=iterations,
                  n=len(values), skip=len(values) < 10, ruin_r=threshold,
                  survival_definition='P(final closed-trade PnL > 0), NOT account DD guarantee',
                  ruin_definition='P(max closed-trade peak-to-trough DD >= ruin_r)',
                  reason='insufficient_observations' if len(values) < 10 else None)
    if result['skip']:
        return result
    rng = random.Random(seed)
    positive = ruined = 0
    drawdowns = []
    for _ in range(iterations):
        equity = peak = dd = 0.0
        for index in _indices(len(values), block, rng):
            equity += values[index]
            peak = max(peak, equity)
            dd = max(dd, peak - equity)
            if not math.isfinite(equity) or not math.isfinite(dd):
                raise ValueError('bootstrap aggregate overflow')
        positive += equity > 0
        ruined += dd >= threshold
        drawdowns.append(dd)
    result.update(survival=positive / iterations, ruin_probability=ruined / iterations,
                  dd_p95=_quantile(drawdowns, 0.95))
    return result


def paired_calendar_bootstrap(prop_daily: list[float], prod_daily: list[float], *,
                              iterations: int = 1000, mean_block_size: float = 5.0,
                              seed: int = 42) -> dict:
    """Caller supplies aligned complete calendar vectors (including inactive 0s).

    Index sequences are shared, never pair different strategies by trade index.
    Alignment cannot be inferred from two unlabelled vectors and is caller-owned.
    """
    prop, prod = _values(prop_daily), _values(prod_daily)
    block = _bootstrap_options(iterations, mean_block_size, seed)
    if len(prop) != len(prod):
        raise ValueError('paired calendar vectors must have equal lengths')
    result = dict(delta_mean_ci95=None, prob_delta_positive=None, scope='paired_calendar',
                  seed=seed, skip=len(prop) < 10, n=len(prop), iterations=iterations,
                  method='stationary', mean_block_size=block,
                  reason='insufficient_observations' if len(prop) < 10 else None)
    if result['skip']:
        return result
    delta = [a - b for a, b in zip(prop, prod)]
    if not all(math.isfinite(v) for v in delta):
        raise ValueError('paired difference overflow')
    rng = random.Random(seed)
    means = []
    for _ in range(iterations):
        value = math.fsum(delta[i] / len(delta) for i in _indices(len(delta), block, rng))
        if not math.isfinite(value):
            raise ValueError('paired aggregate overflow')
        means.append(value)
    result.update(delta_mean_ci95=[_quantile(means, .025), _quantile(means, .975)],
                  prob_delta_positive=sum(v > 0 for v in means) / iterations)
    return result
