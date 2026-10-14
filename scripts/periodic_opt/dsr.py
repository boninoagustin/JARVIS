#!/usr/bin/env python3
"""dsr.py — Deflated Sharpe Ratio (Bailey & López de Prado 2014/2018).

Corrige el sesgo de selección: cuando una búsqueda evalúa N candidatos y se
queda con el mejor, parte del Sharpe del ganador es suerte. La "barra de
selección" E[max SR_N] es lo que cabe esperar del mejor de N tiros aleatorios;
el DSR es la probabilidad de que el Sharpe observado supere esa barra.

Convención de series: r-multiples por trade (mismas unidades que el MC gate).
Todo stdlib, sin dependencias (corre en el cron del VPS).

Uso:
  python3 dsr.py --file serie.json --trials 800
  python3 dsr.py --returns 0.5,-0.2,1.1 --trials 800
  python3 dsr.py --returns ... --trials ... --normal   # fuerzo normalidad (n<30 default)

Salida JSON: {n, trials, sr, selection_bar, dsr, verdict, moments_used, note}
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

EULER_MASCHERONI = 0.5772156649015328606


def norm_ppf(p: float) -> float:
    """Inversa de la CDF normal estándar (aproximación racional de Acklam, ~1e-9)."""
    a = [-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
         1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00]
    b = [-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
         6.680131188771972e01, -1.328068155288572e01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
         -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
         3.754408661907416e00]
    plow, phigh = 0.02425, 1.0 - 0.02425
    if p < plow:
        q = math.sqrt(-2.0 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
    if p > phigh:
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def expected_max_sr(n_trials: int) -> float:
    """E[max SR] del mejor de N trials independientes (López de Prado 2018, Eq. ~8.3).

    (1-gamma)*Z^-1(1 - 1/N) + gamma*Z^-1(1 - 1/(N*e))
    Converge a sqrt(2 ln N) para N grande. N<=1 => 0 (sin sesgo de selección).
    """
    if n_trials is None or n_trials <= 1:
        return 0.0
    n = float(n_trials)
    g = EULER_MASCHERONI
    z1 = norm_ppf(1.0 - 1.0 / n)
    z2 = norm_ppf(1.0 - 1.0 / (n * math.e))
    return (1.0 - g) * z1 + g * z2


def _moments(x: list[float]) -> tuple[float, float, float]:
    """(mean, sd, skew ajustado, kurtosis ajustada tipo Pearson [3 = normal])."""
    n = len(x)
    m = sum(x) / n
    m2 = sum((v - m) ** 2 for v in x) / n
    sd = math.sqrt(m2)
    if sd == 0:
        return m, 0.0, 0.0, 3.0
    m3 = sum((v - m) ** 3 for v in x) / n
    m4 = sum((v - m) ** 4 for v in x) / n
    g1 = m3 / (m2 ** 1.5)
    g2 = m4 / (m2 ** 2) - 3.0
    if n >= 3:
        skew = math.sqrt(n * (n - 1)) / (n - 2) * g1
    else:
        skew = 0.0
    if n >= 4:
        kurt = (n - 1) / ((n - 2) * (n - 3)) * ((n + 1) * g2 + 6.0)
        # La corrección de Pearson puede quedar <1 (mínimo teórico) en muestras chicas
        # con exceso muy negativo — artefacto de la fórmula, se clampa.
        kurt = max(kurt, 1.0)
    else:
        kurt = 3.0
    return m, sd, skew, kurt


def deflated_sharpe(
    returns: list[float],
    n_trials: int,
    *,
    min_n: int = 10,
    use_empirical_moments: bool | None = None,
    sr_benchmark_override: float | None = None,
) -> dict:
    """DSR sobre una serie de returns (r-multiples). Devuelve dict con skip/notas."""
    n = len(returns)
    if n < min_n:
        return {"skip": True, "n": n,
                "note": f"pocos trades ({n} < {min_n}) — DSR no calculable, igual criterio que el MC gate"}
    mean, sd, skew, kurt = _moments(returns)
    if sd == 0:
        return {"skip": True, "n": n, "note": "serie sin varianza — DSR no calculable"}
    sr = mean / sd
    bar = expected_max_sr(n_trials) if sr_benchmark_override is None else sr_benchmark_override
    use_moments = (n >= 30) if use_empirical_moments is None else use_empirical_moments
    if not use_moments:
        skew, kurt = 0.0, 3.0
    denom = math.sqrt(max(1e-12, 1.0 - skew * sr + ((kurt - 1.0) / 4.0) * sr * sr))
    z = (sr - bar) * math.sqrt(n - 1) / denom
    dsr = norm_cdf(z)
    verdict = "ABOVE" if dsr >= 0.95 else "BELOW"
    return {"n": n, "trials": n_trials, "sr": round(sr, 4),
            "selection_bar": round(bar, 4), "dsr": round(dsr, 4), "verdict": verdict,
            "moments_used": "empirical" if use_moments else "normal",
            "skew": round(skew, 3) if use_moments else 0.0,
            "kurt": round(kurt, 3) if use_moments else 3.0,
            "note": f"DSR {'≥' if dsr >= 0.95 else '<'} 0.95: el edge {'supera' if dsr >= 0.95 else 'NO supera'} la barra de selección"}


def main() -> int:
    ap = argparse.ArgumentParser(description="Deflated Sharpe Ratio (Bailey/López de Prado)")
    ap.add_argument("--file", type=str, default=None, help="JSON con lista de returns")
    ap.add_argument("--returns", type=str, default=None, help="lista csv de returns, ej. 0.5,-0.2,1.1")
    ap.add_argument("--trials", type=int, required=True, help="N de candidatos evaluados en la búsqueda")
    ap.add_argument("--min-n", type=int, default=10)
    ap.add_argument("--normal", action="store_true", help="forzar skew=0/kurt=3")
    args = ap.parse_args()

    if args.file:
        raw = json.loads(Path(args.file).read_text())
        returns = [float(v) for v in raw]
    elif args.returns:
        returns = [float(v) for v in args.returns.split(",") if v.strip() != ""]
    else:
        ap.error("necesitás --file o --returns")

    out = deflated_sharpe(returns, args.trials, min_n=args.min_n,
                          use_empirical_moments=(not args.normal))
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
