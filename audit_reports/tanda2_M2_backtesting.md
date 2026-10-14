# Auditoría JARVIS — Tanda 2/5 · M2 Backtesting (motor + Kronos + Hyperopt)

**08-oct-2026**. Consolidación de dos subagentes (ambos completos) + verificación en código de los 🔴. Informes crudos: `/root/audit_t2/engine.md` y `/root/audit_t2/hyperopt.md`.

## Cobertura
| Obj | Estado |
|---|---|
| 1 · Representatividad backtest vs vivo | ✅ completo, veredicto abajo |
| 2 · Correctitud del motor + config passing | ✅ completo |
| 3 · Hyperopt (objetivo, overfitting, RPC, persistencia) | ✅ completo, veredicto abajo |

## Veredicto de representatividad
**"Aproximación razonable con una brecha de optimización engañosa."** El núcleo del motor (entradas, gestión, costos, look-ahead) es fiel al vivo — no hay look-ahead, `export_smc_csv.ts` emite velas completas con TS de cierre (confirma el H1 de la T1: el backtest está bien, el vivo es el roto), el ATR14 es idéntico, los gates de riesgo replicados. Lo que engaña es la **capa de optimización**: el hyperopt sintoniza `zoneWeights`/`vwapPts` que el vivo ignora, y el gen `minimal_roi` del Auto-Tune está muerto. Además el hyperopt sobreajusta (abajo).

## Veredicto del hyperopt
**Está sobreajustando.** 34 parámetros sobre ~40 trades, split 70/30 único con objetivo solo in-sample, expectancy dominante y sin cota; y 28/34 params optimizados jamás llegan a producción.

---

## Hallazgos

### [🟠 Alto] — `hyperopt_server.py:93,120-123,232-236` + `load_best_params.py:62-74` + `trading.ts:747-778,865-901` — `zoneWeights`/`vwapPts`: optimizados y aplicados en el backtest, **ignorados por el vivo**
**Problema**: el hyperopt optimiza `vwapPts` (2..6) y 24 pesos `zw_{fam}_{sess}`, los inyecta en el config del backtest (que SÍ los aplica: `backtestEngine.ts:430,1275`), pero (a) `load_best_params.py` **no los persiste** (solo escribe `Risk`+`Scoring`) y (b) el vivo nunca los recibe porque el listener `asset_configs→assetSessionConfigs` y `getConfigForTicker` no los propagan (ya reportado como H3 en la T1). El comentario "paridad exacta" es falso: el óptimo reportado nunca se transfiere a producción.
**Impacto**: doble pérdida — el presupuesto de optimización se gasta en genes que no se despliegan, y el scoring vivo difiere del que el optimizador validó (VWAP vale 2 en vivo vs 4-6 optimizado).
**Solución** (dos frentes): (1) en `load_best_params.py`, persistir también `vwapPts`, `zoneWeights`, `tp1StructuralMinRR`, `minimal_roi`, `minScoreToOverrideReject` en el preset; (2) en el vivo, propagar `zoneWeights`/`vwapPts` por el listener y `getConfigForTicker` (diff exacto ya en `tanda1_M1_complemento.md`).
**Verificación**: `grep -n "zoneWeights\|vwapPts" scripts/hyperopt/load_best_params.py` → hoy 0; tras el fix >0, y `getConfigForTicker('EUROPE50').vwapPts` devuelve el valor del preset.

### [🟡 Moderado] — `backtest_optimize_server.ts:113,190` vs `backtestEngine.ts:604` — gen `minimal_roi` del Auto-Tune muerto
**Problema**: el GA optimiza `minimal_roi` y lo escribe **por gatillo** (`sessions[key][triggerKey].minimal_roi`), pero el motor lo lee **solo a nivel raíz** (`config.minimal_roi`). Los 3 perfiles ROI producen fitness idéntico.
**Impacto**: una dimensión entera del GA es decorativa; el "perfil ROI óptimo" es arbitrario.
**Solución**: escribir/leer `minimal_roi` a nivel raíz (o leer el por-gatillo en el motor).
**Verificación**: `grep -n "minimal_roi" backtest_optimize_server.ts backtestEngine.ts` → mismas key path en escritura y lectura.

### [🟡 Moderado] — `backtestEngine.ts:420-424` vs `PortfolioModel.ts:42-59` — frontera de día FX divergente
**Problema**: el backtest ancla el día en UTC-3 fijo (20:00 UTC); el vivo usa `getFxDayStartMs` (17:00 NY, DST-aware → 21/22 UTC). El reset de `maxDailyLossR`/`maxTradesPerDay`/`dailyBuys/Sells`/`pnlR` rota 1-2 h antes en backtest.
**Impacto**: los límites diarios se aplican con una ventana corrida — trades cerca del corte caen en días distintos a los del vivo.
**Solución**: importar `getFxDayStartMs` desde `src/engine/PortfolioModel.js` (re-export) en el backtest.
**Verificación**: `grep -n "20 \* 60\|getFxDayStartMs\|UTC-3\|-3 \* 3600" backtestEngine.ts`.

### [🟡 Moderado] — `backtestEngine.ts:322,630,…` — JPY con `usdjpyRate=154` hardcodeado
**Problema**: `pipValuePerLotUsd` se llama sin `usdjpyRate` → los pares JPY usan USDJPY=154 fijo; el vivo mide `lastBidAsk('USDJPY')`. Merma de R diverge ~7-10 % solo en JPY.
**Solución**: pasar `usdjpyRate` (del estado o del CSV del USDJPY) igual que el vivo.
**Verificación**: `grep -n "pipValuePerLotUsd\|154" backtestEngine.ts`.

### [🟡 Moderado] — `backtestEngine.ts:1205` vs `trading.ts:2806,3620,4175` — `sessionEnabled` no chequeado en el path principal
**Problema**: el motor solo gatea `sessionEnabled` en la re-validación tardía; el disparo CHoCH/BOS directo y `createTrade` lo ignoran. El vivo bloquea `!sessionEnabled` en todos los paths.
**Impacto**: el backtest opera activos deshabilitados → sobrestima trades/PnL de activos que en vivo están apagados.
**Solución**: chequear `sessionEnabled` en `createTrade` (top, como el vivo).
**Verificación**: `grep -n "sessionEnabled" backtestEngine.ts` → presente en todos los puntos de ejecución.

### 💡 Mejoras
- `backtestEngine.ts:1250` — cooldown sniper hardcodeado 180 s (ignora `config.sniperCooldownMs`).
- `useBacktestApi.ts:25,39` — `config_json` por URL query (encoding OK, pero sujeto a límite de URL/proxy; riesgo de truncamiento al crecer el config).

---

## Hyperopt (Objetivo 3)

### [🔴 Crítico] — `metrics.py:160-164` vs `jarvis_hyperopt_worker.ts:212` — objetivo divergente; `metrics.py` es código muerto
**Problema**: `metrics.py` documenta `PF − 2·DD − 0.5·dev + 0.1·expectancy` (nunca importado por el worker); el worker TS usa `0.5·PF − 0.5·DD − 0.25·dev + 1.0·expectancy`. Reconstruido numéricamente: XAUUSD python=1.57 vs TS=3.69 (el valor en la DB es el del TS).
**Impacto**: el objetivo que reporta la documentación y el que realmente ordena los trials son distintos, con peso de expectancy 10× mayor en el TS.
**Solución**: unificar — hacer que el worker importe la fórmula real o copiarla fiel; marcar `metrics.py` como referencia o eliminarlo para no inducir error.
**Verificación**: correr ambos con las mismas métricas → mismo score (hoy difieren).

### [🔴 Crítico] — `jarvis_hyperopt_worker.ts:212` — `1.0·expectancy` no acotada domina el score
**Problema**: el término `1.0·expectancy` no está acotado (a diferencia del PF que se capea a 5). Caso sintético: 38 trades con exp 2.0 → score 3.55 vs 200 trades con exp 0.4 → 1.15. El "sample penalty" es inefectivo (0.21 a n=30).
**Impacto**: el TPE prefiere configs con pocos trades y expectancy alta (ruido), no configs robustas.
**Solución**: acotar expectancy (`min(expectancy, 0.5)` o cap similar) y/o endurecer el penalty de muestra.
**Verificación**: `grep -n "1.0 \* m.expectancy\|expectancy" jarvis_hyperopt_worker.ts`.

### [🔴 Crítico] — `hyperopt_server.py:83-123` + `run_hyperopt.py` — overfitting: 34 dims sobre ~40 trades, split único in-sample
**Problema**: el espacio tiene **34** parámetros (no 14 como dice el prompt), la muestra es de 38-51 trades, y hay un único split 70/30 con el objetivo calculado **solo in-sample**; el OOS es informativo. Ej. real: EURUSD_weekly12 in-sample PF=5.01 → **OOS 0/6 losses (PF=0)**.
**Impacto**: el "mejor" trial reportado es in-sample; el despliegue de esos presets no se sostiene fuera de muestra.
**Solución**: optimizar sobre el OOS (o un walk-forward), reducir la dimensionalidad (fijar o agrupar zw_*), y exigir `min_trades` más alto.
**Verificación**: `grep -n "suggest_\|zw_\|objective\|oos" hyperopt_server.py` → 34 suggest + objetivo in-sample.

### [🟠 Alto] — `load_best_params.py:62-74` — descarta 28/34 params optimizados
**Problema**: solo persiste `Risk`(4) + `Scoring`(2); caen `zoneWeights`(24), `vwapPts`, `tp1StructuralMinRR`, `minimal_roi`, `minScoreToOverrideReject`. Y el `Scoring` que escribe tampoco lo lee el vivo.
**Impacto**: lo que se optimiza no es lo que se despliega; el presupuesto de 34 dims se tira a la basura.
**Solución**: persistir los 34 (o al menos los que el motor/vivo consume de verdad).
**Verificación**: `grep -n "Risk\|Scoring\|zoneWeights\|vwapPts" load_best_params.py`.

### [🟠 Alto] — `hyperopt_server.py:108-109` — `minScoreToOverrideReject` con valores inalcanzables sorteado sobre ruido
**Problema**: el espacio incluye 15/20/25, pero los scores reales no pasan de ~13.5 → esas ramas son equivalentes y se ordenan por ruido. Y el comentario dice que este param "no tiene efecto" sin el cache de TimesFM.
**Solución**: acotar a [6..12] o desactivar la dimensión hasta activar el gate TimesFM real.
**Verificación**: `grep -n "minScoreToOverrideReject" hyperopt_server.py`.

### 🟡 Persistencia y protocolo
- `hyperopt_server.py` `load_if_exists=True` + `study_name` manual sin fingerprint del motor → riesgo de reanudar trials de un motor distinto (stale).
- `jarvis_hyperopt_worker.ts` devuelve `-100.0` tanto para error como para 0 trades → el TPE no distingue; debería devolver `None`/`fail` para el error.
- 💡 el "PF honesto" (`min(pf,5)*min(1,grossLoss/5)`) aniquila el PF de configs con 0 pérdidas sin documentarlo.

---

## Sección ejecutiva (quick win primero)
1. **Unificar y acotar el objetivo del hyperopt** (🔴): una sola fórmula en el worker, `expectancy` acotada, y optimizar sobre OOS (o walk-forward). Sin esto, cada corrida semanal elige sobre ruido in-sample.
2. **`load_best_params.py` que persista los 34 params** + **propagar `zoneWeights`/`vwapPts` al vivo** (el fix de T1). Cierra la brecha "optimizado pero no desplegado".
3. **Portar `getFxDayStartMs` al backtest** (frontera de día FX) y **`sessionEnabled` en el path principal del motor** — dos paridades chicas de alto valor.
4. **Matar el gen `minimal_roi` del GA** (o alinearlo a la key que lee el motor).
5. JPY con `usdjpy` real en vez de 154 (merma de R correcta en JPY).

## RESUMEN PARA CONSOLIDACIÓN
| severidad | archivo:línea | descripción |
|---|---|---|
| 🔴 | `metrics.py:160-164` vs `jarvis_hyperopt_worker.ts:212` | Objetivo divergente; metrics.py muerto, el TS manda (peso expectancy 10×) |
| 🔴 | `jarvis_hyperopt_worker.ts:212` | `1.0·expectancy` sin cota domina → prefiere pocos trades/exp alta |
| 🔴 | `hyperopt_server.py:83-123` | 34 dims sobre ~40 trades, split único in-sample (EURUSD weekly12 OOS PF=0) |
| 🟠 | `load_best_params.py:62-74` | Persiste solo 6/34 params; caen zoneWeights/vwapPts/tp1StructuralMinRR/minimal_roi/minScoreToOverrideReject |
| 🟠 | `hyperopt_server.py:108-109` | `minScoreToOverrideReject` con 15/20/25 inalcanzables, sorteado sobre ruido |
| 🟠 | `hyperopt_server.py:93` + `trading.ts:747-778` | zoneWeights/vwapPts optimizados en backtest, ignorados por el vivo |
| 🟡 | `backtest_optimize_server.ts:113` vs `backtestEngine.ts:604` | gen minimal_roi del GA por-gatillo vs lectura raíz → muerto |
| 🟡 | `backtestEngine.ts:420-424` | Frontera de día FX UTC-3 fijo vs NY 17:00 DST |
| 🟡 | `backtestEngine.ts:322,630` | JPY usdjpy=154 hardcodeado vs vivo medido |
| 🟡 | `backtestEngine.ts:1205` | sessionEnabled no chequeado en el path principal |
| 🟡 | `hyperopt_server.py` load_if_exists | Study reutilizado sin fingerprint de motor → trials stale |
| 🟡 | `jarvis_hyperopt_worker.ts` | Error y 0-trades comparten score −100.0 (indistinguibles) |
| 💡 | `backtestEngine.ts:1250` | Cooldown sniper hardcodeado 180 s |
| 💡 | `useBacktestApi.ts:25,39` | config_json por URL query (límite/exposición) |
| 💡 | `jarvis_hyperopt_worker.ts:196` | "PF honesto" aniquila configs con 0 pérdidas sin documentar |
