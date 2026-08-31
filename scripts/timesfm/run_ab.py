#!/usr/bin/env python3
"""run_ab.py — medición nivel 2 (F1): A/B backtest con/sin filtro TimesFM.

Corre la MISMA config de producción (best_config del hyperopt) en 3 pasadas:
  1. baseline   → sin timesfm
  2. collect    → collectOnly: registra los ts de TODOS los triggers (train+OOS)
  3. timesfm    → enabled con cache precomputado en esos ts

Reporta comparación medida: PF, net PnL (R), maxDD (R), trades, win rate,
expectancy — train y OOS — más la distribución de acciones del filtro.

Uso:
  python3 run_ab.py --ticker eurusd --tf 15 [--horizon 12] [--skip-precompute]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER = REPO_ROOT / "scripts" / "hyperopt" / "jarvis_hyperopt_worker.ts"
VENV_PY = Path(__file__).resolve().parent / ".venv" / "bin" / "python"


class RpcWorker:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            ["npx", "tsx", str(WORKER)],
            cwd=str(REPO_ROOT), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self._id = 0

    def call(self, method: str, params: dict, timeout: int = 1800):
        self._id += 1
        rid = self._id
        self.proc.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        t0 = time.time()
        while True:
            if time.time() - t0 > timeout:
                raise TimeoutError(f"RPC {method} timeout {timeout}s")
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"worker cerró stdout (method={method})")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue  # logs del worker van a stderr; por las dudas skipear
            if msg.get("id") != rid:
                continue
            if "error" in msg:
                raise RuntimeError(f"RPC {method}: {msg['error']}")
            return msg["result"]

    def close(self):
        try:
            self.call("shutdown", {}, timeout=5)
        except Exception:
            pass
        self.proc.terminate()


def fmt_row(name: str, m: dict) -> str:
    return (f"  {name:<22} trades={m['trade_count']:>4}  PF={m['profit_factor']:>6.3f}  "
            f"netPnL={m['net_pnl_r']:>8.2f}R  maxDD={m['max_drawdown_r']:>6.2f}R  "
            f"WR={100*m['win_rate']:>5.1f}%  exp={m['expectancy']:>6.3f}R")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ticker", required=True)
    ap.add_argument("--tf", type=int, default=15)
    ap.add_argument("--horizon", type=int, default=12)
    ap.add_argument("--skip-precompute", action="store_true")
    ap.add_argument("--spread-hi", type=float, help="spreadAtrHighConv (umbral convicción alta)")
    ap.add_argument("--low-mult", type=float, help="lowConvictionMult")
    ap.add_argument("--counter-mult", type=float, help="counterMult")
    ap.add_argument("--min-score-override", type=float, help="minScoreToOverrideReject")
    ap.add_argument("--tag", default="", help="sufijo para audit/report (sensibilidad)")
    ap.add_argument("--dry-run", action="store_true", help="shadow: audita sin aplicar (paridad con baseline)")
    ap.add_argument("--tp2-q90-step", type=int, help="Fase C: TP2 dinámico = q90[step] (habilita tp2Dynamic='q90')")
    ap.add_argument("--preset-path", help="ruta explícita del preset (para tickers sin preset hyperopt en la raíz)")
    args = ap.parse_args()

    ticker = args.ticker.lower()
    out_dir = Path(__file__).resolve().parent / "ab_out" / f"{ticker}_{args.tf}"
    out_dir.mkdir(parents=True, exist_ok=True)
    triggers_p = out_dir / "triggers.jsonl"
    forecasts_p = out_dir / "forecasts.jsonl"
    sfx = f"_{args.tag}" if args.tag else ""
    audit_p = out_dir / f"audit{sfx}.jsonl"
    report_p = out_dir / f"ab_report{sfx}.json"
    for p in (triggers_p, audit_p):
        p.unlink(missing_ok=True)

    if args.preset_path:
        preset = Path(args.preset_path)
        if not preset.exists():
            raise FileNotFoundError(f"preset-path no existe: {preset}")
    else:
        preset = REPO_ROOT / f"optimized_preset_{ticker.upper()}_hyperopt.json"
        if not preset.exists():
            preset = REPO_ROOT / f"optimized_preset_{ticker.upper()}.json"
        if not preset.exists():
            preset = REPO_ROOT / f"optimized_preset_{ticker}_hyperopt.json"
        if not preset.exists():
            preset = REPO_ROOT / f"optimized_preset_{ticker}.json"
    cfg_all = json.loads(preset.read_text())
    base_config = cfg_all.get("best_config", cfg_all)
    print(f"[AB] config ← {preset.name}", flush=True)

    w = RpcWorker()
    try:
        print(f"[AB] init worker ticker={ticker}...", flush=True)
        init_res = w.call("init", {"ticker": ticker, "log_dir": f"logs/{ticker}/history_exported"})
        print(f"[AB] init ok: {json.dumps(init_res)[:200]}", flush=True)

        print("[AB] 1/3 baseline (sin filtro)...", flush=True)
        t0 = time.time()
        base = w.call("evaluate", {"config": base_config})
        print(f"[AB]   baseline en {time.time()-t0:.0f}s", flush=True)

        print("[AB] 2/3 collect (registrando triggers)...", flush=True)
        collect_cfg = dict(base_config)
        collect_cfg["timesfm"] = {"enabled": False, "collectOnly": True,
                                  "collectPath": str(triggers_p)}
        w.call("evaluate", {"config": collect_cfg})
        n_trg = sum(1 for _ in open(triggers_p)) if triggers_p.exists() else 0
        print(f"[AB]   {n_trg} triggers colectados", flush=True)

        if not args.skip_precompute:
            print("[AB] precomputando forecasts en esos orígenes...", flush=True)
            subprocess.run(
                [str(VENV_PY), str(Path(__file__).parent / "precompute_forecasts.py"),
                 "--ticker", ticker, "--tf", f"M{args.tf}",
                 "--triggers", str(triggers_p), "--out", str(forecasts_p)],
                check=True, cwd=str(REPO_ROOT),
            )

        print("[AB] 3/3 con filtro TimesFM activo...", flush=True)
        tfm_cfg = dict(base_config)
        tfm_block = {"enabled": True, "cachePath": str(forecasts_p),
                     "auditPath": str(audit_p), "horizon": args.horizon}
        if args.spread_hi is not None:
            tfm_block["spreadAtrHighConv"] = args.spread_hi
        if args.low_mult is not None:
            tfm_block["lowConvictionMult"] = args.low_mult
        if args.counter_mult is not None:
            tfm_block["counterMult"] = args.counter_mult
        if args.min_score_override is not None:
            tfm_block["minScoreToOverrideReject"] = args.min_score_override
        if args.dry_run:
            tfm_block["dryRun"] = True
        if args.tp2_q90_step is not None:
            tfm_block["tp2Dynamic"] = "q90"
            tfm_block["tp2Q90Step"] = args.tp2_q90_step
        tfm_cfg["timesfm"] = tfm_block
        t0 = time.time()
        tfm = w.call("evaluate", {"config": tfm_cfg})
        print(f"[AB]   filtrado en {time.time()-t0:.0f}s", flush=True)
    finally:
        w.close()

    # Distribución de acciones del filtro (audit JSONL)
    actions = Counter()
    reasons = Counter()
    if audit_p.exists():
        for line in open(audit_p):
            r = json.loads(line)
            actions[r.get("action", "?")] += 1
            if r.get("degraded"):
                reasons["degraded"] += 1

    report = {
        "ticker": ticker, "tf": args.tf, "horizon": args.horizon,
        "config_source": preset.name,
        "baseline": base, "timesfm": tfm,
        "filter_actions": dict(actions), "degraded": reasons.get("degraded", 0),
        "generated_at": int(time.time()),
    }
    report_p.write_text(json.dumps(report, indent=2))

    print("\n" + "═" * 78)
    print(f" A/B {ticker.upper()} M{args.tf} — filtro TimesFM F1 (H={args.horizon})")
    print("═" * 78)
    print(" TRAIN (70%):")
    print(fmt_row("baseline", base["metrics"]))
    print(fmt_row("timesfm", tfm["metrics"]))
    if base.get("metrics_oos"):
        print(" OOS (30%):")
        print(fmt_row("baseline", base["metrics_oos"]))
        print(fmt_row("timesfm", tfm["metrics_oos"]))
    print(f"\n Acciones del filtro: {dict(actions)}  |  degradados: {reasons.get('degraded', 0)}")
    bm, tm = base["metrics"], tfm["metrics"]
    print(f"\n ΔPF={tm['profit_factor']-bm['profit_factor']:+.3f}  "
          f"ΔnetPnL={tm['net_pnl_r']-bm['net_pnl_r']:+.2f}R  "
          f"ΔmaxDD={tm['max_drawdown_r']-bm['max_drawdown_r']:+.2f}R  "
          f"Δtrades={tm['trade_count']-bm['trade_count']:+d}")
    print(f"\n Reporte: {report_p}")


if __name__ == "__main__":
    main()
