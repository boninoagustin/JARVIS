"""Canonical closed-trade R statistics. Stdlib only; risk_v2 is NEVER a selector.

Legacy fields/score reproduce the worker on the same valid, close-ordered trades.
Calendar diagnostics require externally fixed half-open millisecond bounds; they
are never inferred from a candidate. Ulcer is by trade, not time under water.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass, field
import math
from statistics import NormalDist
from typing import Iterable, Optional

OBJECTIVE_VERSION = 'legacy_v1'
SHADOW_VERSION = 'risk_v2_shadow'
OBJECTIVE_POLICY = {
    'selector_version': OBJECTIVE_VERSION,
    'legacy': {'pf_weight': 0.5, 'pf_cap': 5.0, 'gross_loss_scale_r': 5.0,
               'dd_penalty': 0.5, 'sample_penalty': 0.25, 'target_trades': 200,
               'expectancy_weight': 1.0, 'min_trades': 30, 'empty_score': -100.0},
    'shadow': {'version': SHADOW_VERSION, 'experimental': True, 'selector': False,
               'min_trades': 30, 'n_blocks': 4, 'bounds': 'fixed_manifest_half_open_ms',
               'weights': {'sortino': 0.45, 'expectancy': 1.2, 'dsr': 0.8,
                           'consistency': 0.8, 'block_sharpe': 0.35, 'dd_linear': 0.25,
                           'dd_soft': 0.6, 'dd_hard': 1.5, 'ulcer': 0.3, 'streak': 0.15},
               'dd_soft_r': 3.0, 'dd_hard_r': 4.5,
               'dd_note': 'experimental closed-trade R penalties, NOT prop-firm equity limits',
               'ratio_transform': 'tanh; positive no-downside contribution=1',
               'consistency': 'positive calendar blocks / all blocks (inactive != loss)',
               'block_sharpe': 'mean tanh(mean/population_sd); no-downside positive=1; unavailable=0',
               'ulcer_unit': 'R, root mean squared closed-trade drawdowns',
               'sample_policy': 'eligibility constraint; never alter legacy scoring',
               'dsr_policy': 'optional zero contribution if unavailable; fixed common posthoc N and sigma; never running TPE count'},
}


def objective_policy() -> dict:
    """Stable JSON policy for provenance/fingerprints; caller cannot mutate it."""
    return deepcopy(OBJECTIVE_POLICY)


@dataclass
class TradeMetrics:
    # Original 14 fields remain positional and required for existing callers.
    trade_count: int
    wins: int
    losses: int
    win_rate: float
    gross_profit_r: float
    gross_loss_r: float
    net_pnl_r: float
    profit_factor: float
    expectancy: float
    max_drawdown_r: float
    sharpe_simple: float
    avg_trade_r: float
    max_consec_losses: int
    max_consec_wins: int
    profit_factor_capped: float = 0.0
    sharpe_per_trade: float | None = None
    sortino_simple: float | None = None
    skewness: float = 0.0
    kurtosis: float = 3.0  # Pearson; fallback below n=4 is explicitly marked.
    std_r: float = 0.0
    ulcer_index_r: float = 0.0
    moment_status: str = 'unknown'
    temporal_status: str = 'unknown'
    ratio_status: dict = field(default_factory=dict)
    time_bounds: tuple[int, int] | None = None
    n_blocks: int = 4
    block_trade_counts: list[int] = field(default_factory=list)
    block_pnl_r: list[float] = field(default_factory=list)
    block_status: list[str] = field(default_factory=list)
    block_sharpe: list[float | None] = field(default_factory=list)
    block_sharpe_bounded: list[float] = field(default_factory=list)
    block_coverage: float | None = None
    consistency: float | None = None
    censored_count: int = 0


def _finite(value, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f'{name}: boolean is not a numeric observation')
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f'{name}: expected finite number') from exc
    if not math.isfinite(result):
        raise ValueError(f'{name}: expected finite number')
    return result


def _timestamp(t: dict, keys: tuple[str, ...]) -> float | None:
    for key in keys:
        if t.get(key) is not None:
            value = _finite(t[key], key)
            if not value.is_integer():
                raise ValueError(f'{key}: expected integer milliseconds')
            return value
    return None


def _moments(x: list[float]) -> tuple[float, float, float, float]:
    """Mean, population SD, unbiased skew, unbiased Pearson kurtosis.

    Below n=3 skew defaults to zero; below n=4 Pearson defaults to 3.
    Those defaults are not claims that a small/constant sample is Gaussian.
    """
    n = len(x)
    if not n:
        return 0.0, 0.0, 0.0, 3.0
    mean = sum(x) / n
    try:
        m2 = sum((v - mean) ** 2 for v in x) / n
        if not math.isfinite(m2):
            raise ValueError('non-finite variance')
        if m2 == 0:
            return mean, 0.0, 0.0, 3.0
        # Standardise before higher powers to reduce overflow risk.
        sd = math.sqrt(m2)
        g1 = sum(((v - mean) / sd) ** 3 for v in x) / n
        g2 = sum(((v - mean) / sd) ** 4 for v in x) / n - 3.0
        skew = math.sqrt(n * (n - 1)) / (n - 2) * g1 if n >= 3 else 0.0
        kurt = 3.0 + (n - 1) / ((n - 2) * (n - 3)) * ((n + 1) * g2 + 6) if n >= 4 else 3.0
    except OverflowError as exc:
        raise ValueError('moments overflow') from exc
    if not all(math.isfinite(v) for v in (mean, sd, skew, kurt)):
        raise ValueError('non-finite moments')
    return mean, sd, skew, kurt


def _bounded_block_sharpe(values: list[float]) -> tuple[float | None, float]:
    if not values:
        return None, 0.0
    mean, sd, _, _ = _moments(values)
    sr = mean / sd if len(values) > 1 and sd > 0 else None
    if mean > 0 and not any(v < 0 for v in values):
        return sr, 1.0  # Do not reward volatility amongst all-winning strategies.
    return sr, math.tanh(sr) if sr is not None else 0.0


def compute_metrics(trades: Iterable[dict], *, time_bounds: tuple[int, int] | None = None,
                    n_blocks: int = 4) -> TradeMetrics:
    """Closed trades only; missing R is censored, invalid numeric R raises.

    Input without complete close times preserves legacy input order and cannot
    receive a shadow score. Known times must satisfy close>=entry and bounds.
    Break-even trades intentionally do not reset either legacy streak.
    """
    if isinstance(n_blocks, bool) or not isinstance(n_blocks, int) or n_blocks < 1:
        raise ValueError('n_blocks must be a positive integer')
    if time_bounds is not None:
        if len(time_bounds) != 2:
            raise ValueError('time_bounds must contain start and end')
        start, end = (_finite(v, 'time_bounds') for v in time_bounds)
        if not start.is_integer() or not end.is_integer() or start >= end:
            raise ValueError('time_bounds must be increasing integer milliseconds')
        time_bounds = (int(start), int(end))
    rows = []
    censored = 0
    for i, trade in enumerate(trades):
        if trade.get('rMultiple') is None:
            censored += 1
            continue
        r = _finite(trade['rMultiple'], 'rMultiple')
        closed = _timestamp(trade, ('closeTimestamp', 'closedAt', 'closeTs'))
        entry = _timestamp(trade, ('timestamp', 'entryTimestamp', 'entryTs', 'openedAt'))
        if closed is not None:
            if entry is not None and closed < entry:
                raise ValueError('close timestamp precedes entry')
            if time_bounds is not None and not time_bounds[0] <= closed < time_bounds[1]:
                raise ValueError('close timestamp outside half-open bounds')
        rows.append((closed, entry, i, r))
    temporal_known = bool(rows) and all(row[0] is not None for row in rows)
    if temporal_known:
        rows.sort(key=lambda row: (row[0], row[1] if row[1] is not None else row[0], row[2]))
    values = [row[3] for row in rows]
    n = len(values)
    mean, sd, skew, kurt = _moments(values)
    gp = sum(r for r in values if r > 0)
    gl = sum(-r for r in values if r < 0)
    net = gp - gl
    if not all(math.isfinite(v) for v in (gp, gl, net)):
        raise ValueError('aggregate R overflow')
    mean = net / n if n else 0.0
    equity = peak = dd = drawdown_sq = 0.0
    cw = cl = mw = ml = 0
    for r in values:
        equity += r
        peak = max(peak, equity)
        drawdown = peak - equity
        dd = max(dd, drawdown)
        drawdown_sq += drawdown * drawdown
        if r > 0:
            cw += 1
            cl = 0
            mw = max(mw, cw)
        elif r < 0:
            cl += 1
            cw = 0
            ml = max(ml, cl)
    pf = gp / gl if gl > 0 else gp
    downside = math.sqrt(sum(min(r, 0.0) ** 2 for r in values) / n) if n else 0.0
    sr = mean / sd if sd > 0 and n > 1 else None
    sortino = mean / downside if downside > 0 else None
    result = TradeMetrics(n, sum(r > 0 for r in values), sum(r < 0 for r in values),
                          sum(r > 0 for r in values) / n if n else 0.0,
                          gp, gl, net, pf, mean, dd,
                          sr * math.sqrt(n) if sr is not None else 0.0, mean, ml, mw,
                          profit_factor_capped=min(pf, 5.0) * min(1.0, gl / 5.0), sharpe_per_trade=sr,
                          sortino_simple=sortino, skewness=skew, kurtosis=kurt, std_r=sd,
                          ulcer_index_r=math.sqrt(drawdown_sq / n) if n else 0.0,
                          moment_status='empty' if not n else 'zero_variance' if sd == 0 else 'insufficient_n' if n < 4 else 'estimated',
                          temporal_status='known' if temporal_known else 'unknown',
                          ratio_status={'sharpe_per_trade': 'estimated' if sr is not None else 'zero_variance' if n > 1 else 'insufficient_n',
                                        'sortino_simple': 'estimated' if sortino is not None else 'no_downside' if n else 'empty'},
                          time_bounds=time_bounds, n_blocks=n_blocks, censored_count=censored)
    if time_bounds is not None and (temporal_known or not n):
        blocks = [[] for _ in range(n_blocks)]
        start, end = time_bounds
        for closed, _, _, r in rows:
            idx = int((int(closed) - start) * n_blocks // (end - start))
            blocks[idx].append(r)
        result.block_trade_counts = [len(b) for b in blocks]
        result.block_pnl_r = [sum(b) for b in blocks]
        result.block_status = ['inactive' if not b else 'positive' if sum(b) > 0 else 'negative' if sum(b) < 0 else 'flat' for b in blocks]
        ratios = [_bounded_block_sharpe(b) for b in blocks]
        result.block_sharpe = [v[0] for v in ratios]
        result.block_sharpe_bounded = [v[1] for v in ratios]
        result.block_coverage = sum(bool(b) for b in blocks) / n_blocks
        result.consistency = sum(p > 0 for p in result.block_pnl_r) / n_blocks
    if not all(math.isfinite(v) for v in (result.sharpe_simple, result.ulcer_index_r, result.profit_factor)):
        raise ValueError('non-finite aggregate statistic')
    return result


def objective_function(metrics: TradeMetrics, min_trades: int = 30,
                       dd_penalty: float = 0.5, sample_penalty: float = 0.25,
                       target_trades: int = 200) -> float:
    """The sole selecting objective: exact worker legacy_v1 coefficients."""
    if metrics.trade_count < min_trades:
        if metrics.trade_count == 0:
            return -100.0
        return -10.0 * (1.0 - metrics.trade_count / min_trades)
    pf_honest = min(metrics.profit_factor, 5.0) * min(1.0, metrics.gross_loss_r / 5.0)
    return (0.5 * pf_honest - dd_penalty * metrics.max_drawdown_r
            - sample_penalty * abs(metrics.trade_count - target_trades) / target_trades
            + metrics.expectancy)


def shadow_objective(metrics: TradeMetrics, *, n_trials_reference: int | None = None,
                     trials_sr_std: float | None = None) -> dict:
    """Experimental diagnostics only. Missing DSR gives an explicit partial score.

    n_trials_reference and sigma must be common/fixed for posthoc comparisons,
    NEVER the running trial count. DSR assumes independent trials approximately;
    no invented N_eff or unit dispersion is used.
    """
    policy = OBJECTIVE_POLICY['shadow']
    reasons = []
    if metrics.trade_count < policy['min_trades']:
        reasons.append('insufficient_trades')
    if metrics.temporal_status != 'known':
        reasons.append('unknown_close_times')
    if metrics.time_bounds is None or metrics.consistency is None:
        reasons.append('missing_fixed_time_bounds')
    calibration = {'status': 'unavailable', 'n_trials_reference': n_trials_reference,
                   'trials_sr_std': trials_sr_std, 'note': policy['dsr_policy']}
    dsr_value = None
    if n_trials_reference is not None:
        diagnostic = _deflated_sharpe_stats(metrics.trade_count, metrics.expectancy,
                                           metrics.std_r, metrics.skewness, metrics.kurtosis,
                                           n_trials_reference, trials_sr_std=trials_sr_std)
        calibration.update(diagnostic)
        calibration['status'] = 'unavailable' if diagnostic['skip'] else 'available'
        dsr_value = diagnostic['dsr']
    no_downside = metrics.trade_count > 0 and metrics.gross_loss_r == 0 and metrics.expectancy > 0
    raw = {
        'sortino': 1.0 if no_downside else math.tanh(metrics.sortino_simple) if metrics.sortino_simple is not None else 0.0,
        'expectancy': metrics.expectancy,
        'dsr': dsr_value if dsr_value is not None else 0.0,
        'consistency': metrics.consistency or 0.0,
        'block_sharpe': sum(metrics.block_sharpe_bounded) / metrics.n_blocks if metrics.block_sharpe_bounded else 0.0,
        'dd_linear': -metrics.max_drawdown_r,
        'dd_soft': -max(0.0, metrics.max_drawdown_r - policy['dd_soft_r']) ** 2,
        'dd_hard': -max(0.0, metrics.max_drawdown_r - policy['dd_hard_r']) ** 2,
        'ulcer': -metrics.ulcer_index_r,
        'streak': -float(metrics.max_consec_losses),
    }
    components = {k: {'value': value, 'weight': policy['weights'][k],
                       'contribution': value * policy['weights'][k]} for k, value in raw.items()}
    components['dsr']['status'] = calibration['status']
    score = sum(c['contribution'] for c in components.values()) if not reasons else None
    if score is not None and not math.isfinite(score):
        reasons.append('non_finite_score')
        score = None
    return {'version': SHADOW_VERSION, 'eligible': not reasons, 'score': score,
            'reasons': reasons, 'components': components, 'calibration': calibration,
            'experimental': True, 'selector': False,
            'score_status': 'partial_without_dsr' if dsr_value is None else 'calibrated'}


EULER_MASCHERONI = 0.5772156649015328606


def norm_ppf(p: float) -> float:
    """Standard normal quantile (stdlib)."""
    return NormalDist().inv_cdf(p)


def norm_cdf(x: float) -> float:
    return NormalDist().cdf(x)


def expected_max_sr(n_trials: int) -> float:
    """Standard-normal expected maximum factor, NOT a calibrated SR bar.

    Approximately independent normal trial Sharpes: multiply by measured sigma_SR.
    This is an assumption about all N trials, not an empirical effective N.
    """
    if n_trials is None or n_trials <= 1:
        return 0.0
    g = EULER_MASCHERONI
    n = float(n_trials)
    try:
        return (1 - g) * norm_ppf(1 - 1 / n) + g * norm_ppf(1 - 1 / (n * math.e))
    except (ValueError, OverflowError) as exc:
        raise ValueError('trial count too large for normal quantile precision') from exc


def _deflated_sharpe_stats(n: int, mean: float, sd: float, skew: float, kurt: float,
                           n_trials: int, *, min_n: int = 10,
                           use_empirical_moments: bool | None = None,
                           sr_benchmark_override: float | None = None,
                           trials_sr_std: float | None = None) -> dict:
    if isinstance(n_trials, bool) or not isinstance(n_trials, int) or n_trials < 1:
        raise ValueError('n_trials must be a positive integer')
    if isinstance(min_n, bool) or not isinstance(min_n, int) or min_n < 2:
        raise ValueError('min_n must be an integer >= 2')
    if trials_sr_std is not None:
        trials_sr_std = _finite(trials_sr_std, 'trials_sr_std')
        if trials_sr_std < 0:
            raise ValueError('trials_sr_std must be nonnegative')
    if sr_benchmark_override is not None:
        sr_benchmark_override = _finite(sr_benchmark_override, 'sr_benchmark_override')
    empirical = n >= 30 if use_empirical_moments is None else use_empirical_moments
    status = ('benchmark_override' if sr_benchmark_override is not None else
              'not_required_n1' if n_trials == 1 else
              'provided' if trials_sr_std is not None else 'missing')
    out = {'n': n, 'trials': n_trials, 'sr': None, 'selection_bar': None,
           'dsr': None, 'verdict': 'UNAVAILABLE', 'skip': True,
           'status': 'unavailable', 'calibration_status': status,
           'trials_sr_std': trials_sr_std,
           'method': 'PSR' if n_trials == 1 and sr_benchmark_override is None else 'DSR',
           'moments_used': 'empirical' if empirical else 'normal',
           'skew': skew if empirical else 0.0, 'kurt': kurt if empirical else 3.0,
           'assumptions': 'N counts all trials as approximately independent normal trial Sharpes; dependence unmeasured; no estimated N_eff',
           'note': ''}
    if n < min_n:
        out.update(status='insufficient_n', note=f'pocos trades ({n} < {min_n})')
        return out
    if sd <= 0:
        out.update(status='zero_variance', note='serie sin varianza: SR/DSR no estimable')
        return out
    sr = mean / sd
    if not math.isfinite(sr):
        out.update(status='invalid_sr', note='non-finite Sharpe')
        return out
    out['sr'] = round(sr, 4)
    if status == 'missing':
        out.update(status='calibration_missing', note='N>1 requires empirical trials_sr_std or explicit benchmark; unit dispersion is NOT assumed')
        return out
    bar = (sr_benchmark_override if sr_benchmark_override is not None else
           0.0 if n_trials == 1 else trials_sr_std * expected_max_sr(n_trials))
    if not math.isfinite(bar):
        out.update(status='invalid_selection_bar', note='non-finite selection bar')
        return out
    out['selection_bar'] = round(bar, 4)
    if empirical and n < 4:
        out.update(status='insufficient_moments', note='empirical Pearson requires n>=4')
        return out
    if not empirical:
        skew, kurt = 0.0, 3.0
    variance = 1.0 - skew * sr + ((kurt - 1.0) / 4.0) * sr * sr
    if not math.isfinite(variance) or variance <= 0:
        out.update(status='invalid_variance_term', note='nonpositive/nonfinite SR variance term; no artificial floor applied')
        return out
    z = (sr - bar) * math.sqrt(n - 1) / math.sqrt(variance)
    probability = norm_cdf(z)
    out.update(skip=False, status='estimated', dsr=round(probability, 4),
               verdict='ABOVE' if probability >= 0.95 else 'BELOW',
               note='Approximate PSR/DSR under declared moments and trial independence assumptions; not proof of profitability')
    return out


def deflated_sharpe(returns: list[float], n_trials: int, *, min_n: int = 10,
                     use_empirical_moments: bool | None = None,
                     sr_benchmark_override: float | None = None,
                     trials_sr_std: float | None = None) -> dict:
    """Single canonical DSR implementation, with explicit missing calibration."""
    values = [_finite(v, 'return') for v in returns]
    mean, sd, skew, kurt = _moments(values)
    return _deflated_sharpe_stats(len(values), mean, sd, skew, kurt, n_trials,
                                  min_n=min_n, use_empirical_moments=use_empirical_moments,
                                  sr_benchmark_override=sr_benchmark_override,
                                  trials_sr_std=trials_sr_std)


def to_dict(m: TradeMetrics) -> dict:
    return asdict(m)


def pretty_print(m: TradeMetrics, obj: Optional[float] = None) -> str:
    parts = [f'trades={m.trade_count}', f'WR={m.win_rate*100:.1f}%',
             f'PF={m.profit_factor:.2f}', f'NetPnL={m.net_pnl_r:+.2f}R',
             f'MaxDD={m.max_drawdown_r:.2f}R', f'Sharpe={m.sharpe_simple:.2f}',
             f'Exp={m.expectancy:+.3f}', f'MaxConsecL={m.max_consec_losses}']
    if obj is not None:
        parts.append(f'OBJ={obj:+.4f}')
    return ' | '.join(parts)
