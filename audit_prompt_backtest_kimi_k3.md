# Auditoría del backtesting de JARVIS — frontend (jarvis-os) + backend + hyperopt + pipeline de datos

Eres un ingeniero senior de trading algorítmico y auditor de sistemas. Vas a auditar **exclusivamente el sistema de backtesting** de JARVIS: el frontend React (`jarvis-os`), el backend (motor de backtest + API Kronos + hyperopt), y el pipeline de datos (CSVs). **No quiero un informe descriptivo: quiero hallazgos accionables con la solución lista para ejecutarla** (diff exacto, cambio de config, o comando de verificación).

Responde en español técnico. Cada hallazgo debe apuntar a `archivo:línea` y explicar la causa raíz, no solo el síntoma. Separar claramente **errores/bugs** de **mejoras** (features, calidad de métricas, UX, robustez).

---

## 0. Cómo acceder al código

- Repositorio en el VPS: `/opt/JARVIS/` (backend Node/TS en `src/`, frontend React/Vite en `jarvis-os/`).
- GitHub: `https://github.com/boninoagustin/JARVIS.git`.
- Si tenés shell, `cd /opt/JARVIS` y leé los archivos directamente.

## 1. Contexto: qué es el backtesting de JARVIS

El bot JARVIS (estrategia SMC/ICT en TypeScript) tiene un **dashboard React/Vite** (`jarvis-os`) con un panel de backtesting. El backtest NO se corre en el navegador: el panel manda requests HTTP a una API **Kronos** (FastAPI `:8000`), que ejecuta el **motor real** (`backtestEngine.ts`) server-side sobre CSVs de eventos SMC, y devuelve métricas + trades.

Arquitectura:
```
BacktestingPanel.tsx (React) → useBacktestApi.ts (hook) → Kronos (:8000, FastAPI)
   → subprocess `npx tsx jarvis-os/scripts/backtest_server.ts` → runBacktest() del MOTOR REAL
   → JSON {metrics, trades} → el panel calcula métricas avanzadas y renderiza
```

Hay además:
- **Auto-Tune Global**: algoritmo genético (`optimizer.ts`) vía `backtest_optimize_server.ts`, que optimiza parámetros de trigger+gestión sobre el motor real.
- **Hyperopt Bayesiano** (Optuna, Python): `scripts/hyperopt/hyperopt_server.py` + `jarvis_hyperopt_worker.ts` (JSON-RPC stdin/stdout). Optimiza 14 params (SMC + trade) y escribe `optimized_preset_<TICKER>_hyperopt.json`.
- **Pipeline de datos**: `scripts/fetch_history.ts` descarga velas OHLCV de cTrader → `logs/{ticker}/history/history_<TF>.csv`; `scripts/export_smc_csv.ts` corre el SMCEngine sobre esas velas y genera los CSVs de eventos `logs/{ticker}/history_exported/pine-logs-SMC Master_<TF>.csv` que consume el backtest.
- El bot escanea 10 activos: AUDCAD, BTCUSD, EURUSD, GBPUSD, NZDUSD, US500, USDCAD, USDJPY, USOIL, XAUUSD.

Stack: Node v24 (ESM, `tsx`), PM2 (`JARVIS` bot, `KRONOS_API` FastAPI :8000, `JARVIS_OS` Vite :5173), Firestore para `asset_configs/{ticker}`.

## 2. Mapa de archivos (foco de la auditoría)

**Frontend (jarvis-os):**
- `jarvis-os/src/components/BacktestingPanel.tsx` — UI del panel (~3000 líneas): config, simular, auto-tune, exportar a JARVIS, métricas, gráficos.
- `jarvis-os/src/features/backtesting/store.ts` — estado (Zustand) del panel.
- `jarvis-os/src/features/backtesting/hooks/useBacktestApi.ts` — hook HTTP → Kronos (reemplazó a los Web Workers).
- `jarvis-os/src/features/backtesting/*` — componentes/helpers auxiliares (métricas avanzadas, filtros, gráficos).

**Backend (motor + API):**
- `jarvis-os/src/services/backtestEngine.ts` — **motor canónico** (`runBacktest`, `prepareEntries`, lógica de SL/TP/ROI/trailing/killswitch).
- `jarvis-os/src/services/backtestTypes.ts` — tipos `BacktestConfig`, `BacktestTrade`, `SessionConfig`.
- `jarvis-os/src/services/optimizer.ts` — Auto-Tune (algoritmo genético, perfiles ROI).
- `jarvis-os/src/engine/AlphaModel.ts` y `FrictionModel.ts` — **re-exports** de una sola línea hacia `src/engine/AlphaModel.ts` / `FrictionModel.ts` (núcleo compartido con el vivo).
- `jarvis-os/scripts/backtest_server.ts` — entrypoint server-side (Kronos) que carga CSVs y corre el motor real.
- `jarvis-os/scripts/backtest_optimize_server.ts` — entrypoint del Auto-Tune.
- `kronos_api/main.py` — FastAPI (endpoints `/api/backtest/*`), CORS, cache, subprocess.

**Hyperopt (Python + worker TS):**
- `scripts/hyperopt/hyperopt_server.py` — Optuna TPE, SQLite, RPC hacia el worker.
- `scripts/hyperopt/jarvis_hyperopt_worker.ts` — worker TS (JSON-RPC stdin/stdout) que corre `runBacktest`.
- `scripts/hyperopt/run_hyperopt.py` — CLI.
- `scripts/hyperopt/metrics.py` — métricas en Python (deben coincidir con las del worker).
- `scripts/hyperopt/load_best_params.py` — carga del mejor trial.

**Pipeline de datos:**
- `scripts/export_smc_csv.ts` — genera los CSVs de eventos desde las velas OHLCV (corre el SMCEngine).
- `scripts/fetch_history.ts` — descarga velas OHLCV de cTrader (chunks de 30 días).

## 3. Objetivos de la auditoría (en orden de prioridad)

### OBJETIVO 1 — Frontend: bugs, UX y flujo del panel
Auditá `BacktestingPanel.tsx` + `store.ts` + `useBacktestApi.ts`:
- **Flujo end-to-end**: ¿cada botón hace lo que su etiqueta dice? (Simular, Auto-Tune, Exportar a JARVIS, descarga de CSV, Monte Carlo, ML badge). ¿Hay estados que se pisan o sliders que se resetean?
- **Cálculo de métricas avanzadas** (`calculateAdvancedMetrics` o similar): ¿Sharpe, MaxDD, profit factor, expectancy están bien calculados? ¿Divisiones por cero con 0 trades, NaN con configs parciales?
- **Crash/whitescreen**: `new Date(t.timestamp)` con timestamp faltante, `result.processedEvents.toLocaleString()` con campo faltante, `files` que vienen como objetos vs strings.
- **Config**: ¿el panel arma el `BacktestConfig` COMPLETO (sessions, sessionFilter, tfs) o un subconjunto que produce 0 trades o NaN? ¿`minBuyPoints`/`minSellPoints` default correcto?
- **Exportar a JARVIS** (`handlePushToBot`): ¿escribe a `asset_configs/{ticker}` TODOS los campos que el bot vivo consume (minimal_roi, slAfterTp1, trails, sessions, riderEnabled/riderTf) o se pierden campos?
- **Auto-Tune**: ¿aplica el resultado (`best`) a los sliders correctos, o "corre" y no hace nada? ¿shape de respuesta correcto?

### OBJETIVO 2 — Backend: correctitud del motor y la API
Auditá `backtestEngine.ts` + `backtest_server.ts` + `kronos_api/main.py`:
- **Look-ahead bias**: ¿el motor usa información futura? (ej. usar el close de la vela actual para decidir la entrada en esa misma vela; ordenar/hoistear zonas; usar `state.lastPrice` que aún no estaba disponible).
- **Orden intra-barra**: en una misma vela, ¿qué se evalúa primero, SL o TP? ¿Es conservador o asume TP1 primero (optimista)?
- **Gestión de trades**: ROI time-decay, TP1/TP2, partial close, SL→breakeven, trailing (ATR/estructural), RIDER. ¿Unidades correctas (porcentaje vs decimal), edge cases (SL=0, riesgo 0)?
- **Gates del vivo replicados**: ¿cuáles faltan todavía en el motor (killswitch global/por-activo, límites diarios `maxDailyLossR`/`maxTradesPerDay`, cooldown de sniper, filtro ML)? El motor ya replica el streak-killswitch (5 pérdidas→30min); verificá qué más falta.
- **Config passing**: ¿Kronos pasa el `config_json` completo sin corromperlo (URL-encoding, query param, merge con defaults)? ¿El cache de tsx/esbuild sirve una versión stale?
- **Fricción**: ¿`evaluateNetTrade` aplica spread+comisión+slippage consistentes con el vivo? ¿El default por clase de activo (FOREX/CRYPTO/METALES/ÍNDICES) se aplica bien?

### OBJETIVO 3 — Hyperopt: objetivo, protocolo y overfitting
Auditá `scripts/hyperopt/*` + `optimizer.ts`:
- **Función objetivo**: ¿`objectiveFunction` (PF − 2·MaxDD − penalización de trades + 0.1·expectancy) es sensible? ¿Penaliza mal? ¿Puede elegir configs con pocos trades o overfit al ruido?
- **Overfitting / validación**: ¿hay split train/test u out-of-sample, o el hyperopt optimiza sobre TODOS los datos y reporta PF in-sample (optimista)? ¿Walk-forward? ¿Monte Carlo de validación?
- **Protocolo RPC del worker**: errores, timeouts, manejo de `0 trades`, consistencia de métricas entre `metrics.py` (Python) y el worker (TS).
- **Persistencia**: ¿el estudio en `jarvis_hyperopt_study.db` se reutiliza entre runs (resume trials viejos de un motor distinto)? ¿Nombres de estudio?
- **Config del worker**: ¿arma el `BacktestConfig` con `sessions` correctas (no un flat param object)? ¿Carga M5 además de M15/H1/H4/D1?

### OBJETIVO 4 — Pipeline de datos: fidelidad y frescura
Auditá `export_smc_csv.ts` + `fetch_history.ts`:
- **Fidelidad de eventos**: ¿`export_smc_csv.ts` emite los mismos eventos (SYNC_ZONES con campos `d/p/b/sc`, EVENTO_CHOCH/BOS, divergencias) que el bot vivo ve en tiempo real? ¿Hay estructuras que el export no genera (o genera de más)?
- **Frescura**: ¿los CSVs de `logs/{ticker}/history_exported/` están frescos o desactualizados? ¿Hay un mecanismo para refrescarlos automáticamente o es manual?
- **Descarga** (`fetch_history.ts`): ¿chunks de 30 días respetan los límites de cTrader? ¿Dedupe/sort por timestamp correcto? ¿Faltan velas (gaps)? ¿Rate limiting?
- **Formato**: ¿el CSV de salida (`Fecha,Mensaje`) matchea lo que `backtest_server.ts` y el worker esperan parsear?

### OBJETIVO 5 — Mejoras (no bugs, pero valiosas)
Proponé mejoras concretas priorizadas, por ejemplo:
- Validación out-of-sample / walk-forward para el hyperopt (hoy es in-sample).
- Métricas adicionales (Calmar, Sortino, exposición, % de meses positivos) o corrección de las existentes.
- Caché de CSVs / invalidation, o un cron para refrescar velas+CSVs automáticamente.
- UX del panel (indicadores de progreso, mensajes de error accionables, validación de inputs).
- Robustez del motor (tests unitarios para la matemática de fricción/R:R/ROI).

---

## 4. Cambios recientes YA aplicados (no repetir, salvo que verifiques una regresión)

Todos estos ya fueron corregidos en el código actual. **No los reportes de nuevo** a menos que detectes que el fix está mal o incompleto:
- **ROI unidades**: `backtestEngine.ts` compara `pnlPct >= effectiveROI * 100` (antes comparaba porcentaje contra decimal → cerraba a +0.01%).
- **SL con piso**: el backtest usa `calculateDynamicSlBuffer` + piso `getMinPipDistance` (≥10 pips forex, $50 BTC, $1 oro, 5 pts índices), igual que el vivo.
- **Fricción realista**: al inicio de `runBacktest` se normaliza `spreadPips===0`/`commissionPerLot===0` → `undefined` → cae en `defaultFrictionConfig` por clase de activo (antes 0 pisaba los defaults reales).
- **Streak-killswitch replicado**: campo `streakKillswitchUntil` en `DailyStats` (5 pérdidas → 30 min de bloqueo).
- **Anti-martingale eliminado**: `riskMult` ahora es 1.0 fijo (antes 0.5×/0.25× tras pérdidas suavizaba drawdowns que el vivo no tiene).
- **AlphaModel único**: `jarvis-os/src/engine/AlphaModel.ts` es `export * from '../../../src/engine/AlphaModel'` (fin de la copia divergente).
- **Defaults del panel alineados**: `defTrig` con `slAfterTp1:'midpoint'` y trails ON (antes 'none'/OFF).
- **Worker del hyperopt**: ahora llama `prepareEntries()` (antes llamaba `runBacktest` sin `prepared` → 0 trades), carga M5, y usa cola asíncrona.
- **Presets re-hyperopteados y promovidos**: `optimized_preset_<TICKER>.json` regenerados con el motor corregido.

## 5. Divergencias CONOCIDAS (aceptadas por ahora — no las reportes como hallazgo nuevo)

- **VIX killswitch**: el vivo usa VIX>30 (Finnhub) vs el backtest usa `isNewsBlackout` (ventanas horarias fijas). Es una divergencia conocida, no replicable sin serie VIX histórica.
- **Filtro ML ausente en backtest**: el motor de backtest no carga modelos ML (`isMLActive()=false`), así que no rechaza señales por ML; el vivo sí. El backtest sobrestima cantidad de trades frente al vivo. Es conocido.
- **Intra-barra SL gana a TP**: aceptado como conservador.

---

## 6. Formato de salida obligatorio

Estructurá la respuesta en 5 secciones (una por objetivo). Dentro de cada sección, listá hallazgos así:

```
[🔴 Crítico | 🟠 Alto | 🟡 Moderado | 💡 Mejora] — `archivo.ts:línea` — `función/nombre`
**Problema**: <causa raíz, 2-3 líneas>
**Impacto**: <qué rompe en el backtest / en la UI / en la decisión del operador>
**Solución**: <diff exacto o cambio de config listo para ejecutar>
**Verificación**: <comando o pasos para confirmar que quedó resuelto>
```

Al final, una **sección ejecutiva** con:
1. Los 3-5 cambios de mayor impacto ordenados por prioridad (con el "quick win" primero).
2. Un veredicto de una línea por objetivo.
3. Lista de archivos a tocar y en qué orden, con diff aproximado (N archivos, ~M líneas) para que aprobemos antes de ejecutar.

Regla dura: **toda solución debe ser ejecutable sin ambigüedad** — si proponés código, da el diff exacto; si config, el JSON exacto. No dejes "deberías revisar X" sin el cómo.
