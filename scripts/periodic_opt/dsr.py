#!/usr/bin/env python3
"""Compatibility imports/CLI for canonical stdlib PSR/DSR.

N>1 requires measured between-trial Sharpe dispersion (or an explicit benchmark
through the Python API). N=1 is PSR against zero, not a selection correction.
No enforcement flag or weekly selection policy is changed here.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

# Reuse a direct-script import when present; otherwise use the package import.
# Both paths resolve to the same canonical source, never a duplicated estimator.
_CANONICAL = Path(__file__).resolve().parents[1] / 'hyperopt' / 'metrics.py'
_loaded = sys.modules.get('metrics')
if _loaded is not None and Path(getattr(_loaded, '__file__', '')).resolve() == _CANONICAL:
    _core = _loaded
else:
    try:
        from scripts.hyperopt import metrics as _core
    except ModuleNotFoundError as exc:
        if exc.name not in ('scripts', 'scripts.hyperopt', 'scripts.hyperopt.metrics'):
            raise
        sys.path.insert(0, str(_CANONICAL.parent))
        import metrics as _core
    sys.modules.setdefault('metrics', _core)
EULER_MASCHERONI = _core.EULER_MASCHERONI
_moments = _core._moments
deflated_sharpe = _core.deflated_sharpe
expected_max_sr = _core.expected_max_sr
norm_cdf = _core.norm_cdf
norm_ppf = _core.norm_ppf


def main() -> int:
    ap = argparse.ArgumentParser(description='Calibrated Deflated Sharpe Ratio (Bailey/López de Prado)')
    ap.add_argument('--file', help='JSON list of returns')
    ap.add_argument('--returns', help='CSV returns, e.g. 0.5,-0.2,1.1')
    ap.add_argument('--trials', type=int, required=True, help='common total candidate count, approximately independent')
    ap.add_argument('--min-n', type=int, default=10)
    ap.add_argument('--normal', action='store_true', help='force skew=0/kurt=3; default auto (normal below n=30)')
    ap.add_argument('--trials-sr-std', type=float, default=None,
                    help='measured dispersion of per-trade Sharpe across trials; required for N>1')
    args = ap.parse_args()
    try:
        if args.file:
            returns = json.loads(Path(args.file).read_text())
            if not isinstance(returns, list):
                raise ValueError('--file must contain a JSON list')
        elif args.returns:
            returns = [v.strip() for v in args.returns.split(',') if v.strip()]
        else:
            ap.error('necesitás --file o --returns')
        out = deflated_sharpe(returns, args.trials, min_n=args.min_n,
                              use_empirical_moments=False if args.normal else None,
                              trials_sr_std=args.trials_sr_std)
    except (ValueError, OSError) as exc:
        ap.error(str(exc))
    print(json.dumps(out, indent=2, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
