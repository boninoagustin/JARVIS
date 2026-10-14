# Auditoría JARVIS — Tanda 1 · Complemento y consolidación de subagentes

**08-oct-2026**. Este archivo completa `tanda1_M1_opus55.md` con el trabajo de los subagentes de la segunda pasada. Incluye la verificación en código de cada hallazgo 🔴/🟠 (regla de Bon: validar antes de aplicar) y dos hallazgos nuevos propios (sizing y atribución diaria del killswitch).

## Estado de cobertura por objetivo

| Obj | Alcance | Estado | Dónde |
|---|---|---|---|
| 1 · Cadena de entrada | gates, merge config, activos fantasma | ✅ completo | informe T1 + `smc.md` |
| 1 · Motor SMC (señales) | velas, CHoCH/BOS, math SMC, ML, TimesFM, presets | ✅ completo | `smc.md` (H1–H7) |
| 2 · Concurrencia/asincronía | locks, races, listeners, fugas | ✅ completo | `async.md` |
| 3 · Matemática/riesgo | sizing, rMultiple, killswitch, FrictionModel | ✅ completo | T1 + `async.md` + N1–N3 acá |
| 4 · Ejecución cTrader | executeMarketOrder, amend, token | ✅ completo | `async.md` + verificación y E1 acá |
| 5 · Rollover | A/C/D, ventanas | ✅ completo | T1 |

---

## Verificación de los hallazgos fuertes (confirmado en código)

- ✅ **SMC H1 [🔴]** — `SMCManager.ts:119` usa `candle.timestamp > curForming.timestamp` (estricto) → descarta los trendbars del mismo timestamp que llegan 1×tick mientras la vela se forma; el `forming` queda con el **primer** snapshot. Y `ctrader.ts:450` hace `close: (lowRaw + (tb.deltaClose || 0)) / divider` → si el trendbar vivo no trae `deltaClose` (Spotware no lo manda en SpotEvent), **close = low**. Resultado: el motor vivo corre sobre velas degeneradas (primer tick, sin mechas → 0 sweeps, sesgo SELL 27:7, ATR ≈ 50 %), mientras el backtest usa velas completas. **Es la causa raíz más probable del "pocas/malas señales en vivo" y rompe la paridad desde el 06-ago.**
- ✅ **Async 🟠** — `trading.ts:1412-1436` (ROI) y `:1679-1707` (RIDER): borran RAM/`active_trades`, escriben `result:'WIN'` y mandan Telegram **sin `closePosition`** (el único `closePosition` está en el SAR `:4239`). Latente (0 disparos aún), pero `minimal_roi` está configurado en 464 nodos.
- ✅ **Async 🟠** — `trading.ts:1472-1500` + `:1547` + `:1808-1834`: `modifyStopLoss` fire-and-forget por PING, sin guard de "en vuelo", tope de 5 agotado en ~6 s, el trailing resetea el contador, y el `.then` asigna `slPrice = targetSlPrice` (el target actual, no el enviado). Evidencia en `JARVIS-error.log` L34018-34030 (13 `TRADING_BAD_STOPS` seguidos, 6 "no refleja el SL pedido").
- ✅ **Async 🟡** — `trading.ts:521-527`: adopción de huérfano con `set()` **sin `{merge:true}`** sobre el journal original → borra `triggerKey/events/points`, el parcial de `ctrader_real_pnl` y la key `result` (el doc queda invisible al barrido de huérfanos). 3 docs afectados (81G2A2, PP22N2, B4Q3MZ).
- ✅ **SMC H4 [🟠]** — `MLFilter.ts:84-87` `predictProba` = `sigmoid(Σ walkTree)` **sin `logit(base_score)`**; `grep base_score` en `src/engine` y `jarvis-os/src` da 0. Verificado numéricamente por el subagente contra xgboost real: `max|Δp| = 0.32` (AUDCAD), `sigmoid(margin − logit(base_score)) == p_ts` con error 2e-7. Gate ML hoy OFF, pero la decisión de apagarlo se tomó con probabilidades sesgadas.
- ✅ **Async 🟡** — `trading.ts:1173`: `isBacktest` por antigüedad del TS, evaluado **después** de `await previousLock` y con `await sendTelegramAlert` (grammy 500 s) dentro del lock → una alerta viva encolada pasa a "backtest" en el store vivo. 0 ocurrencias en la ventana (hipótesis).
- ✅ **SMC H5 [🟠]** — sin timer de cierre de vela: la última vela de la sesión se procesa en la reapertura (US500 20:55 procesada 22:00) sellada con `TS: Date.now()` → señal "fresca" en el pico de spread.

---

## Hallazgos nuevos (propios, esta pasada)

### N1 [🟡 Moderado] — `src/services/ctrader.ts:766-842` — `calculateLotSize`: pip-value y coste por punto **hardcodeados**, sin conversión de moneda de cotización

**Problema**: el tamaño usa costes fijos por instrumento — forex `$10/pip/lote` (solo cierto si la cotización es USD), la rama JPY usa `1000` fijo (`riskAmount / (slDistance*1000)`, ignorando la tasa USDJPY), índices `$1/punto`, oro `$10/pip`, etc. No hay conversión por moneda de cotización ni por tasa actual. El helper `computeRMultipleFromRealPnl` (`ctrader.ts:322`) **sí** usa `usdjpy` para el R real al cierre, pero `calculateLotSize` no.
**Impacto**: sub/supra-dimensionamiento sistemático en cruces y pares JPY. Ej. numérico: USDJPY con SL 50 pips y riesgo $45 → lotes = 45/(0.5×1000) = **0.09**, cuando el correcto es ≈ 45/(50 × 100000×0.01/usdjpy≈150 ⇒ $6.67/pip) = **0.135** (~33 % menos). AUDCAD (cotización CAD) también sale mal (usa $10 en vez de ~$7.3). El error está acotado (~20-35 %) y el resto de la cadena (rounding a stepVolume) no lo corrige.
**Solución**: derivar el valor del pip/punto desde `symbolInfo` (pipValue/pipSize/tickValue del broker) o, mínimo, pasar la tasa de conversión (`usdjpy` y DXY para CAD/CHF/AUD/NZD) como ya se hace en `computeRMultipleFromRealPnl`.
```diff
--- a/src/services/ctrader.ts
+++ b/src/services/ctrader.ts
@@ -787,9 +787,10 @@
     if (t.includes('JPY')) {
-        // JPY pairs: 1 pip = 0.01, lot = 100,000 units
-        pipValue = slDistance / 0.01;
-        const lotSize = riskAmount / (pipValue * (1000 / 100)); // ~$9.xx per pip per lot
-        return Math.max(0, parseFloat(lotSize.toFixed(4)));
+        // JPY: pip = 0.01, 1 lote = 100 000 uds base; valor del pip en USD = 100000*0.01 / usdjpy
+        const usdjpy = getUsdjpyRate?.() ?? 150;   // misma fuente que computeRMultipleFromRealPnl (ctrader.ts:322)
+        const pipUsd = (100000 * 0.01) / usdjpy;
+        const pips = slDistance / 0.01;
+        const lotSize = riskAmount / (pips * pipUsd);
+        return Math.max(0, parseFloat(lotSize.toFixed(4)));
```
(y análogo para forex no-USD: `pipUsd = 100000 * 0.0001 * (quote === 'USD' ? 1 : 1/rateQuoteUSD)`; para cruces AUDCAD/GBPCAD/EURGBP/GBPAUD usar la tasa del par contra el USD).
**Verificación**: `grep -n "costPerPip\|costPerPoint\|1000 / 100" src/services/ctrader.ts`; comparar `calculateLotSize(equity, entry, sl, 1, 'USDJPY')` contra el cálculo con tasa real → mismo resultado que `computeRMultipleFromRealPnl` para el mismo riesgo.

### N2 [🟡 Moderado] — `src/engine/PortfolioModel.ts:158,256` — el killswitch atribuye el trade al día FX de la **APERTURA** cuando `closedAt` no es `number`

**Problema**: `(typeof t.closedAt === 'number' ? t.closedAt : t.timestamp) >= fxDayStartMs`. En Firestore `closedAt` se escribe como Timestamp (`toISOString()` en el reconcile `trading.ts:355`) o como `Date`, que el SDK devuelve como objeto Timestamp — **nunca `number`** en los paths normales. La rama `number` solo matchea si algún path escribió `Date.now()` crudo. Resultado: un trade se carga al día FX en que **abrió**, no en que cerró.
**Impacto**: un trade abierto antes de las 17:00 NY y cerrado después se contabiliza en el día anterior → el killswitch puede quedarse "bloqueado" a la mañana siguiente (cobra ayer una pérdida de hoy) o, al revés, liberar antes de tiempo. Con el tope `maxDailyLossR=1.5`, una sola pérdida mal atribuida cambia cuándo se despeja la cuenta. Es coherente con el patrón de bloqueo matutino observado (05/06/07-oct).
**Solución**: normalizar el cierre antes de comparar (Timestamp→ms), e idealmente usar `closedAt` como fuente única:
```diff
--- a/src/engine/PortfolioModel.ts
+++ b/src/engine/PortfolioModel.ts
@@ (helper al inicio)
+const toMs = (v: any): number | null => {
+    if (v == null) return null;
+    if (typeof v === 'number') return v;
+    if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
+    if (typeof v.toMillis === 'function') return v.toMillis();   // Firestore Timestamp
+    if (typeof v.seconds === 'number') return v.seconds * 1000;
+    return null;
+};
@@ -158,1 +158,1 @@
-            .filter(t => (typeof t.closedAt === 'number' ? t.closedAt : t.timestamp) >= fxDayStartMs)
+            .filter(t => (toMs(t.closedAt) ?? toMs(t.timestamp) ?? 0) >= fxDayStartMs)
@@ -256,1 +256,1 @@
-            .filter(t => (typeof t.closedAt === 'number' ? t.closedAt : t.timestamp) >= fxDayStartMs)
+            .filter(t => (toMs(t.closedAt) ?? toMs(t.timestamp) ?? 0) >= fxDayStartMs)
```
**Verificación**: script de solo lectura que liste los últimos trades con `closedAt`/`timestamp` y el `getFxDayStartMs(now)` — cada trade debe caer en el día de su cierre. Antes del fix, un trade abierto 16:50 NY y cerrado 17:10 NY aparece en el día anterior.

---

## RESUMEN CONSOLIDADO (T1 completa)

| severidad | archivo:línea | descripción |
|---|---|---|
| 🔴 | `Types.ts:215-216` + `trading.ts:859-863,782` | Doc `asset_configs` inválido se descarta entero → fallback opera con defaults (AUDJPY/USDJPY/GBPJPY; KS global 3 días) |
| 🔴 | `smc/SMCManager.ts:119` + `ctrader.ts:450` | Motor vivo procesa el primer trendbar de cada vela (`>` estricto) y close=low sin deltaClose → 0 sweeps, sesgo SELL, paridad backtest rota desde 06-ago |
| 🔴 | `trading.ts:872` | `enabled` ausente = habilitado → 4 activos fantasma operando (CADJPY/ITALY40/SPAIN35/XPTUSD) |
| 🟠 | `trading.ts:1412-1436,1679-1707` | ROI/RIDER "cierran" sin `closePosition` → posición viva sin gestor + WIN falso en journal/KS |
| 🟠 | `trading.ts:1472-1500,1547,1808-1834` | Reintento de SL por PING sin guard de vuelo: amends solapados, protección abandonada, SL RAM ≠ broker |
| 🟠 | `trading.ts:1191-1201` | Lock del ticker no liberado en los `return` del Master Killswitch → deadlock por ticker |
| 🟠 | `trading.ts:1025` | Pre-trade OTE persistido fire-and-forget compite con los delete → 7 `active_trades` fantasma |
| 🟠 | `MLFilter.ts:84-87` | `predictProba` omite `logit(base_score)` → probabilidades sesgadas (hasta 0.32); decisión del gate ML viciada |
| 🟠 | `smc/SMCManager.ts:83` + `SMCBridge.ts:80` | Sin timer de cierre: última vela de sesión procesada en reapertura como señal fresca |
| 🟠 | `trading.ts:686-778,865-901` | `zoneWeights`/`vwapPts`/`maxSmartRiskPercent`/`rolloverEntryBlock` no se propagan |
| 🟠 | `trading.ts:3217,3299,3358,3580` + `FrictionModel.ts:100-105` | Ventanas de rollover fijas UTC; broker a 22:00 UTC el 01-nov-2026 |
| 🟡 | `trading.ts:509,521-527` | Adopción con `set()` sin merge pisa el journal original (pierde triggerKey/points/result) |
| 🟡 | `trading.ts:799-804,3355-3359,3480-3485` | Restore post-reinicio de la Regla D ignora la ventana; tick de rollover sin guard de reentrada |
| 🟡 | `trading.ts:1173,4294,4345` + `telegram.ts:17` | `isBacktest` por antigüedad del TS + `await` Telegram 500 s dentro del lock |
| 🟡 | `trading.ts:418-528` vs `4219-4285` | Reconcile adopta sin gracia de antigüedad: orden en vuelo borrada como gemelo zombie |
| 🟡 | `ctrader.ts:375-408` | PING "TF: 15" transporta la vela M5 (orden del Map) → atr14 vivo y clímax divergen del backtest |
| 🟡 | `smc/SMCEngine.ts:347` / `market_structure.ts:356` | Z-score re-anclado + gate `|z|≥2` ⇒ enfriamiento oculto ≥5-6 velas; rama ATR muerta |
| 🟡 | `smc/SMCManager.ts:36-41` + `ctrader.ts:563` | Bootstrap LTF con contexto HTF 'Neutral' → OB sub-puntuados tras cada reinicio |
| 🟡 | `MLFilter.ts:121-124` | `z_score`/`sweep_direction` constantes 0 en vivo y backtest → evaluación fuera de distribución |
| 🟡 | `ctrader.ts:766-842` | `calculateLotSize` con pip/coste por punto hardcodeados, sin conversión de cotización (JPY/cruces ±20-35 %) |
| 🟡 | `PortfolioModel.ts:158,256` | Killswitch atribuye el trade al día FX de apertura cuando `closedAt` no es `number` |
| 🟡 | `trading.ts:866-871` | Listener fija defaults globales en el snapshot (carrera con `bot_config`) |
| 🟡 | `trading.ts:1328-1338` | `atr14` vivo = rango parcial de la vela en formación |
| 💡 | `ctrader.ts:1624-1647` | `getOpenPositions` → `[]` ante error = "cerrada"; `closeMissedCount` acumulativo |
| 💡 | `telemetry.ts:64-101` | `flushTelemetry` pierde incrementos durante el `await` |
| 💡 | `index.ts:19-25,51-58` | Handlers globales sin exit; SIGTERM sin drenar locks/flush |
| 💡 | `trading.ts:3417,3427` | `checkVix` sin timeout de fetch |
| 💡 | PM2/logs | error.log sin `log_date_format`; proceso vivo fuera del ecosystem (`max_memory_restart` inactivo) |
| 💡 | `smc_config.ts:63-74` | M5/W1 sin preset; `z_window` muerto; EUROPE50/JP225/NL25 en default |
| 💡 | `AlphaModel.ts:21-27,79` | TF 'W' sin peso/TTL/rank |

## Completado — Obj 3 (matemática/riesgo) y Obj 4 (ejecución cTrader)

### Obj 3 · rMultiple en cada camino de cierre — verificado en código

El cálculo de R está **correcto y ya pondera el parcial**:
- **TP2** (`trading.ts:1911-1917`): `finalPnlPct = tp1Hit ? (pnlTp1Pct·mgmtPartialT + pnlTp2Pct·(1−mgmtPartialT)) : pnlTp2Pct`, dividido por `initialSlLossPct` (SL **original**, `originalSlPrice ?? slPrice`). Ponderación por volumen correcta.
- **SL** (`trading.ts:2033-2034`): `finalPnlPct = isPartialClose ? (pnlTp1Pct·mgmtPartialT − currentSlLossPct·(1−mgmtPartialT)) : −currentSlLossPct`, mismo denominador original. La banda de racha (`NET_BE_EPS`, `:2069-2074`) y la clasificación BREAKEVEN/LOSS coherentes con `sanitizeRMultiple`.
- **Reconcile / finalize** (`trading.ts:233-251`): rMultiple **contra el SL estructural original**, con `computeRMultipleFromPnlUsd` (PnL USD real de TODOS los deals + lots reales + tasa usdjpy). Suma apertura+parciales+cierre con comisión y swap.
- `sanitizeRMultiple` (PortfolioModel) cubre NaN y valores absurdos; `FrictionModel` guarda `riskDistance≈0`; `tp2Cap` guarda `risk≤0`.

### N3 [🟡 Moderado] — `trading.ts:2033-2034` (y la racha `:2069+`) — el rMultiple del SL-hit usa el precio teórico del SL, no el fill real con slippage

**Problema**: cuando el bot detecta el SL por su propio loop (feed cruza `trade.slPrice`), calcula `finalPnlPct` con `trade.slPrice` y `pnlTp1Pct` **teóricos**. El fill real del SL suele ser peor (slippage en rollover/spikes, brecha de spread) y el TP1 parcial real lleva comisión. El camino exacto por deals (`finalizeClosedPositionFromDeals`) solo corre cuando el evento de cierre **no** llega tras 8 detecciones (`closeMissedCount>8`). En el caso normal el journal y la racha `store.consecutiveLosses` se alimentan del valor teórico.
**Impacto**: el killswitch diario y la racha **sub-estiman** las pérdidas por slippage en salidas por SL (justo las más costosas, −$133 medidos en rollover). Un SL de −1.0R teórico puede ser −1.4R real y contar como −1.0R.
**Solución**: en vivo, cuando la posición ya cerró, preferir `finalizeClosedPositionFromDeals` también en el path normal del SL (no solo en el fallback), o mínimamente comparar contra el `ctrader_real_pnl` que escribe el ExecutionEvent antes de publicar el rMultiple. No es urgente (el evento de cierre sí llega y el reconcile de huérfanos lo corrige después), pero conviene alinear.
**Verificación**: `grep -n "finalizeClosedPositionFromDeals" src/db/trading.ts` → el SL normal (`:2033`) no lo llama; comparar un SL con slippage real vs su `rMultiple` en journal.

### Obj 4 · Ejecución — verificado en código (sin hallazgos nuevos de nivel 🔴/🟠)

- ✅ **`ctraderToken.ts`**: TTL 30 días, renueva a <3 días, chequeo 12 h, retroceso de 6 h ante fallo, timeout 20 s, backup del `.env` antes de escribir, rota el refresh token y actualiza la config en memoria. Correcto.
- ✅ **`executeMarketOrder`** (`ctrader.ts:850-1157`): guardrail de riesgo (aborta si el volumen exacto < mínimo del broker, no fuerza el mínimo), redondeo a `stepVolume` + techo `maxVolume`, `MARKET_RANGE` con SL/TP atómico y cap de slippage adaptativo (`max(2×spread, 0.2 pip)`, techo `CTRADER_MAX_SLIPPAGE_PIPS`), fallback a `MARKET` **solo** ante rechazo limpio del server (no ante timeout → evita doble fill), confirmación de fill antes de tocar SL/TP, corrección del precio con el deal real, y chequeos de lado del SL/TP + spread vivo **antes** del broker.
- ✅ **`modifyStopLoss`** (`:1420-1473`): digits reales por symbolId, amend directo leyendo `errorCode`, verificación post-amend de que el broker refleja el SL.
- ✅ **`mapToCTraderSymbol` / digits / centavos**: la conversión lots↔centavos está corregida (1 lote forex = 10^7 centavos; `getLotSizeCents` por clase). `US500` respeta minVolume real (1 lote); `XAU` admite microlotes.

### E1 [🟡 Moderado] — `src/services/ctrader_confirmation.ts:178-244` — el confirmado manual no re-ejecuta los killswitches

**Problema**: `handleTradeCallback` (botón de Telegram) llama `executeMarketOrder` directamente. `executeMarketOrder` valida lado de SL/TP, spread vivo y máximo de posiciones, **pero no** el killswitch global/por activo ni la racha. La re-evaluación (`recheckKillswitchesBeforeExecution`, `trading.ts:4172`) corre solo ANTES de mandar la confirmación; entre el envío y el clic pueden pasar hasta 5 min (auto-reject) y en ese lapso puede dispararse el KS.
**Impacto**: en modo semi-automático (`autoTrading:false`) un operador que confirma tarde mete una orden con la cuenta ya bloqueada por `maxDailyLossR`. Hoy dormido (`autoTrading:true`), latente.
**Solución**: en `handleTradeCallback`, antes de `executeMarketOrder`, re-evaluar `evaluateGlobalKillswitch`/`evaluateAssetKillswitch` y abortar con mensaje si `isKilled` (o reusar el `recheckKillswitchesBeforeExecution`).
**Verificación**: `grep -n "handleTradeCallback\|executeMarketOrder" src/services/ctrader_confirmation.ts`; con KS activo, confirmar un trade → debe abortar con aviso.

### Queda marginal (fuera del núcleo, no bloquea)
- `ctrader.ts` reconexión: el `stateChange→disconnected` ya hace `process.exit(1)` (PM2 re-suscribe) — cubierto.
- `amendSltpChecked`/`verifyPositionProtection` internos: revisados; el único problema real (ráfaga de amends) está en `async.md`.
- Los hallazgos de ejecución ya reportados en `async.md` (SL-retry storm, `getOpenPositions→[]`, reconcile vs orden en vuelo, ghost) siguen vigentes y no se repiten acá.
