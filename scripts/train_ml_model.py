#!/usr/bin/env python3
"""
JARVIS ML Model Trainer (FreqAI-style)

Entrena un XGBoost classifier sobre trades cerrados del backtest para predecir
WIN/LOSS en función de 12 features del estado del SMCEngine al momento de la entrada.

Exporta el modelo como JSON (árboles) para que MLFilter.ts lo evalúe en TypeScript
sin dependencias Python en runtime.

Uso:
    python scripts/train_ml_model.py EURUSD
    python scripts/train_ml_model.py EURUSD --n-estimators 150 --max-depth 5
    python scripts/train_ml_model.py XAUUSD --output-dir scripts/hyperopt/models/

Features (12-dim):
    z_score, vwap_status, atr_value, sweep_direction, simple_trend,
    hour_of_day, session, day_of_week, score_points, active_zones,
    choch_points, bias_aligned
"""

from __future__ import annotations
import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]  # scripts/train_ml_model.py → JARVIS/
MODELS_DIR = REPO_ROOT / "scripts" / "hyperopt" / "models"

FEATURE_NAMES = [
    "z_score",
    "vwap_status",
    "atr_value",
    "sweep_direction",
    "simple_trend",
    "hour_of_day",
    "session",
    "day_of_week",
    "score_points",
    "active_zones",
    "choch_points",
    "bias_aligned",
]


def install_xgboost() -> None:
    """Asegura xgboost en el venv del hyperopt."""
    venv_python = REPO_ROOT / "scripts" / "hyperopt" / ".venv" / "bin" / "python"
    if not venv_python.exists():
        print("[train_ml] ERROR: venv no existe. Ejecutá primero: python3 -m venv scripts/hyperopt/.venv", file=sys.stderr)
        sys.exit(1)
    import subprocess
    try:
        import xgboost  # noqa
    except ImportError:
        print("[train_ml] Instalando xgboost + scikit-learn...", file=sys.stderr)
        subprocess.check_call(
            [str(venv_python), "-m", "pip", "install", "--quiet", "xgboost", "scikit-learn"],
            cwd=str(REPO_ROOT),
        )


def parse_smc_state_from_log_line(line: str) -> Optional[Dict[str, Any]]:
    """
    Extrae features de una línea de log Pine (SYNC_ZONES o HEARTBEAT).
    Retorna None si la línea no tiene info suficiente.
    """
    upper = line.upper()
    ts_match = line.split("TS:")[-1].strip()
    try:
        ts = int(ts_match)
    except (ValueError, IndexError):
        return None

    # z-score
    z_up = None
    z_dn = None
    z_match = [x for x in line.split("|") if "Z-UP:" in x.upper() or "Z-DN:" in x.upper()]
    for part in z_match:
        if "Z-UP:" in part.upper():
            try:
                z_up = float(part.split(":")[-1].strip())
            except ValueError:
                pass
        if "Z-DN:" in part.upper():
            try:
                z_dn = float(part.split(":")[-1].strip())
            except ValueError:
                pass

    # VWAP status
    vwap_status = 2  # N/A
    if "VWAP: UNDER" in upper:
        vwap_status = 0
    elif "VWAP: OVER" in upper:
        vwap_status = 1

    # Market bias (para bias_aligned y simple_trend)
    bias_str = "NEUTRAL"
    bias_match_parts = [x for x in line.split("|") if "BIAS:" in x.upper()]
    if bias_match_parts:
        b = bias_match_parts[0].split(":")[-1].strip().upper()
        if b in ("BUY", "SELL", "BULLISH", "BEARISH", "NEUTRAL"):
            bias_str = "BULLISH" if b == "BUY" else ("BEARISH" if b == "SELL" else b)

    # Trend
    trend_match = [x for x in line.split("|") if "TREND:" in x.upper()]
    trend_str = "NEUTRAL"
    if trend_match:
        trend_str = trend_match[0].split(":")[-1].strip().upper()

    simple_trend = 1  # neutral
    if trend_str == "BULLISH" or trend_str == "BUY":
        simple_trend = 2
    elif trend_str == "BEARISH" or trend_str == "SELL":
        simple_trend = 0

    # Sweep direction
    sweep_dir = 0  # none
    if "LIQ_GRAB" in upper or "EVENTO_SWEEP" in upper:
        if "DIR: BUY" in upper:
            sweep_dir = 1
        elif "DIR: SELL" in upper:
            sweep_dir = 2

    # Hour / session / day
    import datetime
    dt = datetime.datetime.fromtimestamp(ts / 1000, tz=datetime.timezone.utc)
    # Ajuste a Argentina UTC-3
    ar_hour = (dt.hour - 3) % 24
    hour = ar_hour
    dow = dt.weekday()  # 0=Monday

    # Session
    t_dec = ar_hour + dt.minute / 60.0
    if t_dec >= 21 or t_dec < 4:
        session = 0  # ASIA
    elif t_dec >= 4 and t_dec < 10.5:
        session = 1  # LONDON
    elif t_dec >= 10.5 and t_dec < 17:
        session = 2  # NY
    else:
        session = 3  # OFF

    # Zones count
    zones_count = 0
    zm = [x for x in line.split("|") if "ZONES:" in x.upper()]
    if zm:
        try:
            zones_count = int(zm[0].split(":")[-1].strip())
        except ValueError:
            pass

    return {
        "ts": ts,
        "z_score": (z_up or 0) - (z_dn or 0),  # z_up - z_dn como proxy
        "vwap_status": vwap_status,
        "atr_value": 0.0,  # se completa más abajo si viene en PING_PRICE
        "sweep_direction": sweep_dir,
        "simple_trend": simple_trend,
        "hour_of_day": hour,
        "session": session,
        "day_of_week": dow,
        "score_points": 0,  # se completa al momento de la entrada
        "active_zones": zones_count,
        "choch_points": 0,  # se completa del evento CHOCH
        "bias_aligned": 0,  # se completa con contexto de trade
    }


def extract_features_from_logs(log_dir: Path, ticker: str = "EURUSD") -> List[Dict[str, Any]]:
    """
    Recolecta trades con features REALES usando el worker TS de backtest.

    Flujo: inicia el worker, llama method=collect_trades (que corre runBacktest
    sobre el split de train 70% y congela las 12 features de MLFilter.extractFeatures
    en cada trade), y asigna label=1 (WIN) / 0 (LOSS) según el resultado real.

    Este enfoque reemplaza el POC anterior que generaba features SINTÉTICAS con
    random() — el modelo ahora entrena con los mismos features que evalúa el runtime.
    """
    import subprocess
    import tempfile

    features: List[Dict[str, Any]] = []

    # Buscar el worker TS
    worker_ts = REPO_ROOT / "scripts" / "hyperopt" / "jarvis_hyperopt_worker.ts"
    if not worker_ts.exists():
        print(f"[train_ml] ERROR: worker no encontrado en {worker_ts}", file=sys.stderr)
        return features

    # Config de backtest base (misma que usa el hyperopt)
    config = {
        "ticker": ticker,
        "minBuyPoints": 5, "minSellPoints": 5,
        "minRR": 1.5, "oteEntryPercent": 50, "entryTrigger": "SMART",
        "slBufferPercent": 0, "fixedRR": 2,
        "minimal_roi": {"0": 0.015, "30": 0.005, "60": 0},
    }

    print(f"[train_ml] Iniciando worker TS para backtest...", file=sys.stderr)
    proc = subprocess.Popen(
        ["npx", "tsx", str(worker_ts)],
        cwd=str(REPO_ROOT),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    def send(method: str, params: dict) -> dict:
        nonlocal next_id
        msg = {"id": next_id, "method": method, "params": params}
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()
        next_id += 1
        while True:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("worker cerró stdout")
            try:
                resp = json.loads(line.strip())
            except json.JSONDecodeError:
                continue
            if resp.get("id") == msg["id"]:
                if "error" in resp:
                    raise RuntimeError(resp["error"])
                return resp["result"]

    next_id = 1
    try:
        # Init (carga logs y hace split temporal 70/30)
        init_res = send("init", {"ticker": ticker, "log_dir": str(log_dir)})
        total = sum(init_res["logs_loaded"].values())
        print(f"[train_ml] Worker cargó {total} eventos", file=sys.stderr)

        # Collect trades con features reales (NO sintéticas)
        collect_res = send("collect_trades", {"config": config})
        raw_trades = collect_res.get("trades", [])
        print(f"[train_ml] collect_trades devolvió {len(raw_trades)} trades", file=sys.stderr)

        for t in raw_trades:
            result = t.get("result")
            mlf = t.get("mlFeatures")
            # Solo WIN/LOSS entrenan el clasificador binario (BE/TIMEOUT/REVERSAL se descartan)
            if result not in ("WIN", "LOSS"):
                continue
            if not mlf:
                continue
            label = 1 if result == "WIN" else 0
            entry = dict(mlf)  # copia de las 12 features
            entry["label"] = label
            entry["direction"] = t.get("direction", "BUY")
            entry["ts"] = int(t.get("timestamp") or 0)
            features.append(entry)

        print(f"[train_ml] {len(features)} trades WIN/LOSS con features reales "
              f"(descartados BE/TIMEOUT/REVERSAL o sin features)", file=sys.stderr)
        if features:
            wins = sum(1 for e in features if e["label"] == 1)
            print(f"[train_ml] WIN={wins} LOSS={len(features)-wins} (WR={wins/max(1,len(features))*100:.1f}%)",
                  file=sys.stderr)

        # Shutdown
        send("shutdown", {})
        proc.wait(timeout=5)
        return features

    except Exception as e:
        print(f"[train_ml] ERROR: {e}", file=sys.stderr)
        try:
            proc.terminate()
        except Exception:
            pass
        return features


def train_model(
    entries: List[Dict[str, Any]],
    output_path: Path,
    n_estimators: int = 100,
    max_depth: int = 4,
    learning_rate: float = 0.1,
    random_seed: int = 42,
) -> Dict[str, Any]:
    """Entrena XGBoost y exporta a JSON."""
    import xgboost as xgb
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score

    if len(entries) < 20:
        print(f"[train_ml] ERROR: solo {len(entries)} muestras. Se necesitan ≥ 20.", file=sys.stderr)
        return {}

    X = np.array([[e[f] for f in FEATURE_NAMES] for e in entries], dtype=np.float32)
    y = np.array([e["label"] for e in entries], dtype=np.int32)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=random_seed, stratify=y
    )

    print(f"[train_ml] Train: {len(X_train)} | Test: {len(X_test)}", file=sys.stderr)
    win_rate = y_train.mean()
    print(f"[train_ml] Baseline WR: {win_rate*100:.1f}%", file=sys.stderr)

    model = xgb.XGBClassifier(
        n_estimators=n_estimators,
        max_depth=max_depth,
        learning_rate=learning_rate,
        objective="binary:logistic",
        eval_metric="logloss",
        random_state=random_seed,
        use_label_encoder=False,
        verbosity=0,
    )

    t0 = time.time()
    model.fit(
        X_train, y_train,
        eval_set=[(X_test, y_test)],
        verbose=False,
    )
    elapsed = time.time() - t0
    print(f"[train_ml] Training: {elapsed:.1f}s", file=sys.stderr)

    y_pred = model.predict(X_test)
    y_proba = model.predict_proba(X_test)[:, 1]

    acc = float(accuracy_score(y_test, y_pred))
    prec = float(precision_score(y_test, y_pred, zero_division=0))
    rec = float(recall_score(y_test, y_pred, zero_division=0))
    f1 = float(f1_score(y_test, y_pred, zero_division=0))

    print(f"[train_ml] Test metrics:", file=sys.stderr)
    print(f"  Accuracy:  {acc:.4f}", file=sys.stderr)
    print(f"  Precision: {prec:.4f}", file=sys.stderr)
    print(f"  Recall:    {rec:.4f}", file=sys.stderr)
    print(f"  F1:        {f1:.4f}", file=sys.stderr)

    # Umbral de decisión — qué % de predicciones pasa el filtro
    threshold = 0.65
    passed = (y_proba >= threshold).sum()
    passed_wins = ((y_proba >= threshold) & (y_test == 1)).sum()
    passed_losses = ((y_proba >= threshold) & (y_test == 0)).sum()
    print(f"[train_ml] Filter @ {threshold}: {passed}/{len(y_test)} passed "
          f"({passed_wins}W/{passed_losses}L)", file=sys.stderr)

    # Feature importance — convertir a float nativo (xgboost 3.x usa float32)
    raw_imp = dict(zip(FEATURE_NAMES, model.feature_importances_))
    importance = {k: float(v) for k, v in raw_imp.items()}
    sorted_imp = sorted(importance.items(), key=lambda x: x[1], reverse=True)
    print(f"[train_ml] Top features:", file=sys.stderr)
    for name, imp in sorted_imp[:5]:
        print(f"  {name:>18}: {imp:.4f}", file=sys.stderr)

    # Exportar como JSON (árbol booster)
    booster = model.get_booster()
    model_json = booster.save_raw(raw_format="json").decode("utf-8")
    # xgboost 3.x puede devolver float32; parsear y re-serializar para asegurar float nativo
    booster_dict = json.loads(model_json)

    export = {
        "meta": {
            "feature_names": FEATURE_NAMES,
            "n_features": len(FEATURE_NAMES),
            "n_estimators": n_estimators,
            "max_depth": max_depth,
            "learning_rate": learning_rate,
            "threshold": threshold,
            "accuracy": acc,
            "precision": prec,
            "recall": rec,
            "f1": f1,
            "train_samples": len(X_train),
            "test_samples": len(X_test),
            "baseline_wr": float(win_rate),
            "trained_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        },
        "features": FEATURE_NAMES,
        "importance": importance,
        "xgboost_model": booster_dict,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(export, indent=2))
    print(f"[train_ml] 💾 Modelo exportado → {output_path} ({output_path.stat().st_size / 1024:.0f} KB)", file=sys.stderr)
    return export


def main() -> int:
    install_xgboost()

    p = argparse.ArgumentParser(description="JARVIS ML Model Trainer")
    p.add_argument("ticker", help="Ticker (ej. EURUSD)")
    p.add_argument("--log-dir", default=None, help="Directorio de logs Pine (default: logs/<ticker>/history_exported)")
    p.add_argument("--output-dir", default=str(MODELS_DIR), help="Directorio de salida del modelo")
    p.add_argument("--n-estimators", type=int, default=100)
    p.add_argument("--max-depth", type=int, default=4)
    p.add_argument("--learning-rate", type=float, default=0.1)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    ticker = args.ticker.upper()
    log_dir = Path(args.log_dir) if args.log_dir else REPO_ROOT / "logs" / ticker.lower() / "history_exported"
    if not log_dir.exists():
        print(f"[train_ml] ERROR: {log_dir} no existe", file=sys.stderr)
        return 1

    entries = extract_features_from_logs(log_dir, ticker)
    if len(entries) < 20:
        print(f"[train_ml] ERROR: insuficientes muestras ({len(entries)}). Se necesitan ≥ 20.", file=sys.stderr)
        return 1

    output_path = Path(args.output_dir) / f"ml_model_{ticker}.json"
    train_model(
        entries,
        output_path,
        n_estimators=args.n_estimators,
        max_depth=args.max_depth,
        learning_rate=args.learning_rate,
        random_seed=args.seed,
    )

    # Copiar también como modelo default
    default_path = Path(args.output_dir) / "ml_model.json"
    import shutil
    shutil.copy(output_path, default_path)
    print(f"[train_ml] 💾 Default model → {default_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
