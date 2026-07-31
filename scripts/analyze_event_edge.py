#!/usr/bin/env python3
"""
Análisis de edge por evento del scoring SMC.

Fuentes:
  - logs/jarvis_bt_*.json            (backtests exportados)
  - logs/trade_journal_export.json   (trades live, generado por scripts/export_trade_journal.ts)

Métricas por evento:
  n, wins, winrate, avg R, lift vs baseline (winrate_evento - winrate_global),
  IC 95% Wilson. También tabla de calibración: winrate por bucket de puntos.

Uso: .venv/bin/python scripts/analyze_event_edge.py
"""
import json
import glob
import math
import sys
from collections import defaultdict

MIN_SAMPLE = 5  # mínimo de trades con el evento para reportar lift


def wilson_ci(wins: int, n: int, z: float = 1.96):
    if n == 0:
        return (0.0, 0.0)
    p = wins / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


def norm_event(e: str) -> str:
    """Normaliza ids de eventos: emojis fuera, sufijos de tf unificados."""
    s = ''.join(ch for ch in str(e) if ch.isascii() and (ch.isalnum() or ch in '_-'))
    s = s.strip('_')
    # Unificar sufijos de timeframe: _1H/_60/_60M -> _1H, _15M/_15 -> _15M, etc.
    tf_map = {'3': '3M', '5': '5M', '15': '15M', '60': '1H', '240': '4H',
              '3M': '3M', '5M': '5M', '15M': '15M', '1H': '1H', '4H': '4H', 'D': 'D'}
    parts = s.split('_')
    if parts and parts[-1] in tf_map:
        parts[-1] = tf_map[parts[-1]]
    return '_'.join(parts)


def load_trades():
    trades = []
    for f in sorted(glob.glob('logs/jarvis_bt_*.json')):
        d = json.load(open(f))
        src = f"backtest:{d.get('metadata', {}).get('ticker', '?')}"
        for t in d.get('trades', []):
            if t.get('result') not in ('WIN', 'LOSS'):
                continue
            trades.append({
                'source': src, 'win': t['result'] == 'WIN',
                'r': t.get('rMultiple'), 'points': t.get('points'),
                'events': [norm_event(e) for e in t.get('events', [])],
            })
    try:
        data = json.load(open('logs/trade_journal_export.json'))
        for t in data:
            res = t.get('result')
            if res not in ('WIN', 'LOSS'):
                continue
            pnl = t.get('pnl')
            trades.append({
                'source': f"live:{t.get('ticker', '?')}", 'win': res == 'WIN',
                'r': None, 'points': t.get('points'),
                'events': [norm_event(e) for e in (t.get('events') or [])],
            })
    except FileNotFoundError:
        print("⚠️  logs/trade_journal_export.json no existe — solo backtests. "
              "Corre: npx tsx scripts/export_trade_journal.ts\n")
    return trades


def main():
    trades = load_trades()
    if not trades:
        print("❌ Sin trades cerrados para analizar.")
        sys.exit(1)

    n_all = len(trades)
    wins_all = sum(t['win'] for t in trades)
    base_wr = wins_all / n_all
    rs = [t['r'] for t in trades if t['r'] is not None]
    avg_r = sum(rs) / len(rs) if rs else None

    print(f"=== DATASET ===")
    print(f"Trades cerrados: {n_all} | Wins: {wins_all} | Winrate baseline: {base_wr:.1%}", end='')
    print(f" | Avg R: {avg_r:+.2f}" if avg_r is not None else " | (live sin rMultiple)")
    by_src = defaultdict(int)
    for t in trades:
        by_src[t['source']] += 1
    print("Fuentes: " + ", ".join(f"{k}({v})" for k, v in sorted(by_src.items())))

    # --- Edge por evento ---
    stats = defaultdict(lambda: {'n': 0, 'w': 0, 'rs': []})
    for t in trades:
        for e in set(t['events']):  # set: un trade no cuenta doble el mismo evento
            s = stats[e]
            s['n'] += 1
            s['w'] += t['win']
            if t['r'] is not None:
                s['rs'].append(t['r'])

    print(f"\n=== EDGE POR EVENTO (min {MIN_SAMPLE} trades) ===")
    print(f"{'evento':<32} {'n':>4} {'winrate':>8} {'IC95%':>15} {'lift':>7} {'avgR':>6}")
    rows = []
    for e, s in stats.items():
        if s['n'] < MIN_SAMPLE:
            continue
        wr = s['w'] / s['n']
        lo, hi = wilson_ci(s['w'], s['n'])
        lift = wr - base_wr
        ar = sum(s['rs']) / len(s['rs']) if s['rs'] else None
        rows.append((lift, e, s['n'], wr, lo, hi, ar))
    for lift, e, n, wr, lo, hi, ar in sorted(rows, reverse=True):
        sig = '✅' if lo > base_wr else ('❌' if hi < base_wr else '·')
        print(f"{e:<32} {n:>4} {wr:>8.1%} [{lo:.0%},{hi:.0%}] {lift:>+7.1%} "
              f"{ar:>+6.2f} {sig}" if ar is not None else
              f"{e:<32} {n:>4} {wr:>8.1%} [{lo:.0%},{hi:.0%}] {lift:>+7.1%}   n/a {sig}")

    rare = {e: s for e, s in stats.items() if s['n'] < MIN_SAMPLE}
    if rare:
        print(f"\nEventos con muestra insuficiente (<{MIN_SAMPLE}): "
              + ", ".join(f"{e}({s['n']})" for e, s in sorted(rare.items(), key=lambda x: -x[1]['n'])))

    # --- Calibración: ¿más puntos = más wins? ---
    print(f"\n=== CALIBRACIÓN POR PUNTOS (score al abrir el trade) ===")
    buckets = [(0, 10), (10, 15), (15, 20), (20, 25), (25, 30), (30, 36)]
    print(f"{'puntos':>8} {'n':>4} {'winrate':>8} {'avgR':>6}")
    for lo_b, hi_b in buckets:
        bt = [t for t in trades if t['points'] is not None and lo_b <= t['points'] < hi_b]
        if not bt:
            continue
        wr = sum(t['win'] for t in bt) / len(bt)
        brs = [t['r'] for t in bt if t['r'] is not None]
        ar = f"{sum(brs)/len(brs):+.2f}" if brs else "  n/a"
        print(f"{lo_b:>3}-{hi_b:<4} {len(bt):>4} {wr:>8.1%} {ar:>6}")

    print("\nLeyenda: ✅ IC95% por encima del baseline (edge positivo significativo) | "
          "❌ por debajo (evento tóxico) | · no concluyente")
    print("⚠️  Con n < 30 por evento, los intervalos son anchos: usa esto para "
          "detectar eventos tóxicos obvios, no para afinar decimales.")


if __name__ == '__main__':
    main()
