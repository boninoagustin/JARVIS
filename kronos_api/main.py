import os
import io
import pandas as pd
from fastapi import FastAPI, HTTPException
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

@app.on_event("startup")
async def startup_event():
    global tokenizer, kronos_model, predictor
    if not MODEL_AVAILABLE:
        print("Model imports failed. API will run but /predict will return 503.")
        return
        
    print("Loading Kronos models from HuggingFace Hub... This might take a while on first run.")
    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Using device: {device}")
        
        # Load small model for less RAM usage by default
        tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
        kronos_model = Kronos.from_pretrained("NeoQuasar/Kronos-small").to(device)
        
        predictor = KronosPredictor(kronos_model, tokenizer, max_context=512)
        print("Models loaded successfully!")
    except Exception as e:
        print(f"Error loading models on startup: {e}")

@app.get("/health")
async def health():
    return {
        "status": "online",
        "model_loaded": predictor is not None,
        "device": str(next(kronos_model.parameters()).device) if kronos_model is not None else "N/A"
    }

@app.post("/predict")
async def predict(req: PredictRequest):
    if predictor is None:
        raise HTTPException(status_code=503, detail="Kronos model is not loaded or not available.")
        
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
        
        # Determine the trend based on 'close' prediction
        last_close_val = df['close'].iloc[-1]
        future_close_avg = pred_df['close'].mean()
        pred_trend = "BULLISH" if future_close_avg > last_close_val else "BEARISH"
        
        # Reset index to dump to json easily
        pred_df = pred_df.reset_index().rename(columns={"index": "timestamp"})
        # Format timestamps to strings
        pred_df['timestamp'] = pred_df['timestamp'].astype(str)
        
        return {
            "status": "success",
            "ticker": req.ticker,
            "trend": pred_trend,
            "last_close": float(last_close_val),
            "future_close_avg": float(future_close_avg),
            "predictions": pred_df.to_dict(orient="records")
        }
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
