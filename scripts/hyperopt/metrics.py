"""
JARVIS Hyperopt — Métricas estandarizadas para la función objetivo.

Inspirado en Freqtrade (hyperopt_loss SharpeHyperOptLossDaily) y adaptado
a las métricas que JARVIS ya calcula en autotune.ts y backtestEngine.ts.

Convención: 'rMultiple' es la unidad canónica (1R = 1 unidad de riesgo por trade).
El backtestEngine devuelve trades con 'rMultiple' y 'pnl' en USD.
"""

from __future__ import annotations
from dataclasses import dataclass, asdict
from typing import Iterable, List, Optional


@dataclass
class TradeMetrics:
    """Métricas crudas calculadas sobre una lista de trades cerrados."""
    trade_count: int
    wins: int
    losses: int
    win_rate: float            # 0..1
    gross_profit_r: float      # suma rMultiple > 0
    gross_loss_r: float        # suma |rMultiple| < 0
    net_pnl_r: float           # suma total rMultiple
    profit_factor: float       # gross_profit / gross_loss (inf si gross_loss=0)
    expectancy: float          # net_pnl / trade_count
    max_drawdown_r: float      # peak-to-valley en equity R
    sharpe_simple: float       # mean(r) / std(r) * sqrt(n), 0 si std=0
    avg_trade_r: float         # media de rMultiple
    max_consec_losses: int
    max_consec_wins: int


def compute_metrics(trades: Iterable[dict]) -> TradeMetrics:
    """
    trades: iterable de dicts con al menos 'rMultiple' (y opcionalmente 'result', 'pnl').
    Devuelve métricas en la unidad R. Trades con rMultiple NaN/undefined se descartan.
    """
    r_list: List[float] = []
    wins = losses = 0
    gross_profit = 0.0
    gross_loss = 0.0
    mc_losses = 0
    mc_wins = 0
    cur_losses = 0
    cur_wins = 0

    # Para drawdown iteramos en orden cronológico (asumimos que trades ya vienen ordenados).
    equity = 0.0
    peak = 0.0
    max_dd = 0.0

    for t in trades:
        r = t.get("rMultiple")
        if r is None:
            continue
        try:
            r = float(r)
        except (TypeError, ValueError):
            continue
        if r != r:  # NaN
            continue
        r_list.append(r)

        equity += r
        if equity > peak:
            peak = equity
        dd = peak - equity
        if dd > max_dd:
            max_dd = dd

        if r > 0:
            wins += 1
            gross_profit += r
            cur_wins += 1
            cur_losses = 0
            if cur_wins > mc_wins:
                mc_wins = cur_wins
        elif r < 0:
            losses += 1
            gross_loss += -r
            cur_losses += 1
            cur_wins = 0
            if cur_losses > mc_losses:
                mc_losses = cur_losses

    n = len(r_list)
    if n == 0:
        return TradeMetrics(0, 0, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                            0.0, 0.0, 0.0, 0, 0)

    net = gross_profit - gross_loss
    pf = (gross_profit / gross_loss) if gross_loss > 0 else float(gross_profit) if gross_profit > 0 else 0.0
    expectancy = net / n
    win_rate = wins / n

    # Sharpe simplificado (sin anualizar — el horizonte lo decide el caller)
    if n > 1:
        mean_r = net / n
        # std poblacional
        var = sum((r - mean_r) ** 2 for r in r_list) / n
        std = var ** 0.5
        sharpe = (mean_r / std) * (n ** 0.5) if std > 0 else 0.0
    else:
        sharpe = 0.0

    return TradeMetrics(
        trade_count=n,
        wins=wins,
        losses=losses,
        win_rate=win_rate,
        gross_profit_r=gross_profit,
        gross_loss_r=gross_loss,
        net_pnl_r=net,
        profit_factor=pf,
        expectancy=expectancy,
        max_drawdown_r=max_dd,
        sharpe_simple=sharpe,
        avg_trade_r=net / n,
        max_consec_losses=mc_losses,
        max_consec_wins=mc_wins,
    )


def objective_function(
    metrics: TradeMetrics,
    min_trades: int = 30,
    dd_penalty: float = 2.0,
    sample_penalty: float = 0.5,
    target_trades: int = 200,
) -> float:
    """
    Función objetivo primaria del hyperopt.

    Maximiza:
        ProfitFactor - dd_penalty * MaxDrawdownR - sample_penalty * |trades - target| / target

    Si trade_count < min_trades, devuelve un score muy negativo proporcional a la
    "lejanía" del umbral (penaliza regiones con poca muestra).

    Inspirado en Freqtrade:
    - SharpeHyperOptLossDaily -> reemplazado por Sharpe Simple (sample-size adjusted)
    - SortinoHyperOptLoss   -> similar pero con downside deviation (no usado acá)
    """
    if metrics.trade_count < min_trades:
        # Penalización suave: a medida que nos acercamos al mínimo, sube el score.
        # trials con 0 trades => -100 (igual que smc_bruteforcer.ts línea 101)
        if metrics.trade_count == 0:
            return -100.0
        ratio = metrics.trade_count / min_trades
        return -10.0 * (1.0 - ratio)

    # Region válida: optimización normal.
    trade_dev = abs(metrics.trade_count - target_trades) / target_trades
    # 🛡️ Métricas honestas (sep-2026, opción 5 de Bon): cap PF en 5 Y degradarlo si la
    # pérdida bruta es chica (gross_loss < 5R → el PF está inflado por pocas pérdidas,
    # caso XAUUSD 16.73). El piso se alcanza gradualmente para no aplanar el paisaje.
    pf_honest = min(metrics.profit_factor, 5.0) * min(1.0, metrics.gross_loss_r / 5.0)
    return (
        pf_honest
        - dd_penalty * metrics.max_drawdown_r
        - sample_penalty * trade_dev
        + 0.1 * metrics.expectancy  # bonus pequeño por expectancy
    )


def to_dict(m: TradeMetrics) -> dict:
    return asdict(m)


def pretty_print(m: TradeMetrics, obj: Optional[float] = None) -> str:
    parts = [
        f"trades={m.trade_count}",
        f"WR={m.win_rate*100:.1f}%",
        f"PF={m.profit_factor:.2f}",
        f"NetPnL={m.net_pnl_r:+.2f}R",
        f"MaxDD={m.max_drawdown_r:.2f}R",
        f"Sharpe={m.sharpe_simple:.2f}",
        f"Exp={m.expectancy:+.3f}",
        f"MaxConsecL={m.max_consec_losses}",
    ]
    if obj is not None:
        parts.append(f"OBJ={obj:+.4f}")
    return " | ".join(parts)
