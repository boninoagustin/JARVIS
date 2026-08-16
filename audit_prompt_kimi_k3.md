# Auditoría integral del bot de trading JARVIS — bugs, inactividad y validez del backtesting

Eres un ingeniero senior de trading algorítmico y un auditor de sistemas de producción. Vas a hacer una auditoría integral del bot JARVIS. **No quiero un informe descriptivo: quiero hallazgos accionables con la solución lista para que la ejecutemos nosotros** (parche de código exacto, cambio de config, o comando de diagnóstico/verificación).

Responde siempre en español técnico. Prioriza la precisión y la trazabilidad: cada hallazgo debe apuntar a `archivo:línea` y explicar la causa raíz, no solo el síntoma.

---

## 0. Cómo acceder al código

- El repositorio está en el VPS en `/opt/JARVIS/` (backend Node/TypeScript en `src/`, frontend React en `jarvis-os/`).
- También está en GitHub: `https://github.com/boninoagustin/JARVIS.git` (clónalo si tenés acceso; si no, pedí que te peguen los archivos que necesites).
- Si tenés acceso shell al VPS, usá `cd /opt/JARVIS` y leé los archivos directamente.

## 1. Contexto: qué es JARVIS

Bot de trading algorítmico de estrategia **SMC/ICT (Smart Money Concepts)** en TypeScript. Opera en vivo contra el broker **cTrader** y se gestiona vía **Telegram** (long polling). El estado y las configuraciones persisten en **Firestore (Firebase)**. Hay un **dashboard React/Vite** (`jarvis-os`) que incluye un **panel de backtesting**.

Stack y entorno de producción (real, no hipotético):
- Node v24 (ESM, ejecutado con `tsx`), PM2 como process manager.
- 3 servicios en PM2: `JARVIS` (bot), `KRONOS_API` (FastAPI :8000, corre backtests server-side), `JARVIS_OS` (Vite :5173, dashboard).
- WebSocket server en `:8081` (estados de radar al dashboard).
- cTrader OpenAPI para datos de mercado y ejecución de órdenes.
- Firestore para `asset_configs/{ticker}`, `app_settings/bot_config`, `active_trades`, journal.
- El bot escanea 10 activos: AUDCAD, BTCUSD, EURUSD, GBPUSD, NZDUSD, US500, USDCAD, USDJPY, USOIL, XAUUSD.

## 2. Mapa de archivos clave (foco de la auditoría)

**Entrada / gatillos / gestión de trades (lo más importante para "por qué no opera"):**
- `src/db/trading.ts` — cuello de botella: gate de entrada, dispatch, SL/TP/ROI time-decay, killswitches, journal. (~2000+ líneas)
- `src/engine/AlphaModel.ts` — scoring heurístico SMC, gate OTE (`resolveOteGate`, `evaluateImpulseCore`), inyección del filtro ML.
- `src/engine/StateStore.ts` — `dynamicBotConfig` (defaults de configuración en fallback).
- `src/engine/PortfolioModel.ts` — riesgo global, killswitches, límites diarios.
- `src/engine/FrictionModel.ts` — spread, comisión, slippage, PnL, R:R (matemática financiera, coma flotante).
- `src/engine/Types.ts` — esquemas Zod (`AssetSessionConfig`, `ActiveTrade`, `TradeMgmtOverrides`).
- `src/engine/MLFilter.ts` + `MLFilterNode.ts` — filtro XGBoost (tree walker nativo TS).
- `src/engine/smc/SMCEngine.ts`, `SMCManager.ts`, `SMCBridge.ts` y `modules/*` — motor SMC (liquidity, order blocks, CHoCH/BOS, divergencias).
- `src/services/ctrader.ts` — puente de ejecución con el broker.
- `src/llm/client.ts` — confirmación por LLM (Gemini), puede bloquear entradas.
- `src/index.ts` — arranque, listeners de Firestore.

**Backtesting (para evaluar si el panel hace bien su trabajo y si sus resultados son representativos):**
- `jarvis-os/src/services/backtestEngine.ts` — motor de backtest (canónico).
- `jarvis-os/src/services/backtestTypes.ts` — tipos `BacktestConfig`, `BacktestTrade`.
- `jarvis-os/src/services/optimizer.ts` — Auto-Tune (algoritmo genético, perfiles ROI).
- `jarvis-os/src/components/BacktestingPanel.tsx` — UI del panel (~3000 líneas).
- `jarvis-os/src/features/backtesting/hooks/useBacktestApi.ts` — hook HTTP → Kronos.
- `jarvis-os/scripts/backtest_server.ts` — entrypoint server-side que corre el motor real.
- `src/engine/TickGenerator.ts` + `BarResampler.ts` + `scripts/m1_backtest.ts` — backtest tick-level M1 (Brownian Bridge) que **NO** usa el panel.
- `src/services/backtesting.ts` y `scripts/export_smc_csv.ts` — exportación de logs Pine a CSV.

---

## 3. Objetivos de la auditoría (en este orden de prioridad)

### OBJETIVO 1 — Bugs y correcciones (auditoría de código general)
Revisá los archivos clave arriba y reportá bugs reales clasificados por severidad. Prestá especial atención a:
- **Race conditions y asincronía**: `trading.ts` recibe webhooks/alerts que pueden llegar en ráfaga; locks por ticker, fire-and-forget (`docRef.set(...).catch(() => {})`), promesas sin `await`, listeners de Firestore sin cleanup/`unsubscribe`.
- **Precisión matemática** en `FrictionModel.ts` y `PortfolioModel.ts`: coma flotante, división por cero, R:R con `riskDistance === 0`, sumas de `rMultiple` diarios, reinicio diario por zona horaria (el bot usa hora argentina ART, convención FX de día que cambia a las 17:00).
- **Estado global mutable** en `StateStore.ts` / `Types.ts`: fugas de estado entre trades, tipado `any`, casts inseguros, validación Zod que no se aplica en runtime.
- **Ejecución** en `ctrader.ts`: manejo de desconexión, latencia, órdenes sin SL/TP (ghost positions), símbolos no encontrados.

### OBJETIVO 2 — ¿Por qué el bot toma tan pocos o casi ningún trade? (diagnóstico de inactividad)
Este es el objetivo más urgente. Recorré **toda la cadena de gates** que una señal debe atravesar antes de ejecutar una orden y detectá dónde se bloquea. La cadena es, en orden:

1. Llegada de datos de cTrader → `SMCManager.processLiveCandles` → ¿se generan velas/eventos SMC?
2. `SMCEngine` → ¿detecta CHoCH/BOS/zonas, o hay dedupe/gap histórico→live que lo bloquea?
3. `AlphaModel` → scoring: ¿los `points`/`score` llegan al mínimo? (OJO: ver síntoma S1 abajo sobre `minPointsForBuy`).
4. `resolveOteGate` → ¿el gatillo está `enabled` y el `minScore` se cumple?
5. `FrictionModel` → ¿spread/comisión/R:R aprueban?
6. Killswitches (global `evaluateGlobalKillswitch` + por-activo `evaluateAssetKillswitch`) → ¿algo está matando todo?
7. Cooldown de sniper (`sniperCooldownMs`) → ¿está bloqueando por solapamiento?
8. Filtro ML (`MLFilter`) → ¿modelo cargado? ¿threshold 0.65 rechaza todo?
9. Filtro LLM (Gemini) → ¿cuota agotada bloquea silenciosamente?
10. `autoTrading` / `sessionEnabled` / `entryTrigger` → ¿alguno está en false o en un modo demasiado restrictivo?
11. `asset_configs` de Firestore → ¿se cargan, o el bot opera con defaults de fallback?

Para cada gate, determiná **cuál es el valor vigente hoy** (default en `StateStore.dynamicBotConfig`, config por ticker en `getConfigForTicker`, y lo que copia el listener de `asset_configs`) y **si ese valor es capaz de producir cero trades**. Marcá explícitamente los defaults que rechazan señales legítimas.

### OBJETIVO 3 — ¿El panel de backtesting hace bien su trabajo? (UI/UX y corrección funcional)
Evaluá `BacktestingPanel.tsx` + `useBacktestApi.ts` + `optimizer.ts` como producto:
- ¿El flujo es coherente (cargar datos → configurar → simular → auto-tune → exportar a JARVIS) o hay pasos que no hacen lo que su etiqueta dice?
- ¿El **Auto-Tune** optimiza sobre el motor real y aplica los resultados a los sliders correctos? (Ver pitfalls P8 y P9 abajo: shape de respuesta, campo `tfs`, `best` vs `optimized`.)
- ¿El **"Exportar a JARVIS"** escribe a `asset_configs/{ticker}` TODO lo que el bot en vivo consume, o hay campos que se pierden en el camino (ver objetivo 5)?
- ¿Hay bugs de render/estado (crash `invalid date`, `processedEvents` faltante, configuración parcial → NaN, conteo de líneas que congela la UI)?

### OBJETIVO 4 — ¿Los resultados del backtest son representativos de cómo opera el bot en vivo?
Esta es la pregunta analítica más importante. No des por sentado que "usa el mismo motor" = "mismos resultados". Verificá específicamente estas divergencias entre backtest y vivo:

1. **Resolución temporal / look-ahead bias**: el panel corre `backtest_server.ts` → `backtestEngine.ts` sobre **logs Pine orientados a eventos** (tiempo irregular). En vivo el bot evalúa SL/TP/ROI **en cada tick** (existe `scripts/m1_backtest.ts` con `TickGenerator` Brownian Bridge M15→M1 justamente para respetar el orden intra-barra). ¿El backtest del panel respeta el orden intra-barra (qué tocó primero, SL o TP), o asume un orden que genera resultados optimistas? ¿Qué tanto se parecen los resultados del panel a los de `m1_backtest.ts`?
2. **Gates replicados**: `backtestEngine.ts` importa `evaluateImpulseCore` de `AlphaModel` y `evaluateNetTrade` de `FrictionModel` (comparten núcleo — bien). Pero ¿replica los gates del vivo que vienen DESPUÉS del core: killswitch global/por-activo, límites diarios, cooldown de sniper, filtro ML, filtro LLM, `sessionEnabled`? Si no los replica, el backtest sobrestima la cantidad de trades y su PnL frente a la realidad.
3. **Costos de transacción**: el panel tiene inputs `SPREAD PIPS` y `COMISIÓN/LOTE`. ¿El vivo aplica exactamente los mismos costos (spread real de cTrader + comisión), o los valores difieren? ¿El backtest aplica slippage?
4. **Configuración**: ¿el config que recibe el backtest (`sessions`, `sessionFilter`, `minBuyPoints`, `minScore` por gatillo) es el MISMO que `getConfigForTicker` le da al vivo? ¿O el panel usa sus propios defaults que divergen?
5. **Fidelidad de los datos**: `export_smc_csv.ts` genera los logs Pine. ¿Emite los mismos eventos de zonas/CHoCH/BOS que el vivo ve en tiempo real (campos `d/p/b/sc`)? ¿Los CSVs de `logs/{ticker}/history_exported/` están frescos (fecha de última modificación) o desactualizados respecto del mercado actual?

Concluí con un **veredicto explícito**: ¿el backtest del panel es una aproximación razonable o engaña al operador? Y proponé la corrección mínima para cerrar cada brecha detectada (ej. "correr el panel sobre `m1_backtest.ts`", "replicar killswitch en el motor", "unificar costos").

### OBJETIVO 5 — ¿La configuración `asset_config` está limitando el trabajo del bot real?
Auditá la cadena completa de configuración y detectá dónde la config que Bon cree que aplica **no** es la que efectivamente rige en vivo:
- `getConfigForTicker(ticker)` en `trading.ts` (merge: config del ticker → `${ticker}_${session}` → `${ticker}_ALL` → defaults globales).
- El listener `onSnapshot` de `asset_configs` que arma `assetSessionConfigs`: **¿copia todos los campos, o solo un subconjunto?** Si un campo exportado desde el panel no se copia, se pierde silenciosamente.
- Los defaults de `dynamicBotConfig` en `StateStore.ts` (ver síntoma S1: `minPointsForBuy: 5`).
- Los presets `optimized_preset_<TICKER>.json` y `optimized_preset_<TICKER>_hyperopt.json` en la raíz: ¿se cargan en algún momento (`smc_config.loadOptimizedPreset`), o son archivos muertos que no alimentan `asset_configs`?
- ¿Qué tickers tienen `asset_configs` real en Firestore y cuáles operan con defaults?

---

## 4. Síntomas observados (datos reales de producción — usalos como pistas, verificá en código)

- **S1 — Default que rechaza todo**: `StateStore.ts` define `dynamicBotConfig.minPointsForBuy = 5` y `minPointsForSell = 5`. Pero los eventos SMC tienen puntos FIJOS: CHoCH = 4, BOS = 3. Un `minPointsForBuy: 5` descarta **todo** evento (`ev.points < minPts`). Si un ticker no tiene `asset_config` que lo sobreescriba, ese ticker **nunca** entra. El panel en cambio usa default 4. Verificá si esto sigue vigente y qué tickers caen en el default 5.
- **S2 — Reinicios**: `pm2 list` muestra `JARVIS` con **904 reinicios** (↺) y `KRONOS_API` con 12. Investigá si hay un crash loop (ej. `process.exit(1)` cuando Firebase falla en `src/index.ts`) y qué lo dispara.
- **S3 — Dos sistemas de threshold**: conviven `minPointsForBuy/Sell` (por puntos) a nivel raíz y `minScore`/`minScoreBuy`/`minScoreSell` por sesión/gatillo. Verificá si hay una doble puerta que haga que una señal deba pasar **ambos** umbrales (lo que explicaría inactividad aunque cada umbral individual parezca razonable).
- **S4 — Historial ya documentado** (verificá si siguen presentes o si regresaron): LLM/Gemini con cuota agotada bloqueando entradas sin log de error; `SMCManager` con trendbars en orden inverso y gap histórico→live (dedupe eterno); `entryTrigger` en modo `OTE` esperando retrocesos que no llegan; `autoTrading: false` por defecto; símbolo faltante en el array del scanner de cTrader; `SYNC_ZONES` throttled en deadlock; cuota de Firebase agotada (el bot queda ciego: sin asset_configs, sin journal, sin Telegram).

## 5. Hallazgos previos (para construir encima, NO para repetir)

Una auditoría anterior (jun-2026, `AUDITORIA_COMPLETA.md` en la raíz) ya reportó: API key de Finnhub hardcodeada; divisiones por cero en R:R (`riskDistance===0` → setup siempre rechazado); race conditions en guardado a Firestore; listeners sin unsubscribe; `catch(() => {})` silenciando errores; tipado `any`; `rMultiple` asumido (1.5/-1.0) en vez de calculado; worker sin timeout. **No repitas esos hallazgos salvo que verifiques que siguen sin corregir.** Verificá en el código actual cuáles ya fueron resueltos y cuáles persisten.

Pitfalls conocidos del backtest (de la documentación interna) que debés **verificar si siguen presentes**:
- P1: `minBuyPoints`/`minSellPoints` por defecto 5 → 0 trades (ya en S1).
- P2: campos de zona en `d/p/b/sc`, no `Direction/Top/Bottom`.
- P3: config parcial → NaN (merge `{...defaults, ...JSON.parse(...)}` obligatorio).
- P4: `ticker` como query param, no FormData (FastAPI 422).
- P5: `timestamp` y `processedEvents` faltantes en el output → crash del panel.
- P6: `/api/backtest/files` devuelve objetos `{name, lines}`, no strings.
- P7: puerto 8000 (Kronos) debe estar abierto en ufw, si no `CORS request did not succeed`.
- P8: Auto-Tune devuelve `best`, no `{optimized, metrics}` — si el shape no coincide, el panel "corre" pero no aplica nada.
- P9: `tfs` falta en payloads de optimize/batch → 0 archivos cargados.
- P10: `runBacktest` necesita el `BacktestConfig` COMPLETO (sessions + sessionFilter), no un subconjunto plano.

---

## 6. Formato de salida obligatorio

Estructurá tu respuesta en 5 secciones (una por objetivo). Dentro de cada sección, listá hallazgos así:

```
[🔴 Crítico | 🟠 Alto | 🟡 Moderado] — `archivo.ts:línea` — `función/nombre`
**Problema**: <causa raíz, 2-3 líneas, sin explicar qué hace el código>
**Impacto**: <qué rompe en producción / en el backtest / en la cuenta>
**Solución**: <código refactorizado listo para copiar, o cambio de config exacto>
**Verificación**: <comando o pasos para confirmar que quedó resuelto>
```

Al final, agregá una **sección ejecutiva** con:
1. Los 3-5 cambios de mayor impacto ordenados por prioridad, indicando cuál es el "quick win" que probablemente restaura la operación del bot.
2. Un veredicto de una línea sobre cada objetivo (2 a 5).
3. Lista de archivos que tocaríamos y en qué orden, con el diff aproximado (N archivos, ~M líneas cambiadas) para que aprobemos antes de ejecutar.

Regla dura: **toda solución debe ser ejecutable por nosotros sin ambigüedad** — si proponés un cambio de config, da el JSON exacto; si proponés código, da el diff exacto. No dejes "deberías revisar X" sin el cómo.
