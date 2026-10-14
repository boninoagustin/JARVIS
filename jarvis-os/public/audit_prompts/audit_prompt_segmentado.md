# Auditoría segmentada de JARVIS — prompt maestro (DeepSeek V4-Pro)

> **Cómo usar**: este prompt se ejecuta en **5 tandas**, una por módulo. Cada tanda pega el
> prompt maestro + el bloque del módulo correspondiente + el código de ese módulo.
> Al final de las 5 tandas, se consolida en un informe único con la sección ejecutiva.
> Modelo recomendado: **DeepSeek V4-Pro** (contexto 1M, cache reads $0.022/M off-peak).

---

## PROMPT MAESTRO (se repite en cada tanda)

Eres un ingeniero senior de trading algorítmico y auditor de sistemas de producción.
Vas a auditar el módulo de JARVIS que te doy abajo. **No quiero un informe descriptivo:
quiero hallazgos accionables con la solución lista para ejecutar** (diff exacto, cambio de
config, o comando de verificación).

Responde en español técnico. Cada hallazgo debe apuntar a `archivo:línea` y explicar la
causa raíz, no solo el síntoma. Separá claramente **errores/bugs** de **mejoras**.

### Contexto del bot
JARVIS es un bot de trading algorítmico SMC/ICT en TypeScript que opera en vivo contra
cTrader, gestionado por Telegram, con estado en Firestore y dashboard React/Vite
(`jarvis-os`). Stack: Node v24 (ESM, tsx), PM2 (JARVIS bot, KRONOS_API FastAPI :8000,
JARVIS_OS Vite :5173). Escanea 10 activos: AUDCAD, BTCUSD, EURUSD, GBPUSD, NZDUSD,
US500, USDCAD, USDJPY, USOIL, XAUUSD. El backtest corre server-side en Kronos sobre el
motor real (`backtestEngine.ts`). Hyperopt bayesiano (Optuna) en `scripts/hyperopt/`.

### Foco transversal (aplicá a todo el código del módulo)
- **Race conditions y asincronía**: locks por ticker, fire-and-forget
  (`docRef.set(...).catch(() => {})`), promesas sin `await`, listeners de Firestore sin
  `unsubscribe`.
- **Precisión matemática**: coma flotante, división por cero, R:R con `riskDistance===0`,
  unidades porcentaje vs decimal, reinicio diario por zona horaria (ART, día FX cambia 17:00).
- **Estado global mutable**: fugas de estado entre trades, tipado `any`, casts inseguros,
  validación Zod que no se aplica en runtime.
- **Look-ahead bias en backtest**: uso de información futura, orden intra-barra (SL vs TP),
  gates del vivo NO replicados (killswitch, límites diarios, cooldown sniper, filtro ML/LLM).
- **Config que no rige**: defaults de `StateStore.dynamicBotConfig` que rechazan señales
  legítimas (ej. `minPointsForBuy: 5` vs eventos CHoCH=4/BOS=3), campos que se pierden en
  el merge `getConfigForTicker` o en el listener de `asset_configs`.

### Formato de salida obligatorio
Listá hallazgos así:

```
[🔴 Crítico | 🟠 Alto | 🟡 Moderado | 💡 Mejora] — `archivo.ts:línea` — `función/nombre`
**Problema**: <causa raíz, 2-3 líneas>
**Impacto**: <qué rompe en producción / en el backtest / en la cuenta>
**Solución**: <diff exacto o cambio de config listo para ejecutar>
**Verificación**: <comando o pasos para confirmar que quedó resuelto>
```

Regla dura: **toda solución debe ser ejecutable sin ambigüedad** — si proponés código, da
el diff exacto; si config, el JSON exacto. No dejes "deberías revisar X" sin el cómo.

---

## TANDA 1 — M1: Motor de trading (240k tokens, 51 archivos)

**Archivos**: `src/engine/*` (AlphaModel, StateStore, PortfolioModel, FrictionModel, Types,
MLFilter, smc/SMCEngine, smc/SMCManager, smc/SMCBridge, smc/modules/*), `src/db/trading.ts`
(cuello de botella: gates, dispatch, SL/TP/ROI, killswitches, journal), `src/db/trading_debug.ts`,
`src/services/ctrader.ts` (ejecución broker), `src/services/journal.ts`, `src/index.ts`,
`src/llm/client.ts`.

**Objetivos**:
1. Bugs y race conditions en la cadena de entrada (webhooks en ráfaga, locks, promesas sin await).
2. Precisión matemática en FrictionModel/PortfolioModel (R:R, rMultiple, límites diarios).
3. **¿Por qué el bot toma tan pocos trades?** Recorré TODA la cadena de gates:
   SMCManager→SMCEngine→AlphaModel scoring→resolveOteGate→FrictionModel→killswitches→
   cooldown sniper→filtro ML→filtro LLM→autoTrading/sessionEnabled→asset_configs.
   Para cada gate, decí el valor vigente hoy y si es capaz de producir cero trades.
4. Ejecución en ctrader.ts: desconexión, latencia, órdenes sin SL/TP (ghost positions).

---

## TANDA 2 — M2: Backtesting (80k tokens, 18 archivos)

**Archivos**: `jarvis-os/src/services/backtestEngine.ts` (motor canónico), `backtestTypes.ts`,
`optimizer.ts` (Auto-Tune genético), `jarvis-os/scripts/backtest_server.ts`,
`backtest_optimize_server.ts`, `kronos_api/main.py` (FastAPI), `scripts/hyperopt/*`
(hyperopt_server.py, jarvis_hyperopt_worker.ts, run_hyperopt.py, metrics.py, load_best_params.py).

**Objetivos**:
1. **¿El backtest es representativo del vivo?** Verificá look-ahead bias, orden intra-barra
   (SL vs TP), gates del vivo replicados (killswitch, límites diarios, cooldown, ML/LLM),
   costos de transacción (spread/comisión/slippage), y si el config es el MISMO que
   `getConfigForTicker` le da al vivo.
2. Correctitud del motor: ROI time-decay, TP1/TP2, partial close, trailing, RIDER, edge cases.
3. Hyperopt: función objetivo, overfitting (¿split train/test u OOS, o in-sample?),
   protocolo RPC del worker, persistencia del estudio SQLite.
4. Config passing por Kronos: ¿se corrompe el config_json? ¿cache de tsx sirve versión stale?

---

## TANDA 3 — M3: Frontend dashboard (120k tokens, 13 archivos)

**Archivos**: `jarvis-os/src/components/*` (BacktestingPanel, PeriodicOptPanel,
AnalyticsJournal, FundamentalTerminal, RadarHeatmap, AdminPanel), `jarvis-os/src/features/*`,
`jarvis-os/src/App.tsx`.

**Objetivos**:
1. Flujo end-to-end del panel: ¿cada botón hace lo que su etiqueta dice? (Simular, Auto-Tune,
   Exportar a JARVIS, descarga CSV, Monte Carlo, ML badge).
2. Cálculo de métricas avanzadas: Sharpe, MaxDD, profit factor, expectancy — ¿divisiones por
   cero con 0 trades, NaN con configs parciales?
3. Crash/whitescreen: `new Date(t.timestamp)` con timestamp faltante, `processedEvents`
   faltante, `files` como objetos vs strings.
4. **Exportar a JARVIS**: ¿escribe a `asset_configs/{ticker}` TODOS los campos que el vivo
   consume, o se pierden campos en el camino?
5. Auto-Tune: ¿aplica `best` a los sliders correctos, o "corre" y no hace nada?

---

## TANDA 4 — M4: Scripts de operación (62k tokens, 35 archivos)

**Archivos**: `scripts/periodic_opt/*` (run_weekly.py, etc.), `scripts/timesfm/*`,
`scripts/fetch_history.ts`, `scripts/export_smc_csv.ts`, `scripts/m1_backtest.ts`.

**Objetivos**:
1. **run_weekly.py** (optimizador dominical): ¿corre el motor real? ¿aplica resultados a
   `asset_configs`? ¿qué decide el optimizador (enabled/minScore/entryPercent) vs qué está
   hardcodeado? ¿respeta disabledReason y el roster dinámico?
2. Pipeline de datos: ¿`export_smc_csv.ts` emite los mismos eventos SMC que el vivo ve en
   tiempo real? ¿Los CSVs están frescos o desactualizados? ¿`fetch_history.ts` respeta
   límites de cTrader, dedupe/sort, gaps?
3. TimesFM: filtro direccional, integración con el motor, fallos silenciosos.

---

## TANDA 5 — M5: Estrategia Pine + docs (62k tokens, 5 archivos)

**Archivos**: `SMC_Master_5.2_JARVIS_v6.0.pine`, `quant_audit_full.md`, `AUDITORIA_COMPLETA.md`,
`SKILL.MD`, `SETUP.md`.

**Objetivos**:
1. **Estrategia Pine**: ¿la lógica SMC del Pine (liquidity, order blocks, CHoCH/BOS,
   divergencias) coincide con la implementación TS del motor? ¿Hay divergencias de
   parámetros o de lógica que expliquen diferencias entre el Pine y el bot?
2. **Docs previas**: leé `AUDITORIA_COMPLETA.md` y `quant_audit_full.md` para conocer
   hallazgos ya reportados. **No los repitas** salvo que verifiques que siguen sin corregir.
   Verificá cuáles ya fueron resueltos y cuáles persisten.

---

## CONSOLIDACIÓN (después de las 5 tandas)

Con los hallazgos de las 5 tandas, producí el informe final con:
1. Los **3-5 cambios de mayor impacto** ordenados por prioridad, indicando el "quick win"
   que probablemente restaura la operación del bot.
2. Un **veredicto de una línea por módulo** (M1 a M5).
3. Lista de archivos a tocar y en qué orden, con diff aproximado (N archivos, ~M líneas)
   para que aprobemos antes de ejecutar.
4. **Dedupe**: si un hallazgo aparece en más de una tanda, consolidalo en uno solo.
