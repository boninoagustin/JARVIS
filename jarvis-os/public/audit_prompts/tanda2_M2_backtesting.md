# Auditoría JARVIS — Tanda 2/5 · M2: Backtesting (motor + Kronos + Hyperopt)

**Alcance**: `jarvis-os/src/services/` (motor de backtest), `jarvis-os/scripts/`, `kronos_api/`, `scripts/hyperopt/` — ~80.000 tokens (18 archivos).
**Pregunta central**: ¿el backtest es representativo de cómo opera el bot en vivo, o engaña al operador?
**Modelo recomendado**: DeepSeek V4-Pro (o cualquier modelo con ≥128k de contexto).

---

## 0. Cómo acceder al código

- Repo en el VPS: `/opt/JARVIS/` — si tenés shell, leé los archivos directamente.
- GitHub: `https://github.com/boninoagustin/JARVIS.git`.
- Si no tenés shell: te adjunto los archivos de la lista (§2) con este prompt.

## 1. Contexto del sistema

El bot JARVIS (SMC/ICT en TypeScript) tiene un dashboard React/Vite (`jarvis-os`) con panel de backtesting. El backtest NO corre en el navegador: el panel manda requests HTTP a la API **Kronos** (FastAPI `:8000`), que ejecuta el **motor real** (`backtestEngine.ts`) server-side sobre CSVs de eventos SMC, y devuelve métricas + trades.

```
BacktestingPanel.tsx → useBacktestApi.ts → Kronos (:8000, FastAPI)
   → subprocess `npx tsx jarvis-os/scripts/backtest_server.ts` → runBacktest() del MOTOR REAL
   → JSON {metrics, trades} → el panel calcula métricas avanzadas y renderiza
```

También hay:
- **Auto-Tune Global**: algoritmo genético (`optimizer.ts`) vía `backtest_optimize_server.ts`, optimiza trigger+gestión sobre el motor real.
- **Hyperopt Bayesiano** (Optuna, Python): `scripts/hyperopt/` — optimiza 14 params (SMC + trade) y escribe `optimized_preset_<TICKER>_hyperopt.json`.
- **Pipeline de datos**: `scripts/fetch_history.ts` (velas OHLCV de cTrader → `logs/{ticker}/history/`), `scripts/export_smc_csv.ts` (corre el SMCEngine → CSVs de eventos que consume el backtest).

Stack: Node v24 (ESM, `tsx`), PM2 (`JARVIS`, `KRONOS_API`, `JARVIS_OS`), Firestore para `asset_configs/{ticker}`.

## 2. Archivos de esta tanda

**Motor y API (backend):**
- `jarvis-os/src/services/backtestEngine.ts` (~28k — **motor canónico**: `runBacktest`, `prepareEntries`, SL/TP/ROI/trailing/killswitch).
- `jarvis-os/src/services/backtestTypes.ts` — tipos `BacktestConfig`, `BacktestTrade`, `SessionConfig`.
- `jarvis-os/src/services/optimizer.ts` — Auto-Tune (genético, perfiles ROI).
- `jarvis-os/scripts/backtest_server.ts` — entrypoint server-side (Kronos) que carga CSVs y corre el motor.
- `jarvis-os/scripts/backtest_optimize_server.ts` — entrypoint del Auto-Tune.
- `jarvis-os/src/engine/AlphaModel.ts`, `FrictionModel.ts`, `Types.ts` — **re-exports de una línea** hacia `src/engine/` (núcleo compartido con el vivo; NO son copias).
- `kronos_api/main.py` — FastAPI: endpoints `/api/backtest/*`, CORS, cache, subprocess.

**Hyperopt (Python + worker TS):**
- `scripts/hyperopt/hyperopt_server.py` — Optuna TPE, SQLite, RPC al worker.
- `scripts/hyperopt/jarvis_hyperopt_worker.ts` — worker TS (JSON-RPC stdin/stdout) que corre `runBacktest`.
- `scripts/hyperopt/run_hyperopt.py` — CLI.
- `scripts/hyperopt/metrics.py` — métricas en Python (deben coincidir con las del worker).
- `scripts/hyperopt/load_best_params.py` — carga del mejor trial.
- `scripts/hyperopt/collect_triggers.ts`.

## 3. Objetivos (por prioridad)

### OBJETIVO 1 — ¿El backtest es representativo del vivo?
No des por sentado que "usa el mismo motor" = "mismos resultados". Verificá:
1. **Look-ahead bias**: ¿el motor usa información futura? (close de la vela actual para decidir entrada en esa misma vela, zonas hoisted, `state.lastPrice` no disponible aún).
2. **Orden intra-barra**: en una misma vela, ¿qué se evalúa primero, SL o TP? ¿Asume un orden optimista?
3. **Gates del vivo replicados**: ¿cuáles faltan en el motor? (killswitch global/por-activo, límites diarios `maxDailyLossR`/`maxTradesPerDay`, cooldown de sniper, filtro ML, filtro LLM, `sessionEnabled`, entrada SMART directa vs OTE). Cada gate faltante = backtest sobrestima trades y PnL.
4. **Costos**: ¿el panel aplica el mismo spread/comisión/slippage que el vivo? ¿Se aplican los defaults por clase de activo (FOREX/CRYPTO/METALES/ÍNDICES)?
5. **Config**: ¿el config que recibe el backtest es el MISMO que `getConfigForTicker` le da al vivo, o el panel usa defaults propios que divergen?
6. **Fidelidad de datos**: ¿`export_smc_csv.ts` emite los mismos eventos que el vivo ve en tiempo real? ¿Los CSVs están frescos o desactualizados?

Concluí con **veredicto explícito**: ¿aproximación razonable o engaña al operador? + corrección mínima por brecha.

### OBJETIVO 2 — Correctitud del motor (`backtestEngine.ts`)
- Gestión de trades: ROI time-decay, TP1/TP2, partial close, SL→breakeven, trailing (ATR/estructural), RIDER. Unidades correctas (% vs decimal), edge cases (SL=0, riesgo 0).
- Config passing por Kronos: ¿`config_json` completo sin corromper (URL-encoding, merge con defaults)? ¿Cache de tsx/esbuild sirve versión stale?

### OBJETIVO 3 — Hyperopt: objetivo, protocolo y overfitting
- **Función objetivo**: ¿`PF − 2·MaxDD − penalización trades + 0.1·expectancy` es sensible? ¿Puede elegir configs con pocos trades u overfit al ruido?
- **Overfitting / validación**: ¿hay split train/test u out-of-sample, o optimiza sobre TODOS los datos y reporta in-sample (optimista)? ¿Walk-forward? ¿Monte Carlo?
- **Protocolo RPC del worker**: errores, timeouts, `0 trades`, consistencia de métricas entre `metrics.py` y el worker TS.
- **Persistencia**: ¿el estudio SQLite se reutiliza entre runs (resume trials viejos de un motor distinto)?

## 4. Lo que NO debés reportar (ya corregido — solo si verificás una REGRESIÓN)

- ROI unidades: `pnlPct >= effectiveROI * 100` (antes cerraba a +0.01%).
- SL con piso: `calculateDynamicSlBuffer` + `getMinPipDistance` (≥10 pips forex, $50 BTC, $1 oro, 5 pts índices).
- Fricción realista: `spreadPips===0`/`commissionPerLot===0` → `undefined` → defaults por clase.
- Streak-killswitch replicado (5 pérdidas → 30 min).
- Anti-martingale eliminado (`riskMult` = 1.0 fijo).
- AlphaModel único (re-export, sin copia divergente).
- Defaults del panel alineados (`slAfterTp1:'midpoint'`, trails ON).
- Worker del hyperopt llama `prepareEntries()`, carga M5, cola asíncrona.

**Divergencias conocidas y aceptadas** (no son hallazgos nuevos): VIX killswitch (vivo usa Finnhub vs backtest `isNewsBlackout`); filtro ML ausente en backtest (sobrestima trades); intra-barra SL gana a TP (conservador).

## 5. Formato de salida obligatorio

```
[🔴 Crítico | 🟠 Alto | 🟡 Moderado | 💡 Mejora] — `archivo.ts:línea` — `función/nombre`
**Problema**: ...
**Impacto**: <qué rompe en el backtest / UI / decisión del operador>
**Solución**: <diff exacto>
**Verificación**: <comando/pasos>
```

Al final:
1. Sección ejecutiva: cambios de mayor impacto (quick win primero) + veredicto de una línea por objetivo.
2. **RESUMEN PARA CONSOLIDACIÓN**: tabla `severidad | archivo:línea | descripción en una línea`.

**Regla dura**: toda solución ejecutable sin ambigüedad.