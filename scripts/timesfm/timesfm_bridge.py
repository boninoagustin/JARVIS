#!/usr/bin/env python3
"""timesfm_bridge.py — puente residente TimesFM ↔ JARVIS (Fase B / F1)

Proceso único con el modelo TimesFM 2.5 200M cargado en RAM. HTTP localhost JSON:

  GET  /health                         → estado del servicio
  GET  /forecast/latest?ticker=X&tf=15 → último forecast cacheado (<5ms)
  POST /forecast  {context, horizon}   → forecast directo síncrono (~1.1s, tooling)
  POST /ingest    {ticker, tf, ts, close} → vela cerrada nueva (202; recompute async)

Diseño:
  - El bot (SMCBridge) empuja cada vela cerrada vía /ingest (fire-and-forget).
  - Un solo worker thread de inferencia (el modelo NO es thread-safe).
  - El forecast se precomputa al cierre de vela → en el trigger solo hay lookup.
  - Bootstrap: al arrancar carga el historial desde
    logs/{ticker}/history_exported/pine-logs-SMC Master_{TF}.csv (mismo parser que F0).
  - Persistencia del último forecast: logs/{ticker}/forecasts/latest_M{tf}.json
  - Determinismo: torch.manual_seed(42), np.random.seed(42), threads=3.

Correr:  scripts/timesfm/.venv/bin/python scripts/timesfm/timesfm_bridge.py
Systemd: jarvis-timesfm-bridge.service
"""
from __future__ import annotations

import json
import math
import os
import queue
import re
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
LOGS_DIR = REPO_ROOT / "logs"
MODEL_ID = "google/timesfm-2.5-200m-pytorch"
MODEL_VERSION = "timesfm-2.5-200m-pytorch@f1"
SCHEMA_VERSION = 2
TIMESTAMP_CONVENTION = 'context_close_ms_v2'

PORT = int(os.environ.get("TIMESFM_BRIDGE_PORT", "8788"))
CONTEXT_N = int(os.environ.get("TIMESFM_CONTEXT", "512"))
HORIZON = int(os.environ.get("TIMESFM_HORIZON", "24"))
TRACKED_TFS = [int(x) for x in os.environ.get("TIMESFM_TFS", "15,5").split(",")]
MAXLEN = 2048

PING_RE = re.compile(
    r"PING_PRICE \| TF: (?P<tf>\S+) \| Precio: (?P<price>[0-9.]+) "
    r"\| High: (?P<high>[0-9.]+) \| Low: (?P<low>[0-9.]+).*?\| TS: (?P<ts>\d+)"
)

# ─── Estado global ────────────────────────────────────────────────────────────
_model = None
_infer_lock = threading.Lock()          # serializa TODA inferencia
_recompute_q: queue.Queue = queue.Queue()
_pending_keys: set = set()              # dedup de recompute pendientes
_series: dict = {}                      # (ticker, tf_min) -> deque[(ts_ms, close)]
_series_conventions: dict = {}          # legacy timestamps must never be relabelled
_state_lock = threading.RLock()
_latest: dict = {}                      # (ticker, tf_min) -> forecast dict
_started_at = time.time()


def norm_tf(tf) -> int:
    """Explicit protocol map. Unknown periods never acquire guessed identities."""
    mapping = {'M1': 1, 'M5': 5, 'M15': 15, 'M30': 30, 'H1': 60,
               'H4': 240, 'D1': 1440, 'D': 1440, 'W1': 10080, 'W': 10080}
    token = str(tf).upper()
    if token in mapping:
        return mapping[token]
    if re.fullmatch(r'[1-9]\d*', token) and int(token) in mapping.values():
        return int(token)
    raise ValueError('TF desconocido')


def norm_ts(ts: float) -> int:
    """Segundos → ms si hace falta."""
    ts = int(ts)
    return ts * 1000 if ts < 1_000_000_000_000 else ts


def load_model():
    global _model
    import torch
    import timesfm

    torch.manual_seed(42)
    np.random.seed(42)
    torch.set_num_threads(3)  # dejar cores libres para el bot
    torch.set_float32_matmul_precision("high")

    print(f"[BRIDGE] Cargando {MODEL_ID} (torch CPU)...", flush=True)
    t0 = time.time()
    m = timesfm.TimesFM_2p5_200M_torch.from_pretrained(MODEL_ID)
    m.compile(
        timesfm.ForecastConfig(
            max_context=1024,
            max_horizon=256,
            normalize_inputs=True,
            use_continuous_quantile_head=True,
            force_flip_invariance=True,
            infer_is_positive=True,
            fix_quantile_crossing=True,
        )
    )
    print(f"[BRIDGE] Modelo listo en {time.time()-t0:.1f}s", flush=True)
    _model = m


def forecast_batch(contexts: list, horizon: int) -> list:
    """Inferencia serializada. contexts: lista de np.array. Devuelve lista de dicts."""
    with _infer_lock:
        pf, qf = _model.forecast(horizon=horizon, inputs=[np.asarray(c, dtype=np.float64) for c in contexts])
    out = []
    for i in range(len(contexts)):
        # qf[i]: (horizon, 10) → idx 0 = mean, 1..9 = q10..q90 → q50 = idx 5
        out.append({
            "point": [float(x) for x in pf[i]],
            "q10": [float(x) for x in qf[i, :, 1]],
            "q50": [float(x) for x in qf[i, :, 5]],
            "q90": [float(x) for x in qf[i, :, 9]],
        })
    return out


def persist_latest(ticker: str, tf_min: int, fc: dict) -> None:
    try:
        d = LOGS_DIR / ticker / "forecasts"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"latest_M{tf_min}.json").write_text(json.dumps(fc))
    except Exception as e:
        print(f"[BRIDGE] WARN persist {ticker} M{tf_min}: {e}", flush=True)


def valid_forecast_arrays(res: dict, horizon: int) -> bool:
    if not isinstance(res, dict) or not isinstance(horizon, int) or not 1 <= horizon <= 256:
        return False
    for name in ('point', 'q10', 'q50', 'q90'):
        a = res.get(name)
        if not isinstance(a, list) or len(a) != horizon or any(type(x) not in (int, float) or not math.isfinite(x) for x in a):
            return False
    return all(lo <= mid <= hi for lo, mid, hi in zip(res['q10'], res['q50'], res['q90']))


def ingest_candle(body: dict) -> tuple:
    """v2 is explicit close time; old ts remains legacy, never converted to v2.

    Bootstrap CSV PING TS is already a close boundary (export_smc_csv).
    Disk latest/cache artifacts are deliberately NOT loaded or relabelled.
    """
    if not isinstance(body, dict):
        return 400, {'error': 'JSON object requerido'}
    try:
        ticker = body.get('ticker', '')
        if not isinstance(ticker, str) or not re.fullmatch(r'[A-Za-z0-9_]{1,40}', ticker):
            raise ValueError('ticker inválido')
        ticker = ticker.lower()
        tf_min = norm_tf(body.get('tf', 15))
        if tf_min not in TRACKED_TFS:
            raise ValueError('TF no configurado')
        close = body.get('close')
        raw_ts = body.get('ts')
        if type(close) not in (int, float) or not math.isfinite(close) or close <= 0 or type(raw_ts) not in (int, float) or not math.isfinite(raw_ts) or raw_ts <= 0 or raw_ts != int(raw_ts):
            raise ValueError('close/ts inválidos')
        explicit = any(k in body for k in ('schema_version', 'timestamp_convention', 'contextCloseTimeMs'))
        convention = TIMESTAMP_CONVENTION if explicit else 'legacy_unspecified'
        ts = int(raw_ts) if explicit else norm_ts(raw_ts)
        if explicit and (body.get('schema_version') != SCHEMA_VERSION or body.get('timestamp_convention') != TIMESTAMP_CONVENTION or type(body.get('contextCloseTimeMs')) is not int or body.get('contextCloseTimeMs') != ts or ts % (tf_min * 60000)):
            raise ValueError('convenio close v2 inválido')
        if ts > int(time.time() * 1000):
            raise ValueError('vela futura')
    except (ValueError, TypeError, OverflowError) as e:
        return 400, {'error': str(e)}
    key = (ticker, tf_min)
    with _state_lock:
        if key in _series and _series_conventions.get(key, 'legacy_unspecified') != convention:
            return 409, {'error': 'convenciones incompatibles; no relabel de series previas'}
        ser = _series.setdefault(key, deque(maxlen=MAXLEN))
        _series_conventions[key] = convention
        if ser and ts <= ser[-1][0]:
            return 202, {'queued': False, 'reason': 'vela vieja/duplicada'}
        ser.append((ts, float(close)))
        queued = enqueue_recompute(ticker, tf_min) if len(ser) >= CONTEXT_N else False
        return 202, {'queued': queued, 'series_len': len(ser)}


def recompute(ticker: str, tf_min: int) -> None:
    key = (ticker, tf_min)
    with _state_lock:
        snapshot = list(_series.get(key, ()))
        convention = _series_conventions.get(key, 'legacy_unspecified')
    if len(snapshot) < CONTEXT_N:
        return
    closes = np.array([c for _, c in snapshot[-CONTEXT_N:]], dtype=np.float64)
    origin_ts = snapshot[-1][0]
    try:
        res = forecast_batch([closes], HORIZON)[0]
        if not valid_forecast_arrays(res, HORIZON):
            raise ValueError('forecast arrays inválidos')
    except Exception as e:
        print(f"[BRIDGE] ERROR forecast {ticker} M{tf_min}: {e}", flush=True)
        return
    computed_at = int(time.time() * 1000)
    if origin_ts > computed_at:
        return
    fc = {
        'ticker': ticker, 'tf': tf_min, 'ts': origin_ts, 'horizon': HORIZON,
        **res, 'model_version': MODEL_VERSION,
        'computed_at': computed_at, 'context_n': CONTEXT_N,
    }
    if convention == TIMESTAMP_CONVENTION:
        fc.update(schema_version=SCHEMA_VERSION, timestamp_convention=TIMESTAMP_CONVENTION,
                  contextCloseTimeMs=origin_ts, computedAt=computed_at, availableAt=computed_at)
    with _state_lock:
        previous = _latest.get(key)
        if previous and previous['ts'] > origin_ts:
            return
        _latest[key] = fc
    persist_latest(ticker, tf_min, fc)
    print(f"[BRIDGE] ✓ forecast {ticker} M{tf_min} @ ts={origin_ts} (q50[-1]={res['q50'][-1]:.5f})", flush=True)


def inference_worker() -> None:
    while True:
        key = _recompute_q.get()
        _pending_keys.discard(key)
        try:
            recompute(*key)
        except Exception as e:
            print(f"[BRIDGE] ERROR worker {key}: {e}", flush=True)


def enqueue_recompute(ticker: str, tf_min: int) -> bool:
    key = (ticker, tf_min)
    if key in _pending_keys:
        return False
    _pending_keys.add(key)
    _recompute_q.put(key)
    return True


def bootstrap_from_csv() -> None:
    """Carga historial de cierres desde los pine-logs (mismo parser que F0)."""
    if not LOGS_DIR.exists():
        return
    for ticker_dir in sorted(LOGS_DIR.iterdir()):
        hist = ticker_dir / "history_exported"
        if not hist.is_dir():
            continue
        ticker = ticker_dir.name
        for tf_min in TRACKED_TFS:
            fname = hist / f"pine-logs-SMC Master_M{tf_min}.csv"
            if not fname.exists():
                matches = list(hist.glob(f"*M{tf_min}*.csv"))
                if not matches:
                    continue
                fname = matches[0]
            n = 0
            try:
                # Fresh CSV bootstrap only. PING TS is already close, not open.
                # Never load latest_M*.json or reinterpret an old cache artifact.
                ser = deque(maxlen=MAXLEN)
                with open(fname, "r", errors="replace") as f:
                    for line in f:
                        m = PING_RE.search(line)
                        if not m:
                            continue
                        try:
                            ts = norm_ts(m.group('ts'))
                            close = float(m.group('price'))
                            if norm_tf(m.group('tf')) != tf_min or ts <= 0 or ts % (tf_min * 60000) or ts > int(time.time()*1000) or not math.isfinite(close) or close <= 0 or (ser and ts <= ser[-1][0]):
                                continue
                        except (ValueError, TypeError, OverflowError):
                            continue
                        ser.append((ts, close))
                        n += 1
                with _state_lock:
                    _series[(ticker, tf_min)] = ser
                    _series_conventions[(ticker, tf_min)] = TIMESTAMP_CONVENTION
                print(f"[BRIDGE] bootstrap {ticker} M{tf_min}: {n} cierres", flush=True)
                if len(ser) >= CONTEXT_N:
                    enqueue_recompute(ticker, tf_min)
            except Exception as e:
                print(f"[BRIDGE] WARN bootstrap {fname}: {e}", flush=True)


# ─── HTTP ─────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silenciar access log
        pass

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        ln = int(self.headers.get("Content-Length", 0))
        if ln <= 0 or ln > 10_000_000:
            return {}
        return json.loads(self.rfile.read(ln))

    def do_GET(self) -> None:
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            tracked = {}
            for (ticker, tf_min), ser in _series.items():
                fc = _latest.get((ticker, tf_min))
                tracked.setdefault(ticker, {})[f"M{tf_min}"] = {
                    "series_len": len(ser),
                    "last_ts": ser[-1][0] if ser else None,
                    "forecast_age_s": round((time.time()*1000 - fc["ts"]) / 1000, 1) if fc else None,
                }
            self._json(200, {
                "ok": _model is not None, "model": MODEL_VERSION,
                "uptime_s": round(time.time() - _started_at, 1),
                "queue_depth": _recompute_q.qsize(), "tracked": tracked,
            })
            return
        if u.path == "/forecast/latest":
            ticker = (q.get("ticker") or [""])[0].lower()
            tf_min = norm_tf((q.get("tf") or ["15"])[0])
            fc = _latest.get((ticker, tf_min))
            if not fc:
                self._json(404, {"error": f"sin forecast para {ticker} M{tf_min}"})
                return
            self._json(200, fc)
            return
        self._json(404, {"error": "ruta desconocida"})

    def do_POST(self) -> None:
        u = urlparse(self.path)
        try:
            body = self._body()
        except Exception as e:
            self._json(400, {"error": f"JSON inválido: {e}"})
            return

        if u.path == "/ingest":
            code, response = ingest_candle(body)
            self._json(code, response)
            return

        if u.path == "/forecast":
            ctx = body.get("context")
            horizon = int(body.get("horizon", HORIZON))
            if not ctx or len(ctx) < 32:
                self._json(400, {"error": "context ausente o < 32 puntos"})
                return
            t0 = time.time()
            res = forecast_batch([np.asarray(ctx[-1024:], dtype=np.float64)], horizon)[0]
            self._json(200, {
                "ts": None, "horizon": horizon, **res,
                "model_version": MODEL_VERSION,
                "latency_ms": round((time.time() - t0) * 1000, 1),
            })
            return

        self._json(404, {"error": "ruta desconocida"})


def main() -> None:
    load_model()
    threading.Thread(target=inference_worker, daemon=True).start()
    bootstrap_from_csv()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[BRIDGE] Escuchando en http://127.0.0.1:{PORT} | TFs tracked: {TRACKED_TFS}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
