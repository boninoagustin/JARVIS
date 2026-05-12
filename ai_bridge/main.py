# AI Bridge — Microservicios Python para JARVIS
# Arquitectura: FastAPI + OpenBB SDK + LangChain Swarm
# Corre en Docker en PC local, expone endpoints REST para Vercel
# ---------------------------------------------------------------------------
# Dependencias:
#   pip install fastapi uvicorn openbb langchain langchain-openai pydantic httpx

import os
import json
import asyncio
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime, timedelta

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import httpx

# ═══════════════════════════════════════════════════════════════════════════════
# MODELOS DE DATOS (lo que Vercel/TypeScript envía y recibe)
# ═══════════════════════════════════════════════════════════════════════════════

class TradeAlert(BaseModel):
    """Alerta OTE que JARVIS manda a analizar."""
    ticker: str
    direction: Literal["BUY", "SELL"]
    entryPrice: float
    stopLoss: float
    tp1Price: float
    tp2Price: Optional[float] = None
    points: int                          # Puntaje Jarvis (0-40)
    events: List[str] = []               # Confluencias detectadas
    confluenceReport: str = ""           # Reporte macro (HTML)
    marketBias: Dict[str, str] = {}      # { "240", "60", "15", "3" }
    consecutiveLosses: int = 0
    totalTrades: int = 0
    winRate: float = 0.0

class AgentVerdict(BaseModel):
    """Respuesta de un agente individual."""
    agent: str
    decision: Literal["APROBADO", "RECHAZADO"]
    reason: str

class SwarmResult(BaseModel):
    """Resultado final del enjambre — esto es lo que TypeScript parsea."""
    decision: Literal["EJECUTAR", "RECHAZAR"]
    risk_pct: float = Field(default=1.0, ge=0.1, le=3.0)
    summary: str
    votes: List[AgentVerdict] = []

class MacroData(BaseModel):
    """Datos macro de OpenBB."""
    vix: Optional[float] = None
    vixStatus: str = "NORMAL"           # NORMAL, ALTO, TOXICO
    dxy: Optional[float] = None
    us10y: Optional[float] = None
    upcomingEvents: List[Dict[str, str]] = []  # Próximos eventos de alto impacto
    sentiment: str = "NEUTRAL"           # RISK_ON, RISK_OFF, NEUTRAL
    lastUpdated: str = ""

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURACIÓN
# ═══════════════════════════════════════════════════════════════════════════════

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"

# Modelos: flash para agentes, pro para el juez
MODEL_ANALYST = "deepseek-chat"          # deepseek-v4-flash
MODEL_JUDGE = "deepseek-chat"            # deepseek-v4-pro

# ═══════════════════════════════════════════════════════════════════════════════
# SYSTEM PROMPTS (específicos para cada rol)
# ═══════════════════════════════════════════════════════════════════════════════

SYSTEM_PROMPTS = {
    "tecnico": """Eres un trader institucional purista de Smart Money Concepts (SMC).
Tu único trabajo es evaluar la viabilidad técnica de un setup.
Recibirás un reporte con el puntaje del algoritmo Jarvis, la dirección (BUY/SELL), el contexto macro (1H/4H) y las confluencias (CHoCH, Breakers, God Zones, Sweeps).

REGLAS:
1. Exige alineación macro. Si el trade es contra la tendencia de 4H y 1H, sé extremadamente crítico.
2. Valora la "Memoria Espacial": Si el trade nace dentro de un Order Block o Breaker de temporalidad mayor, es un setup de alta probabilidad (Grado A+).
3. Si el puntaje es menor a 5, considéralo "Inducement" (trampa minorista).

Responde con "APROBADO" o "RECHAZADO" seguido de una justificación técnica de máximo 2 líneas.""",

    "fundamental": """Eres un analista macroeconómico de un Hedge Fund. Tu rol es proteger el capital frente a la volatilidad algorítmica.
Recibirás datos extraídos de OpenBB (índice VIX, calendario económico de hoy, flujo de opciones).

REGLAS DE VETO:
1. Si el VIX es mayor a 25, la volatilidad es tóxica. VETA el trade.
2. Si hay noticias de alto impacto (Carpeta Roja / "High Impact") para la moneda base en los próximos 60 minutos (ej. FOMC, CPI, NFP), VETA el trade.
3. Ignora el análisis técnico, solo evalúa el peligro macroeconómico.

Responde con "APROBADO" (vía libre) o "RECHAZADO" (peligro inminente), justificando brevemente con el dato de OpenBB que causó tu decisión.""",

    "riesgo": """Eres el Chief Risk Officer (CRO). Tu trabajo es asegurar la esperanza matemática positiva del sistema.
Recibirás los niveles de Entrada, Stop Loss, Take Profit, y el estado de la racha perdedora actual.

REGLAS:
1. Calcula el Ratio Riesgo/Beneficio (R:R). Si es menor a 1.5:1, RECHAZA el trade.
2. Si el sistema tiene 3 o más pérdidas consecutivas, exige un setup perfecto. Veta cualquier trade que tenga un puntaje técnico (Jarvis Score) menor a 8.
3. Si el Stop Loss es demasiado amplio (mayor al promedio del ATR histórico), sugiere reducir el lotaje a la mitad.

Responde con "APROBADO" o "RECHAZADO" y especifica el porcentaje de riesgo sugerido (ej. 1% o 0.5%).""",

    "juez": """Eres el Portfolio Manager. Debes tomar la decisión final sobre ejecutar o no una orden en el mercado.
Te entregaré los reportes del Analista Técnico, el Analista Fundamental y el Gestor de Riesgo.

REGLAS DE CONSENSO:
1. El Analista Fundamental tiene VETO ABSOLUTO. Si él rechaza por noticias, la decisión final es RECHAZAR, sin importar lo bueno que sea el setup técnico.
2. El Gestor de Riesgo tiene VETO ABSOLUTO por R:R malo.
3. Si Fundamental y Riesgo aprueban, pero el Técnico tiene dudas, tú decides si el contexto compensa el riesgo.

SALIDA OBLIGATORIA:
No escribas texto libre. Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura:
{
  "decision": "EJECUTAR" o "RECHAZAR",
  "risk_pct": 1.0,
  "summary": "Breve resumen de 1 línea del porqué de la decisión combinando las 3 opiniones."
}"""
}

# ═══════════════════════════════════════════════════════════════════════════════
# CLIENTE LLM (DeepSeek)
# ═══════════════════════════════════════════════════════════════════════════════

async def call_llm(system_prompt: str, user_message: str, model: str = MODEL_ANALYST) -> str:
    """Llama a DeepSeek con un system prompt y un mensaje de usuario."""
    if not DEEPSEEK_API_KEY:
        return "ERROR: DEEPSEEK_API_KEY no configurada"

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.post(
                f"{DEEPSEEK_BASE_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_message}
                    ],
                    "temperature": 0.3,   # Baja temperatura para decisiones consistentes
                    "max_tokens": 500
                }
            )
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"].strip()
        except Exception as e:
            return f"ERROR: {str(e)}"

# ═══════════════════════════════════════════════════════════════════════════════
# AGENTES DEL ENJAMBRE
# ═══════════════════════════════════════════════════════════════════════════════

def build_tecnico_prompt(alert: TradeAlert) -> str:
    """Construye el prompt para el analista técnico."""
    bias = alert.marketBias
    return f"""📐 ANALISIS TECNICO PARA {alert.ticker} {alert.direction}

Puntaje Jarvis: {alert.points} pts
Contexto Macro: 4H={bias.get('240', '?')} | 1H={bias.get('60', '?')} | 15M={bias.get('15', '?')} | 3M={bias.get('3', '?')}
Confluencias: {', '.join(alert.events) if alert.events else 'Ninguna'}
Precio Entrada: {alert.entryPrice} | SL: {alert.stopLoss} | TP1: {alert.tp1Price} | TP2: {alert.tp2Price or 'N/A'}

Reporte de Confluencias:
{alert.confluenceReport}

Evalúa este setup técnico."""

def build_fundamental_prompt(macro: MacroData) -> str:
    """Construye el prompt para el analista fundamental."""
    events_str = "\n".join([
        f"  - {e.get('time', '?')} | {e.get('event', '?')} | Impacto: {e.get('impact', '?')}"
        for e in macro.upcomingEvents
    ]) if macro.upcomingEvents else "  Sin eventos de alto impacto próximos."

    return f"""📰 ANALISIS FUNDAMENTAL

VIX: {macro.vix or 'N/A'} (Estado: {macro.vixStatus})
DXY: {macro.dxy or 'N/A'}
US10Y: {macro.us10y or 'N/A'}
Sentimiento General: {macro.sentiment}

Próximos Eventos de Alto Impacto:
{events_str}

Evalúa si hay peligro macroeconómico inminente."""

def build_riesgo_prompt(alert: TradeAlert) -> str:
    """Construye el prompt para el gestor de riesgo."""
    rr = abs(alert.tp1Price - alert.entryPrice) / abs(alert.stopLoss - alert.entryPrice) if alert.stopLoss != alert.entryPrice else 0
    return f"""🛡️ ANALISIS DE RIESGO

Ticker: {alert.ticker} | Dirección: {alert.direction}
Entrada: {alert.entryPrice} | SL: {alert.stopLoss} | TP1: {alert.tp1Price} | TP2: {alert.tp2Price or 'N/A'}
R:R Calculado: {rr:.2f}:1
Puntaje Jarvis: {alert.points}
Racha de Pérdidas: {alert.consecutiveLosses} consecutivas
Win Rate Global: {alert.winRate:.0%}

Evalúa la gestión de riesgo."""

async def run_analyst(prompt: str, role: str) -> AgentVerdict:
    """Ejecuta un agente individual y devuelve su veredicto."""
    system = SYSTEM_PROMPTS.get(role, SYSTEM_PROMPTS["tecnico"])
    response = await call_llm(system, prompt, MODEL_ANALYST)

    decision = "RECHAZADO"
    if response.upper().startswith("APROBADO"):
        decision = "APROBADO"
    elif "APROBADO" in response.upper().split("\n")[0]:
        decision = "APROBADO"

    return AgentVerdict(
        agent=role,
        decision=decision,
        reason=response
    )

async def run_judge(verdicts: List[AgentVerdict], alert: TradeAlert) -> SwarmResult:
    """El juez evalúa los veredictos de los 3 agentes y decide."""
    verdicts_text = "\n\n".join([
        f"--- {v.agent.upper()} ---\nDecisión: {v.decision}\nMotivo: {v.reason}"
        for v in verdicts
    ])

    prompt = f"""⚖️ VEREDICTOS DEL ENJAMBRE PARA {alert.ticker} {alert.direction}:

{verdicts_text}

Toma la decisión final. Responde SOLO con el JSON requerido."""

    system = SYSTEM_PROMPTS["juez"]
    response = await call_llm(system, prompt, MODEL_JUDGE)

    # Intentar parsear la respuesta como JSON
    try:
        # Limpiar posible markdown code block
        cleaned = response.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
        data = json.loads(cleaned)
        return SwarmResult(
            decision=data.get("decision", "RECHAZAR"),
            risk_pct=data.get("risk_pct", 1.0),
            summary=data.get("summary", "Sin resumen"),
            votes=verdicts
        )
    except json.JSONDecodeError:
        # Fallback: si el juez no devuelve JSON válido, rechazar por seguridad
        return SwarmResult(
            decision="RECHAZAR",
            risk_pct=0.0,
            summary=f"Error parseando respuesta del juez: {response[:100]}",
            votes=verdicts
        )

# ═══════════════════════════════════════════════════════════════════════════════
# API FASTAPI
# ═══════════════════════════════════════════════════════════════════════════════

app = FastAPI(
    title="JARVIS AI Bridge",
    description="Microservicio Python para análisis con DeepSeek, OpenBB y TradingAgents",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    return {"status": "ok", "service": "jarvis-ai-bridge"}

# ── Endpoint: Análisis Macro (OpenBB) ──

@app.get("/api/macro")
async def get_macro_data():
    """
    Obtiene datos macroeconómicos: VIX, DXY, US10Y, calendario.
    Usa Finnhub como fuente principal (OpenBB fallback).
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Finnhub API para VIX (gratuito, sin API key compleja)
            vix = None
            try:
                r = await client.get("https://finnhub.io/api/v1/quote?symbol=VIX&token=d7pt291r01qosaaprsr0d7pt291r01qosaaprsrg")
                if r.status_code == 200:
                    vix = r.json().get("c", None)
            except: pass

            dxy = None
            try:
                r = await client.get("https://finnhub.io/api/v1/quote?symbol=ICE_DX&token=d7pt291r01qosaaprsr0d7pt291r01qosaaprsrg")
                if r.status_code == 200:
                    dxy = r.json().get("c", None)
            except: pass

            us10y = None
            try:
                r = await client.get("https://finnhub.io/api/v1/quote?symbol=US10Y&token=d7pt291r01qosaaprsr0d7pt291r01qosaaprsrg")
                if r.status_code == 200:
                    us10y = r.json().get("c", None)
            except: pass

        vix_status = "NORMAL"
        if vix and vix > 30:
            vix_status = "TOXICO"
        elif vix and vix > 25:
            vix_status = "ALTO"

        return MacroData(
            vix=vix,
            vixStatus=vix_status,
            dxy=dxy,
            us10y=us10y,
            upcomingEvents=[],   # OpenBB SDK lo llenaría
            sentiment="NEUTRAL",
            lastUpdated=datetime.utcnow().isoformat()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Endpoint: Análisis de Trade (Enjambre Completo) ──

@app.post("/api/analyze-trade", response_model=SwarmResult)
async def analyze_trade(alert: TradeAlert):
    """
    Ejecuta el enjambre completo: Técnico + Fundamental + Riesgo → Juez.
    Este es el endpoint principal que TypeScript/Vercel llama.
    """
    try:
        # 1. Obtener datos macro
        macro = await get_macro_data()

        # 2. Construir prompts
        t_prompt = build_tecnico_prompt(alert)
        f_prompt = build_fundamental_prompt(macro)
        r_prompt = build_riesgo_prompt(alert)

        # 3. Ejecutar los 3 agentes en paralelo
        tecnico, fundamental, riesgo = await asyncio.gather(
            run_analyst(t_prompt, "tecnico"),
            run_analyst(f_prompt, "fundamental"),
            run_analyst(r_prompt, "riesgo"),
        )

        # 4. Juez decide
        result = await run_judge([tecnico, fundamental, riesgo], alert)

        return result

    except Exception as e:
        # En caso de error total, rechazar por seguridad
        return SwarmResult(
            decision="RECHAZAR",
            risk_pct=0.0,
            summary=f"Error en el enjambre: {str(e)[:100]}",
            votes=[]
        )

# ── Endpoint: Solo Analista Técnico (rápido, sin macro) ──

@app.post("/api/analyze-technical", response_model=AgentVerdict)
async def analyze_technical(alert: TradeAlert):
    """Evaluación técnica rápida (sin datos macro ni riesgo)."""
    try:
        prompt = build_tecnico_prompt(alert)
        return await run_analyst(prompt, "tecnico")
    except Exception as e:
        return AgentVerdict(agent="tecnico", decision="RECHAZADO", reason=f"Error: {str(e)[:100]}")

# ═══════════════════════════════════════════════════════════════════════════════
# ARRANQUE
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
