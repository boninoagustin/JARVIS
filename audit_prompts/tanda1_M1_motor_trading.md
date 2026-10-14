# Auditoría JARVIS — Tanda 1/5 · M1: Motor de trading (núcleo de decisión y ejecución)

**Alcance**: `src/engine/`, `src/db/`, `src/services/`, `src/llm/`, `src/index.ts` — ~240.000 tokens (51 archivos).
Es la tanda más crítica: acá vive la cadena que decide si el bot opera, cuánto arriesga y cómo ejecuta.
**Modelo recomendado**: DeepSeek V4-Pro. Si el modelo tiene <300k de contexto, partí en M1a (`src/engine`, ~69k) y M1b (`src/db`+`src/services`, ~173k).

---

## 0. Cómo acceder al código

- Repo en el VPS: `/opt/JARVIS/` — si tenés shell, leé los archivos directamente (no toques `node_modules/`, `logs/`, `backups/`).
- GitHub: `https://github.com/boninoagustin/JARVIS.git`.
- Si no tenés shell: te adjunto los archivos de la lista (§2) con este prompt.

## 1. Contexto del sistema

JARVIS es un bot de trading algorítmico SMC/ICT en TypeScript que opera **EN VIVO (dinero real)** contra cTrader (OpenAPI), gestionado vía Telegram (grammy), con estado y configuración en Firestore. Hay un dashboard React/Vite (`jarvis-os`) y una API Kronos (FastAPI) separados.

- Stack: Node v24 (ESM, ejecutado con `tsx`), PM2: `JARVIS` (bot), `KRONOS_API` (FastAPI :8000), `JARVIS_OS` (Vite :5173). WebSocket :8081 (estados de radar al dashboard).
- **Roster dinámico**: se opera un ticker si `enabled && !disabledReason` en `asset_configs/{ticker}` (Firestore). ~27 tickers configurados históricamente (FX, índices EU/US, metales, energía, BTC).
- **Entrada SMART** (decide entre directa u OTE): riesgo >1.5×ATR → OTE; vela clímax → OTE; R:R ≥1.5 o momentum extremo → entrada directa; resto → OTE.
- **Rollover diario 21:00 UTC** (18:00 ARG): el feed muere ~20:29→21:00 y el spread de reapertura es ~19 pips. Hay reglas A/D detrás del flag `rolloverBeEnabled`.
- **Bono macro escalonado** (3/3 = +5, 2/3 = +2, ≤1 = 0).
- Zona horaria: el VPS corre en Europe/Berlin; el bot usa hora argentina (ART) para límites diarios (día FX cambia 17:00 ART).

## 2. Archivos de esta tanda

**`src/engine/` (28 archivos)** — núcleo de decisión:
- `AlphaModel.ts` — scoring SMC, gate OTE (`resolveOteGate`, `evaluateImpulseCore`), filtro ML.
- `SMCEngine.ts` / `SMCManager.ts` / `SMCBridge.ts` (`smc/`) — motor SMC: liquidity, order blocks, CHoCH/BOS, divergencias.
- `smc/modules/`: `divergence.ts`, `imbalances.ts`, `liquidity.ts`, `market_structure.ts`, `order_blocks.ts`, `pivots.ts`. `smc/math/`: `atr.ts`, `rsi.ts`, `vwap.ts`, `zscore.ts`. `smc/smc_config.ts` (¿carga `optimized_preset_*.json`?), `smc/types.ts`.
- `FrictionModel.ts` — spread, comisión, slippage, PnL, R:R.
- `PortfolioModel.ts` — riesgo global, killswitches, límites diarios.
- `StateStore.ts` — `dynamicBotConfig` (defaults en fallback); `Types.ts` (esquemas Zod).
- `MLFilter.ts`, `MLFilterNode.ts` (tree walker XGBoost), `TimesfmFilter.ts`.
- `BarResampler.ts`, `ExecutionModel.ts`, `TickFlow.ts`, `TickGenerator.ts`, `tp2Cap.ts`.

**`src/db/` (10 archivos)** — persistencia y el cuello de botella:
- `trading.ts` (~68k tokens — **el archivo más grande y crítico**: gates de entrada, dispatch, SL/TP/ROI, killswitches, journal).
- `trading_debug.ts` (~43k), `accountState.ts`, `campaigns.ts`, `cleanup.ts`, `market_data.ts`, `memory.ts`, `smart_memory.ts`, `firebase_init.cjs`.

**`src/services/` (12 archivos)** — integraciones:
- `ctrader.ts` (~22k — puente de ejecución con el broker), `ctraderToken.ts`, `ctrader_confirmation.ts`.
- `journal.ts`, `finnhub.ts`, `macro_data.ts`, `correlation.ts`, `telemetry.ts`, `ws_server.ts`, `autotune.ts`, `backtesting.ts`, `kronos.ts`.

**Raíz**: `src/index.ts` (arranque, listeners Firestore), `src/config.ts`, `src/llm/client.ts` (confirmación por LLM).

## 3. Objetivos (por prioridad)

### OBJETIVO 1 — Cadena de entrada: ¿por qué entra / por qué NO entra?
Recorré TODA la cadena de gates que una señal atraviesa y detectá dónde se puede bloquear una señal legítima:

1. cTrader → `SMCManager.processLiveCandles` (¿se generan velas/eventos?).
2. `SMCEngine` (¿CHoCH/BOS/zonas operando, dedupe histórico→live OK?).
3. `AlphaModel` scoring (¿los puntos/score llegan al mínimo?).
4. Entrada SMART (directa vs OTE — verificá la lógica de decisión con estos casos: riesgo>1.5×ATR, vela clímax, R:R≥1.5, momentum extremo, resto).
5. `resolveOteGate` (¿enabled? ¿minScore?).
6. `FrictionModel` (¿spread/comisión/R:R aprueban?).
7. Killswitch global (`evaluateGlobalKillswitch`) y por activo (`evaluateAssetKillswitch`).
8. Cooldown de sniper.
9. Filtro ML (`MLFilter`).
10. Filtro LLM (Gemini) — ¿cuota agotada bloquea en silencio?
11. `autoTrading` / `sessionEnabled` / `entryTrigger`.
12. **Doble puerta de umbrales**: `minPointsForBuy/Sell` (por puntos, raíz) vs `minScore/minScoreBuy/minScoreSell` (por sesión/gatillo) — si una señal debe pasar AMBOS, puede explicar inactividad.
13. `getConfigForTicker` (merge config → `${ticker}_${session}` → `${ticker}_ALL` → defaults) y el listener `onSnapshot` de `asset_configs`: **¿copia todos los campos o se pierden algunos en silencio?**

Para cada gate: determiná el **valor vigente hoy** (defaults de `StateStore.dynamicBotConfig` + config por ticker) y si es capaz de producir cero trades.

### OBJETIVO 2 — Bugs, race conditions y asincronía (foco: `trading.ts`)
- Webhooks/alerts en ráfaga; locks por ticker; fire-and-forget (`docRef.set(...).catch(() => {})`); promesas sin `await`; listeners de Firestore sin `unsubscribe`.
- Paths de excepción que dejan estado inconsistente (trade abierto sin SL, sin journal, sin Telegram).

### OBJETIVO 3 — Precisión matemática
`FrictionModel`, `PortfolioModel`, `tp2Cap`: coma flotante, división por cero, R:R con `riskDistance === 0`, sumas de `rMultiple` diarios, reset diario por zona horaria (ART, día FX cambia 17:00), `rMultiple` calculado vs asumido.

### OBJETIVO 4 — Ejecución (`ctrader.ts`)
Desconexión/reconexión, latencia, órdenes sin SL/TP (ghost positions), símbolo no encontrado, posiciones abiertas fuera del estado interno (reconciliación), estados zombie tras reinicio.

### OBJETIVO 5 — Rollover y reglas nocturnas
Verificá la lógica detrás de `rolloverBeEnabled`: protección durante el gap del feed 20:29→21:00 UTC, manejo del spread de reapertura (~19 pips), qué pasa con trades abiertos durante el rollover.

## 4. Hallazgos previos — verificá si siguen SIN corregir (no los repitas si ya están resueltos)

De la auditoría de jun-2026 (`AUDITORIA_COMPLETA.md`):
- API key de Finnhub hardcodeada (se ve una en `jarvis-os/src/services/macro_data.ts`; verificá también `src/services/finnhub.ts`).
- Divisiones por cero en R:R (`riskDistance === 0` → setup siempre rechazado).
- Race conditions en guardado a Firestore; listeners sin unsubscribe; `catch(() => {})` silenciando errores.
- Tipado `any`; `rMultiple` asumido (1.5/-1.0) en vez de calculado; worker sin timeout.

## 5. Formato de salida obligatorio

Estructurá la respuesta por objetivo. Dentro de cada uno, listá hallazgos así:

```
[🔴 Crítico | 🟠 Alto | 🟡 Moderado | 💡 Mejora] — `archivo.ts:línea` — `función/nombre`
**Problema**: <causa raíz, 2-3 líneas>
**Impacto**: <qué rompe en producción / en la cuenta>
**Solución**: <diff exacto o cambio de config listo para ejecutar>
**Verificación**: <comando o pasos para confirmar que quedó resuelto>
```

Al final, agregá:
1. Sección ejecutiva: los 3-5 cambios de mayor impacto ordenados (quick win primero) + veredicto de cadena de entrada (¿por qué opera/no opera hoy?).
2. **RESUMEN PARA CONSOLIDACIÓN**: tabla con `severidad | archivo:línea | descripción en una línea`.

**Regla dura**: toda solución debe ser ejecutable sin ambigüedad — si proponés código, da el diff exacto; si config, el JSON exacto. No dejes "deberías revisar X" sin el cómo.