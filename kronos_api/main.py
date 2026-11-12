import os
import io
import json
import subprocess
import shutil
import tempfile
import time
import pandas as pd
from fastapi import FastAPI, HTTPException, UploadFile, File, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

# Attempt to load model lazily to allow fast API startup without heavy weights loaded immediately, or load eagerly if preferred.
# For simplicity, we'll try to load them eagerly on startup.
import torch

try:
    from model import Kronos, KronosTokenizer, KronosPredictor
    MODEL_AVAILABLE = True
except ImportError as e:
    print(f"Warning: Could not import Kronos models. Ensure 'model/' directory exists and dependencies are met. Error: {e}")
    MODEL_AVAILABLE = False

app = FastAPI(title="Kronos Prediction API")

# CORS — permitir requests desde el dashboard (Vite :5173)
app.add_middleware(
    CORSMiddleware,
    # El dashboard se accede por IP pública (169.58.163.132), Tailscale (100.x, IP dinámica)
    # o localhost. Regex para cubrirlas todas sin listar cada IP Tailscale.
    allow_origin_regex=r"http://(169\.58\.163\.132|100\.\d+\.\d+\.\d+|localhost|127\.0\.0\.1):5173",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables for caching model
tokenizer = None
kronos_model = None
predictor = None

class KlineData(BaseModel):
    timestamp: str # Or int
    open: float
    high: float
    low: float
    close: float
    volume: Optional[float] = 0.0
    amount: Optional[float] = 0.0

class PredictRequest(BaseModel):
    ticker: str
    klines: List[KlineData]
    pred_len: int = 10
    direction: Optional[str] = None # "BUY" o "SELL"
    entry_price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None

@app.on_event("startup")
async def startup_event():
    """Modelo ML se carga lazy en /predict. Server arranca inmediato."""
    print("Kronos API ready. Modelo ML se cargará en el primer /predict.")

@app.get("/health")
async def health():
    return {
        "status": "online",
        "model_loaded": predictor is not None,
        "device": str(next(kronos_model.parameters()).device) if kronos_model is not None else "N/A"
    }

@app.post("/predict")
async def predict(req: PredictRequest):
    global tokenizer, kronos_model, predictor
    if not MODEL_AVAILABLE:
        raise HTTPException(status_code=503, detail="Kronos model is not available (missing dependencies).")
    
    # Lazy load on first predict call
    if predictor is None:
        try:
            device = "cuda" if torch.cuda.is_available() else "cpu"
            print(f"[Kronos] Loading models on first /predict call (device: {device})...")
            tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
            kronos_model = Kronos.from_pretrained("NeoQuasar/Kronos-small").to(device)
            predictor = KronosPredictor(kronos_model, tokenizer, max_context=512)
            print("[Kronos] Models loaded successfully!")
        except Exception as e:
            print(f"[Kronos] Error loading models: {e}")
            raise HTTPException(status_code=503, detail=f"Failed to load model: {e}")
        
    if len(req.klines) == 0:
        raise HTTPException(status_code=400, detail="Empty klines array provided.")
        
    try:
        # Convert to pandas DataFrame
        df = pd.DataFrame([k.dict() for k in req.klines])
        
        # Parse timestamps ensuring they are datetime
        df['timestamp'] = pd.to_datetime(df['timestamp'])
        
        # X timestamps
        x_timestamp = df['timestamp']
        
        # Select required columns
        x_df = df[['open', 'high', 'low', 'close', 'volume', 'amount']]
        
        # Generate future y_timestamps based on the interval difference of the last two candles
        if len(df) > 1:
            interval = df['timestamp'].iloc[-1] - df['timestamp'].iloc[-2]
        else:
            interval = pd.Timedelta(minutes=5) # Default 5m fallback
            
        last_time = df['timestamp'].iloc[-1]
        y_timestamp = pd.Series([last_time + interval * i for i in range(1, req.pred_len + 1)])
        
        # Call Predictor
        pred_df = predictor.predict(
            df=x_df,
            x_timestamp=x_timestamp,
            y_timestamp=y_timestamp,
            pred_len=req.pred_len,
            T=1.0,
            top_p=0.9,
            sample_count=1
        )
        
        last_close_val = float(df['close'].iloc[-1])
        
        # Lógica Cuantitativa de Riesgo
        if req.direction and req.stop_loss and req.take_profit:
            pred_min_low = float(pred_df['low'].min())
            pred_max_high = float(pred_df['high'].max())
            
            if req.direction.upper() == "BUY":
                if pred_min_low <= req.stop_loss:
                    pred_trend = "BEARISH" # Rechazar trade (toca el SL)
                    details = f"El modelo predice una caída hasta {pred_min_low:.5f}, perforando el SL ({req.stop_loss:.5f})."
                else:
                    pred_trend = "BULLISH"
                    details = f"Modelo estima soporte en {pred_min_low:.5f} (SL a salvo). TP proyectado en radar."
            else: # SELL
                if pred_max_high >= req.stop_loss:
                    pred_trend = "BULLISH" # Rechazar trade (toca el SL)
                    details = f"El modelo predice un pico hasta {pred_max_high:.5f}, perforando el SL ({req.stop_loss:.5f})."
                else:
                    pred_trend = "BEARISH"
                    details = f"Modelo estima techo en {pred_max_high:.5f} (SL a salvo). TP proyectado en radar."
            
            future_close_avg = float(pred_df['close'].mean())
        else:
            # Fallback a lógica clásica si no envían datos de ejecución
            future_close_avg = float(pred_df['close'].mean())
            pred_trend = "BULLISH" if future_close_avg > last_close_val else "BEARISH"
            details = f"Promedio estimado: {future_close_avg:.5f}"
        
        # Reset index to dump to json easily
        pred_df = pred_df.reset_index().rename(columns={"index": "timestamp"})
        # Format timestamps to strings
        pred_df['timestamp'] = pred_df['timestamp'].astype(str)
        
        return {
            "status": "success",
            "ticker": req.ticker,
            "trend": pred_trend,
            "details": details,
            "last_close": float(last_close_val),
            "future_close_avg": float(future_close_avg),
            "predictions": pred_df.to_dict(orient="records")
        }
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


JARVIS_DIR = "/opt/JARVIS"


@app.post("/api/backtest/export-csv")
async def backtest_export_csv(ticker: str, tfs: str = "M5,M15,H1,H4,D1"):
    """Genera los CSVs de logs SMC para un ticker usando el SMCEngine.

    Lo usa el ciclo semanal (run_weekly.py → refresh_csvs) para regenerar el histórico
    antes del hyperopt. Restaurado del commit anterior a f71d6c2 (que lo borró como parte
    de 'eliminar backtesting manual', sin notar que el BOT depende de esta ruta).
    """
    script = os.path.join(JARVIS_DIR, "scripts", "export_smc_csv.ts")
    if not os.path.exists(script):
        raise HTTPException(status_code=500, detail="Script export_smc_csv.ts no encontrado")

    env = os.environ.copy()
    env["PATH"] = "/root/.nvm/versions/node/v24.19.0/bin:" + env.get("PATH", "")

    import glob
    for d in glob.glob("/tmp/tsx-*") + glob.glob("/tmp/esbuild-*"):
        shutil.rmtree(d, ignore_errors=True)
    shutil.rmtree("/root/.cache/esbuild", ignore_errors=True)

    results = {}
    for tf in tfs.split(","):
        tf = tf.strip()
        try:
            result = subprocess.run(
                ["npx", "tsx", script, ticker, "--timeframes", tf],
                capture_output=True, text=True, timeout=300,
                cwd=JARVIS_DIR, env=env,
            )
            output = result.stdout if result.returncode == 0 else (result.stderr or result.stdout or "")
            results[tf] = {"ok": result.returncode == 0, "output": output[-200:]}
        except subprocess.TimeoutExpired:
            results[tf] = {"ok": False, "error": "timeout"}
        except Exception as e:
            results[tf] = {"ok": False, "error": str(e)}

    return {"status": "ok", "ticker": ticker, "results": results}


# ────────────────────────────────────────────────────────────────────────────
# Detección SMC por activo: salud del roster + optimizador a demanda (oct-2026)
# El panel lee detection_health/{ticker} directo de Firestore; estos endpoints
# solo LANZAN los procesos largos en background (con flock anti-duplicados).
# ────────────────────────────────────────────────────────────────────────────

def _detection_env() -> dict:
    env = os.environ.copy()
    env["PATH"] = "/root/.nvm/versions/node/v24.19.0/bin:" + env.get("PATH", "")
    env["NODE_OPTIONS"] = "--max-old-space-size=2560"
    return env


@app.post("/api/detection/health-all")
async def detection_health_all():
    """Evalúa el baseline actual de TODOS los tickers con history (sin búsqueda, ~30-60s/ticker)
    y puebla Firestore detection_health/. Corre en background."""
    script = os.path.join(JARVIS_DIR, "scripts", "periodic_opt", "run_detection_health.sh")
    if not os.path.exists(script):
        raise HTTPException(status_code=500, detail="run_detection_health.sh no encontrado")
    try:
        subprocess.Popen(
            ["/bin/bash", script],
            cwd=JARVIS_DIR, env=_detection_env(),
            stdout=open(os.path.join("/tmp", "detection_health_all.log"), "a"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        return {"status": "started", "detail": "Evaluación de salud lanzada en background (ver /tmp/detection_health_all.log)"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudo lanzar: {e}")


@app.post("/api/detection/optimize")
async def detection_optimize(ticker: str):
    """Optimizador de detección A DEMANDA para un activo: búsqueda (60 trials) + validación OOS
    + aplicación si supera la regla conservadora, y refresca su detection_health. Background."""
    ticker = ticker.upper().strip()
    if not ticker or not ticker.replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Ticker inválido")
    hist_dir = os.path.join(JARVIS_DIR, "logs", ticker.lower(), "history")
    if not os.path.isdir(hist_dir):
        raise HTTPException(status_code=404, detail=f"Sin historia para {ticker}")

    # Marcar "optimizando" en Firestore vía el propio health doc
    try:
        from firebase_admin import firestore as fa_firestore
        import firebase_admin
        sa_path = os.path.join(JARVIS_DIR, "service-account.json")
        if os.path.exists(sa_path) and not firebase_admin._apps:
            from firebase_admin import credentials
            firebase_admin.initialize_app(credentials.Certificate(sa_path))
        if firebase_admin._apps:
            db_client = fa_firestore.client()
            db_client.collection("detection_health").document(ticker).set({
                "status": "OPTIMIZANDO",
                "optimizingAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            }, merge=True)
    except Exception as fe:
        print(f"[KRONOS] Warning marcando status OPTIMIZANDO: {fe}")

    # 03-nov-2026: la lógica vive en scripts/ops/optimize_ticker.sh (NODE_OPTIONS para el
    # tune, stderr a log, reinicio del bot si aplica y refresco de salud).
    cmd = f"bash {JARVIS_DIR}/scripts/ops/optimize_ticker.sh {ticker}"
    try:
        subprocess.Popen(
            ["/bin/bash", "-c", cmd],
            cwd=JARVIS_DIR, env=_detection_env(),
            stdout=open(os.path.join("/tmp", f"detection_opt_{ticker}.log"), "a"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        return {"status": "started", "ticker": ticker,
                "detail": f"Optimización de {ticker} lanzada (~10-15 min). Ver /tmp/detection_opt_{ticker}.log"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudo lanzar: {e}")


# ML calibration is bounded, serialized, read-only except isolated candidates.
# This installation has no dashboard login. Same-origin/custom-header CSRF guard
# follows its trusted-dashboard deployment; this is NOT user authentication.
import re
import threading
from pathlib import Path

_ML_LOCK = threading.Lock()
_ML_PROCESS = None
_ML_REFRESH_AT = 0.0
_ML_FIT_AT = {}
_ML_CACHE = Path(JARVIS_DIR) / 'data/ml_calibration/status.json'


def _ml_origin(request, mutation=False):
    origin = request.headers.get('origin', '')
    if not re.fullmatch(r'http://(169\.58\.163\.132|100\.\d+\.\d+\.\d+|localhost|127\.0\.0\.1):5173', origin):
        raise HTTPException(status_code=403, detail='Trusted dashboard Origin required')
    if mutation and request.headers.get('x-jarvis-ml') != 'recalibrate':
        raise HTTPException(status_code=403, detail='X-Jarvis-ML: recalibrate required')


def _ml_cached():
    try:
        value = json.loads(_ML_CACHE.read_text())
        if not isinstance(value.get('assets'), dict):
            raise ValueError('invalid cache')
        return value
    except (OSError, ValueError):
        return {'assets': {}, 'state': 'PENDING'}


def _ml_running():
    return _ML_PROCESS is not None and _ML_PROCESS.poll() is None


def _ml_start(action, ticker=None, bootstrap=False):
    global _ML_PROCESS
    args = [os.path.join(JARVIS_DIR, 'scripts/hyperopt/.venv/bin/python'),
            os.path.join(JARVIS_DIR, 'scripts/ml_calibration_status.py'), action]
    if ticker:
        args += ['--ticker', ticker]
    if bootstrap:
        args += ['--bootstrap']
    log_path = Path(JARVIS_DIR) / 'data/ml_calibration/worker.log'
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open('a') as log:
        _ML_PROCESS = subprocess.Popen(args, cwd=JARVIS_DIR, env=_detection_env(),
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)


@app.get('/api/ml-gate/status')
async def ml_gate_status(request: Request):
    """Cached exact worker counters; one background refresh per 15 minutes."""
    global _ML_REFRESH_AT
    _ml_origin(request)
    with _ML_LOCK:
        cached = _ml_cached()
        stale = time.time()*1000-cached.get('updatedAt', 0) >= 900000
        if not _ml_running() and stale and time.monotonic()-_ML_REFRESH_AT >= 900:
            _ml_start('refresh')
            _ML_REFRESH_AT = time.monotonic()
        cached['refreshing'] = _ml_running()
        return cached


@app.post('/api/ml-gate/recalibrate')
async def ml_gate_recalibrate(request: Request, ticker: str, bootstrap: bool = False):
    """Recheck exact data then fit an isolated candidate; never activate it."""
    _ml_origin(request, mutation=True)
    ticker = ticker.strip().upper()
    if not re.fullmatch(r'[A-Z0-9]{1,24}', ticker):
        raise HTTPException(status_code=400, detail='Invalid ticker')
    with _ML_LOCK:
        row = _ml_cached()['assets'].get(ticker)
        if row is None or not row.get('trade'):
            raise HTTPException(status_code=404, detail='Official TRADE asset required; refresh status first')
        if _ml_running():
            raise HTTPException(status_code=409, detail='Serialized ML worker already running')
        if not row.get('ready') or time.time()*1000-row.get('updatedAt', 0) > 3600000:
            raise HTTPException(status_code=409, detail='Readiness is insufficient or stale; refresh status first')
        if row.get('bootstrapRequired') and not bootstrap:
            raise HTTPException(status_code=409, detail='Explicit bootstrap=true confirmation required for unknown old provenance')
        if time.monotonic()-_ML_FIT_AT.get(ticker, -3600) < 3600:
            raise HTTPException(status_code=429, detail='One recalibration per asset per hour')
        _ml_start('recalibrate', ticker, bootstrap)
        _ML_FIT_AT[ticker] = time.monotonic()
        return {'status': 'started', 'ticker': ticker, 'promoted': False}


# Read-only operational gate monitor; separate cache, same CPU serialization lock.
import fcntl
_ML_MONITOR_PROCESS = None
_ML_MONITOR_CACHE = Path(JARVIS_DIR) / 'data/ml_gate_monitor/status.json'
_ML_MONITOR_RATE = Path(JARVIS_DIR) / 'data/ml_gate_monitor/request_rate.json'


def _ml_monitor_cached():
    try:
        body = json.loads(_ML_MONITOR_CACHE.read_text())
        if not isinstance(body.get('assets'), dict):
            raise ValueError('Invalid monitor cache')
        return body
    except (OSError, ValueError):
        return {'schemaVersion': 1, 'scope': 'post_activation_replay', 'state': 'PENDING',
                'assets': {}, 'activeGateCount': 0, 'automaticAction': False}


def _ml_monitor_running():
    return _ML_MONITOR_PROCESS is not None and _ML_MONITOR_PROCESS.poll() is None


def _ml_monitor_lock_available():
    path = Path(JARVIS_DIR) / 'data/ml_calibration/worker.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(lock, fcntl.LOCK_UN)
        return True


@app.get('/api/ml-gate/monitor/status')
async def ml_gate_monitor_status(request: Request):
    _ml_origin(request)
    with _ML_LOCK:
        body = _ml_monitor_cached()
        body['refreshing'] = _ml_monitor_running()
        return body


@app.post('/api/ml-gate/monitor/refresh')
async def ml_gate_monitor_refresh(request: Request):
    global _ML_MONITOR_PROCESS
    _ml_origin(request, mutation=True)
    with _ML_LOCK:
        if _ml_monitor_running() or _ml_running() or not _ml_monitor_lock_available():
            raise HTTPException(status_code=409, detail='Serialized ML worker already running')
        try:
            last = json.loads(_ML_MONITOR_RATE.read_text()).get('requestedAtMs', 0)
        except (OSError, ValueError):
            last = 0
        at = int(time.time()*1000)
        if at-last < 3600000:
            raise HTTPException(status_code=429, detail='One monitor refresh per hour')
        _ML_MONITOR_RATE.parent.mkdir(parents=True, exist_ok=True)
        args = [os.path.join(JARVIS_DIR, 'scripts/hyperopt/.venv/bin/python'),
                os.path.join(JARVIS_DIR, 'scripts/ml_gate_monitor.py'), 'refresh']
        with (_ML_MONITOR_RATE.parent/'worker.log').open('a') as log:
            _ML_MONITOR_PROCESS = subprocess.Popen(args, cwd=JARVIS_DIR, env=_detection_env(),
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        tmp = _ML_MONITOR_RATE.with_suffix('.tmp')
        tmp.write_text(json.dumps({'requestedAtMs': at}))
        os.replace(tmp, _ML_MONITOR_RATE)
        return {'status': 'started', 'automaticAction': False, 'detail': 'Read-only monitor; no model/config/order changes'}
