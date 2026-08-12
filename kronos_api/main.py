import os
import io
import json
import subprocess
import tempfile
import shutil
import pandas as pd
from fastapi import FastAPI, HTTPException, UploadFile, File
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
    allow_origins=["http://169.58.163.132:5173", "http://localhost:5173", "http://127.0.0.1:5173"],
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
    """Modelo ML se carga lazy en /predict. Server arranca inmediato para backtesting."""
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


# ── BACKTEST ENDPOINTS ────────────────────────────────────────────────────────

class BacktestConfig(BaseModel):
    minBuyPoints: float = 5
    minSellPoints: float = 5
    slBuffer: float = 0.0015
    fixedRR: float = 1.5
    entryTrigger: str = "SMART"
    partialClosePct: float = 0.5
    slAfterTp1: str = "midpoint"
    tp15BeEnabled: bool = True
    atrTrailEnabled: bool = True
    structuralTrailEnabled: bool = False
    spreadPips: float = 1.5
    minRR: float = 0.75

JARVIS_DIR = "/opt/JARVIS"
NODE_BIN = "/root/.nvm/versions/node/v24.19.0/bin/node"
TSX_BIN = "/root/.nvm/versions/node/v24.19.0/bin/npx"


@app.post("/api/backtest/run")
async def backtest_run(ticker: str, tfs: str, config_json: str = ""):
    """
    Ejecuta backtesting contra archivos CSV existentes en el VPS.
    ticker: 'BTCUSD', tfs: 'M5,M15,H1,H4,D1'
    config_json: JSON con parámetros (opcional)
    """
    script = os.path.join(JARVIS_DIR, "jarvis-os", "scripts", "backtest_server.ts")
    if not os.path.exists(script):
        raise HTTPException(status_code=500, detail="Script de backtesting no encontrado en el VPS")
    
    cmd = [TSX_BIN, "tsx", script, ticker, tfs]
    if config_json:
        cmd.append(config_json)
    
    try:
        env = os.environ.copy()
        env["PATH"] = "/root/.nvm/versions/node/v24.19.0/bin:" + env.get("PATH", "")
        # Limpiar caché de tsx/esbuild para evitar versiones stale
        import glob
        for d in glob.glob("/tmp/tsx-*") + glob.glob("/tmp/esbuild-*"):
            shutil.rmtree(d, ignore_errors=True)
        shutil.rmtree("/root/.cache/esbuild", ignore_errors=True)
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300,
            cwd=os.path.join(JARVIS_DIR, "jarvis-os"), env=env
        )
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"Backtest error: {result.stderr[:500]}")
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Backtest excedió el tiempo límite (5 min)")
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail=f"Respuesta inválida del backtest: {result.stdout[:300]}")


@app.post("/api/backtest/export-csv")
async def backtest_export_csv(ticker: str, tfs: str = "M5,M15,H1,H4,D1"):
    """
    Genera los CSVs de logs SMC para un ticker usando el SMCEngine.
    """
    script = os.path.join(JARVIS_DIR, "scripts", "export_smc_csv.ts")
    if not os.path.exists(script):
        raise HTTPException(status_code=500, detail="Script export_smc_csv.ts no encontrado")
    
    env = os.environ.copy()
    env["PATH"] = "/root/.nvm/versions/node/v24.19.0/bin:" + env.get("PATH", "")
    
    # Limpiar caché
    import glob
    for d in glob.glob("/tmp/tsx-*") + glob.glob("/tmp/esbuild-*"):
        shutil.rmtree(d, ignore_errors=True)
    shutil.rmtree("/root/.cache/esbuild", ignore_errors=True)
    
    results = {}
    for tf in tfs.split(","):
        tf = tf.strip()
        try:
            result = subprocess.run(
                ["npx", "tsx", script, ticker, tf],
                capture_output=True, text=True, timeout=300,
                cwd=JARVIS_DIR, env=env
            )
            results[tf] = {"ok": result.returncode == 0, "output": result.stdout[-200:] if result.stdout else ""}
        except subprocess.TimeoutExpired:
            results[tf] = {"ok": False, "error": "timeout"}
        except Exception as e:
            results[tf] = {"ok": False, "error": str(e)}
    
    return {"status": "ok", "ticker": ticker, "results": results}


@app.post("/api/backtest/upload")
async def backtest_upload(
    ticker: str,
    files: list[UploadFile] = File(...)
):
    """
    Sube archivos CSV de logs SMC al VPS para backtesting.
    Los archivos se guardan en /opt/JARVIS/logs/{ticker}/history_exported/
    """
    dest_dir = os.path.join(JARVIS_DIR, "logs", ticker.lower(), "history_exported")
    os.makedirs(dest_dir, exist_ok=True)
    
    saved = []
    for f in files:
        # Solo aceptar CSVs de logs SMC
        if not f.filename or not f.filename.startswith("pine-logs-SMC"):
            continue
        dest = os.path.join(dest_dir, f.filename)
        with open(dest, "wb") as out:
            shutil.copyfileobj(f.file, out)
        saved.append(f.filename)
    
    return {"status": "ok", "ticker": ticker, "saved": saved, "dir": dest_dir}


@app.post("/api/backtest/optimize")
async def backtest_optimize(ticker: str, tfs: str, config_json: str = ""):
    """
    Auto-Tune Global: GA con el motor real.
    """
    script = os.path.join(JARVIS_DIR, "jarvis-os", "scripts", "backtest_optimize_server.ts")
    if not os.path.exists(script):
        raise HTTPException(status_code=500, detail="Script de optimización no encontrado")
    
    cmd = [TSX_BIN, "tsx", script, ticker, tfs]
    if config_json:
        cmd.append(config_json)
    
    try:
        env = os.environ.copy()
        env["PATH"] = "/root/.nvm/versions/node/v24.19.0/bin:" + env.get("PATH", "")
        # Limpiar caché de tsx/esbuild para evitar versiones stale
        import glob
        for d in glob.glob("/tmp/tsx-*") + glob.glob("/tmp/esbuild-*"):
            shutil.rmtree(d, ignore_errors=True)
        shutil.rmtree("/root/.cache/esbuild", ignore_errors=True)
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=600,
            cwd=os.path.join(JARVIS_DIR, "jarvis-os"), env=env
        )
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"Optimize error: {result.stderr[:500]}")
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Optimización excedió el tiempo límite (10 min)")
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail=f"Respuesta inválida: {result.stdout[:300]}")


@app.get("/api/backtest/files")
async def backtest_files(ticker: str):
    """Lista los archivos CSV disponibles para un ticker."""
    ticker_dir = os.path.join(JARVIS_DIR, "logs", ticker.lower(), "history_exported")
    if not os.path.exists(ticker_dir):
        return {"ticker": ticker, "files": []}
    files = [f for f in os.listdir(ticker_dir) if f.startswith("pine-logs-SMC")]
    # Incluir conteo de líneas para mostrar en el panel
    file_info = []
    for f in sorted(files):
        try:
            with open(os.path.join(ticker_dir, f), "rb") as fh:
                lines = sum(1 for _ in fh)
        except Exception:
            lines = 0
        file_info.append({"name": f, "lines": lines})
    return {"ticker": ticker, "files": file_info, "dir": ticker_dir}
