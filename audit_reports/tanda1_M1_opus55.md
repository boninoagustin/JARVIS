# Auditoría JARVIS — Tanda 1/5 · M1 Motor de trading — Informe (Claude Opus 5.5)

**Fecha**: 08-oct-2026 00:30–02:00 UTC · **Código auditado**: working tree de `/opt/JARVIS` (incluye cambios sin commitear en `src/engine`, `ctrader.ts`, `index.ts`). PM2 `JARVIS` online, uptime 2 días, ↺1026.
**Método**: lectura de código + estado vivo (Firestore `asset_configs`/`trade_journal`/`active_trades`, cola de 400 MB de `JARVIS-out.log` del 07-oct 11:00Z → 08-oct 00:35Z, `JARVIS-error.log`). Sin cambios en el repo; scripts temporales borrados.

> ⚠️ **Cobertura**: los 4 subagentes que iban a cubrir en paralelo los Objetivos 2-4 (async, matemática, `ctrader.ts`, motor SMC) fallaron por falta de créditos (HTTP 402) sin entregar nada. Este informe cubre **a fondo el Objetivo 1 (cadena de entrada) y el 5 (rollover)**, y **en parte** los 2 y 3. **El Objetivo 4 (`ctrader.ts`) y los internos del motor SMC (`smc/*`) quedan PENDIENTES** → re-correr como M1b cuando haya créditos.

---

## Veredicto: ¿por qué no opera / por qué opera hoy?

**El 05, 06 y 07-oct la cuenta quedó bloqueada temprano por el killswitch GLOBAL** (`asset_configs/GLOBAL.maxDailyLossR = 1.5`), y las pérdidas que lo dispararon vinieron de pares JPY que operaban con **config por defecto** porque su doc de Firestore no pasa el schema (hallazgo C1):

| Día FX (17:00 NY) | Trades cerrados | ΣR | Bloqueo |
|---|---|---|---|
| 04→05-oct | AUDJPY −0.94, GBPJPY −0.95 (22:06Z del domingo) | −1.89 | KS global todo el lunes 05 |
| 05→06-oct | USDJPY −1.05 (00:25Z), USDJPY −0.96 (03:05Z) | −2.01 | KS global desde 03:05Z |
| 06→07-oct | **GBPJPY** −0.95 (02:05Z), **GBPJPY** −1.03 (07:15Z) | −1.98 | KS global desde 07:15Z |

- **GBPJPY estaba APAGADO por el Paso 1 desde el 05-oct** (`enabled:false` + `disabledReason`) y aun así abrió 2 trades el 07-oct (WWUSQG, WHX5YB). Eso solo es posible si el bot no cargó su config → confirmado (C1).
- Después del bloqueo del 07-oct, el log muestra setups válidos frenados solo por el KS: CADJPY 15.5 pts, USOIL 22.5 y 27.25 pts, USDJPY 5.5/7.5 pts, GBPJPY 10.25 pts → `[GLOBAL KILLSWITCH] ⛔ ... IGNORADO`.
- **Ahora (08-oct 00:35Z)** arrancó un día FX nuevo: el KS se limpió, RAM con 0 trades, cTrader con 0 posiciones (`[RECONCILE] run: activeTrades=0 | posiciones abiertas en cTrader=0`). **El bot puede operar**, pero sigue con los 3 JPY en config por defecto y con 4 activos "fantasma" habilitados (C2).

En corto: **no es que el motor no genere señales. Opera activos que no tendría que operar, con reglas que no son las tuneadas, y esas pérdidas cierran la cuenta en el día.**

---

## OBJETIVO 1 — Cadena de entrada

### Valor vigente de cada gate (08-oct-2026)

| # | Gate | Vigente hoy | ¿Puede dar 0 trades? |
|---|---|---|---|
| 1 | cTrader → velas | 19 activos con streams (10 fijos `DEFAULT_SCANNER_TICKERS` + roster dinámico). `Nueva vela` 3.692 en 13 h | No |
| 2 | SMCEngine | No auditado en profundidad (subagente caído). Hay `RADAR 📡` y `SNIPER` → produce eventos | — |
| 3 | Scoring | `totalPoints` llega a 5.5–27 pts en los SNIPER de hoy | No |
| 4 | SMART | La lógica coincide con la spec (`trading.ts:3036-3062`): riesgo>1.5×ATR→OTE · clímax→OTE · (biasFresh off) · R:R≥1.5 o momentum (≥minPts+5)→directa · resto→OTE. Ojo: `rrChoch=3.0` por defecto sin zona opuesta | No |
| 5 | `resolveOteGate` / gate OTE | En SMART `enabled` se ignora (`AlphaModel.ts:353-355`); solo frena `minScore` (default 8 si falta la key) | No (es al revés: deja pasar de más, ver C2/M3) |
| 6 | FrictionModel | Spread base + pico 19 pips 20:29-21:15Z | Solo en la ventana de rollover |
| 7 | KS global / por activo | GLOBAL `maxDailyLossR=1.5`, resto 0 · por activo `maxConsecutiveLosses` 2-6, `maxDailyLossR` 0-1 | **SÍ — causa real del 05/06/07-oct** |
| 8 | Cooldown sniper | 180 s (default; `bot_config` solo tiene `autoTrading`) | No |
| 9 | ML | `mlGateEnabled` ausente en los 30 docs → gate OFF (solo telemetría) | No |
| 10 | LLM Gemini | `src/llm/client.ts:19-25` es un stub; solo lo usa `finnhub.ts` (noticias) y el agente. **No está en la cadena de entrada** | No |
| 11 | autoTrading / sessionEnabled | `bot_config.autoTrading=true` (global). `autoTrading` por activo **no se lee** (latente, ya conocido). `sessionEnabled = config.enabled` y **no mira `disabledReason`** | Solo si `enabled:false` |
| 12 | Doble umbral | **No hay doble puerta en serie.** Son 3 umbrales en paralelo: directa = `minScore` del gatillo, y si falta, el raíz `minPointsFor*` (`trading.ts:2833-2847`); re-validación tardía = raíz `minPointsFor*` (`:2532`); OTE = `minScore` del gatillo OTE (default 8). Raíz bajo: EUROPE50/NL25 `minPointsForSell=3`, AUDCAD `minPointsForBuy=3` | No (al revés: deja pasar ventas con 3 pts) |
| 13 | Config merge + listener | **Se pierden campos en silencio** (H3) y **un doc inválido se descarta entero** (C1) | Indirecto |

Activos que el bot considera habilitados en RAM: los 9 con `enabled:true` (AUDCAD, AUDJPY, EUROPE50, FRA40, JP225, NL25, USDJPY, USOIL, XAUUSD), **más 4 fantasma** (CADJPY, ITALY40, SPAIN35, XPTUSD) y **GBPJPY** (apagado en Firestore pero cae al fallback). AUDJPY y USDJPY operan con fallback, no con su config. La tabla de umbrales por gatillo y sesión está en `/root/audit_t1/gates_vigentes.txt`.

---

### [🔴 Crítico] — `src/engine/Types.ts:215-216` + `src/db/trading.ts:859-863` — listener `asset_configs` (schema Zod) + fallback de `getConfigForTicker` (`:782`)

**Problema**: en AUDJPY, USDJPY y GBPJPY, `sessions.ALL.maxSellLosses` y `maxBuyLosses` son **objetos** (`{atrTrailEnabled, partialClosePct, slAfterTp1, ...}`) cuando el schema espera `z.number()`. `safeParse` falla y el listener hace `console.warn` + `return`: **el doc entero se descarta** y el ticker no entra en `assetSessionConfigs`. `getConfigForTicker` cae entonces al fallback (`:782`): `sessionEnabled: true`, `entryTrigger: SMART`, `minPoints 5`, sin `sessions` → todos los gatillos directos encendidos con 5 pts y la OTE encendida con minScore 8 **en las 4 sesiones (OFF incluida)**, sin TimesFM, sin límites por activo y sin respetar `enabled:false`.
**Evidencia**: `JARVIS-error.log` tiene 741 `[CONFIG] Invalid data in asset_configs for AUDJPY|GBPJPY|USDJPY` con `sessions.ALL.{maxSellLosses,maxBuyLosses}`. El log de arranque dice `26 configs ... cargadas` y **los 3 JPY no aparecen** (en Firestore hay 29). Trades GBPJPY del 07-oct con el activo apagado desde el 05-oct.
**Impacto**: el Paso 1 de contención no aplica a GBPJPY. USDJPY y AUDJPY operan sin su tuning. Esas pérdidas dispararon el KS global 3 días seguidos. Ante cualquier campo mal tipado, el fallback **abre** el activo en vez de cerrarlo.
**Solución**:
(a) **Datos** (efecto inmediato vía `onSnapshot`, sin restart). Crear y correr `scripts/fix_jpy_sessions_all.mts`:
```ts
// One-shot (auditoría T1 oct-2026): borra sessions.ALL.maxSellLosses/maxBuyLosses NO numéricos.
const admin = (await import('firebase-admin')).default;
import fs from 'fs';
const key = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const TICKERS = ['AUDJPY', 'USDJPY', 'GBPJPY'];
const backup: Record<string, unknown> = {};
const plan: Record<string, Record<string, unknown>> = {};
for (const t of TICKERS) {
  const data = (await db.doc(`asset_configs/${t}`).get()).data() as any;
  backup[t] = data;
  const all = data?.sessions?.ALL ?? {};
  const upd: Record<string, unknown> = {};
  for (const f of ['maxSellLosses', 'maxBuyLosses']) if (all[f] !== undefined && typeof all[f] !== 'number') upd[`sessions.ALL.${f}`] = FV.delete();
  plan[t] = upd;
}
const bk = `/opt/JARVIS/backups/asset_configs_jpy_${Date.now()}.json`;
fs.writeFileSync(bk, JSON.stringify(backup, null, 1));
console.log('backup →', bk);
for (const t of TICKERS) {
  if (Object.keys(plan[t]).length) { await db.doc(`asset_configs/${t}`).update(plan[t]); console.log(t, 'corregido:', Object.keys(plan[t])); }
  else console.log(t, 'sin cambios');
}
process.exit(0);
```
`cd /opt/JARVIS && npx tsx scripts/fix_jpy_sessions_all.mts`
⚠️ Efecto operativo, a aprobar: **GBPJPY queda apagado de verdad** (Paso 1) y **AUDJPY/USDJPY pasan a operar con su config tuneada** (p. ej. USDJPY `minPointsForBuy=11` en la re-validación tardía, gatillos por sesión del dominical).

(b) **Código** (fail-closed; requiere `pm2 restart JARVIS`):
```diff
--- a/src/db/trading.ts
+++ b/src/db/trading.ts
@@ -754,3 +754,3 @@
             entryTrigger: config.entryTrigger ?? globalState.dynamicBotConfig.entryTrigger,
-            sessionEnabled: config.enabled ?? true,
+            sessionEnabled: (config.enabled ?? true) && !(config as any).disabledReason,
             maxSellsPerDay: config.maxSellsPerDay ?? 0,
@@ -781,2 +781,3 @@
-    // Fallback
-    return { ...globalState.dynamicBotConfig, sessionEnabled: true, maxSellsPerDay: 0, sellScorePenalty: 0, maxBuysPerDay: 0, buyScorePenalty: 0 };
+    // Fallback — 🛡️ FAIL-CLOSED: un ticker sin config válida NO opera con defaults.
+    return { ...globalState.dynamicBotConfig, sessionEnabled: false, maxSellsPerDay: 0, sellScorePenalty: 0, maxBuysPerDay: 0, buyScorePenalty: 0 };
@@ -786,1 +787,3 @@
 const unsubscribers: (() => void)[] = [];
+// 🛡️ Auditoría T1: aviso único por doc inválido
+const invalidConfigNotified = new Set<string>();
@@ -859,5 +860,16 @@
                 const parsed = AssetSessionConfigSchema.safeParse(doc.data());
                 if (!parsed.success) {
-                    console.warn(`[CONFIG] Invalid data in asset_configs for ${doc.id}:`, parsed.error.format());
+                    // 🛡️ FAIL-CLOSED: un doc inválido bloquea el activo (antes caía al fallback y operaba con defaults).
+                    console.error(`[CONFIG] ❌ asset_configs/${doc.id} INVÁLIDO → activo BLOQUEADO:`, JSON.stringify(parsed.error.format()));
+                    globalState.assetSessionConfigs.set(doc.id, {
+                        ...((globalState.assetSessionConfigs.get(doc.id) as any) ?? {}),
+                        enabled: false,
+                        disabledReason: 'CONFIG_INVALID (schema Zod) — ver JARVIS-error.log',
+                    } as any);
+                    if (!invalidConfigNotified.has(doc.id)) {
+                        invalidConfigNotified.add(doc.id);
+                        sendTelegramAlert(`🚨 <b>[CONFIG INVÁLIDA] ${doc.id}</b>\nasset_configs/${doc.id} no pasa el schema → activo BLOQUEADO hasta corregirlo.`).catch(() => { });
+                    }
                     return;
                 }
```
(`sendTelegramAlert` es una declaración de función de módulo, `:971`, y está hoisteada.)
**Verificación**: tras (a): `grep -a "configs por activo+sesión cargadas" ~/.pm2/logs/JARVIS-out.log | tail -1` tiene que mostrar 29 activos con AUDJPY, GBPJPY y USDJPY. Tras (b): `grep -c "Invalid data in asset_configs" ~/.pm2/logs/JARVIS-error.log` deja de crecer, y con un doc de prueba roto aparece `INVÁLIDO → activo BLOQUEADO` + Telegram. Además, que GBPJPY no vuelva a tener `[SNIPER] 🎯` con `Orden ejecutada`.
**Pendiente (tanda 4)**: identificar qué script escribió objetos en `sessions.ALL.max*Losses` (AUDJPY/USDJPY `source: directional_mcl_tune` 03-oct; GBPJPY `apply_weekly_losers` 05-oct). `directional_mcl_tune.ts` escribe números, así que el culpable es otro.

---

### [🔴 Crítico] — `src/db/trading.ts:872` — listener `asset_configs` (`enabled` por defecto) → activos fantasma operando

**Problema**: `enabled: data.enabled !== false` toma un `enabled` **ausente** como habilitado. CADJPY, ITALY40, SPAIN35 y XPTUSD tienen docs creados por `directional_mcl_tune` con solo claves de riesgo (sin `enabled`, sin `entryTrigger`, sin gatillos). En RAM quedan `enabled=true`, el roster dinámico (`:911-914`) los suscribe y la OTE dispara: sin key del gatillo → minScore 8 + override SMART (`AlphaModel.ts:353-355`). En ITALY40/SPAIN35, en las sesiones que faltan en el doc, también se encienden **todos los gatillos directos con 5 pts** (`trading.ts:2853-2858`).
**Evidencia**: arranque `Roster dinámico: 11 activo(s) nuevo(s) → AUDCAD, CADJPY, EUROPE50, FRA40, ITALY40, JP225, NL25, SPAIN35, USOIL, XAUUSD, XPTUSD`. 07-oct 13:20Z `triggerOte=true para CADJPY SELL. Puntos: 15.5` (lo frenó solo el KS global). Trade real CADJPY PP22N2 del 01-oct (adoptado, LOSS).
**Impacto**: el bot opera instrumentos que nadie habilitó, con defaults, y cada pérdida suma al KS global.
**Solución** (decisión de Bon: si alguno de los 4 tiene que operar, ponerle `enabled:true` explícito antes del cambio):
```diff
--- a/src/db/trading.ts
+++ b/src/db/trading.ts
@@ -872,1 +872,1 @@
-                    enabled: data.enabled !== false, // default enabled
+                    enabled: data.enabled === true, // 🛡️ opt-in explícito: docs sin 'enabled' (creados por scripts de tuning) NO operan
```
Contención inmediata, sin restart (merge en Firestore, un doc por ticker: `asset_configs/CADJPY`, `/ITALY40`, `/SPAIN35`, `/XPTUSD`):
```json
{ "enabled": false, "disabledReason": "no habilitado explícitamente — auditoría T1 08-oct-2026" }
```
Nota: `syncScannerRoster` solo **agrega** activos (`ctrader.ts:578-599`) y no desuscribe. El stream sigue hasta el restart, pero `sessionEnabled=false` bloquea en `dispatchOteSignal:3620` y en la ruta directa.
**Verificación**: después del restart, la línea `Roster dinámico:` ya no lista CADJPY/ITALY40/SPAIN35/XPTUSD, y `grep -a "SNIPER.*\(CADJPY\|ITALY40\|SPAIN35\|XPTUSD\)"` sobre el log nuevo da 0.

---

### [🟠 Alto] — `src/db/trading.ts:686-778` + `:865-901` — `getConfigForTicker` / listener: campos tuneados que se pierden en silencio (`zoneWeights`, `vwapPts`, `maxSmartRiskPercent`, `rolloverEntryBlock`)

**Problema**: `zoneWeightMultLive()` (`:676-683`, usado en `:2157` y `:2423`) lee `config.zoneWeights`, y la ruta VWAP (`:2725`) lee `config.vwapPts`. **Ni el listener ni el return de `getConfigForTicker` copian esos campos**, así que en vivo siempre valen 1 y 2. El backtest/hyperopt sí los usa (`backtestEngine.ts:1275` + 3 referencias a `zoneWeights`), y `apply_weekly` los escribe en Firestore: 7 activos activos tienen `zoneWeights` y `vwapPts=4-6`. Pasa lo mismo con `maxSmartRiskPercent` por activo (el listener lo copia y `getConfigForTicker` lo pisa con el global 0.15) y con `rolloverEntryBlock` (`:4185` lee `cfg.rolloverEntryBlock`, que nunca llega → la Regla C no se puede apagar por activo).
**Impacto**: el scoring vivo **no es el que validó el optimizador** en AUDJPY, EUROPE50, FRA40, JP225, NL25, USOIL y XAUUSD (VWAP vale 2 pts en vivo contra 6 en el backtest; las familias de zona no se ponderan).
**Solución** (alinea el vivo con lo que el backtest ya mide; pedir OK de Bon antes de desplegar):
```diff
--- a/src/db/trading.ts
+++ b/src/db/trading.ts
@@ -713,2 +713,7 @@
     /** 🛡️ sep-2026 Paso 1: confluencia de bias por activo (bono de alineación parametrizado) */
     biasConfluence?: BiasConfluenceConfig;
+    /** 🛡️ Auditoría T1: genes del hyperopt que antes se perdían en el merge */
+    zoneWeights?: Record<string, Record<string, number>>;
+    vwapPts?: number;
+    rolloverEntryBlock?: boolean;
+    disabledReason?: string;
@@ -776,2 +781,7 @@
             biasConfluence: (config as any).biasConfluence, // 🛡️ sep-2026 Paso 1: confluencia de bias por activo
+            zoneWeights: (config as any).zoneWeights,
+            vwapPts: (config as any).vwapPts,
+            maxSmartRiskPercent: (config as any).maxSmartRiskPercent ?? globalState.dynamicBotConfig.maxSmartRiskPercent,
+            rolloverEntryBlock: (config as any).rolloverEntryBlock,
+            disabledReason: (config as any).disabledReason,
             sessions: config.sessions as any
@@ -900,1 +910,3 @@
                     disabledReason: (data as any).disabledReason, // 🆕 27-sep-2026: retiro explícito (panel/optimizador) — el roster dinámico lo respeta
+                    zoneWeights: (data as any).zoneWeights,       // 🛡️ T1: Capa 1 del hyperopt (antes descartado)
+                    vwapPts: (data as any).vwapPts,               // 🛡️ T1: peso VWAP tuneado (antes descartado → siempre 2)
```
**Verificación**: un `_check.ts` temporal que importe el módulo y haga `console.log(getConfigForTicker('EUROPE50'))` (exportarlo de forma temporal o loguear en el arranque) tiene que mostrar `vwapPts: 6` y `zoneWeights.OB.LONDON: 2`. En vivo, los eventos `VWAP_Discount/Premium` de EUROPE50 suman 6 pts en el desglose del SNIPER.
**Regla para el futuro**: un campo nuevo en `asset_configs` se propaga por las 3 capas (doc → listener → return de `getConfigForTicker`). Mejor aún: reemplazar las dos listas explícitas por `{...data}` + defaults, porque el schema ya es `.passthrough()`.

---

### [🟡 Moderado] — `src/db/trading.ts:866-871` — el listener fija los defaults globales en el momento del snapshot (carrera con `bot_config`)

**Problema**: `minPointsForBuy: data.minPointsForBuy || global`, y lo mismo para `entryTrigger`, `slBufferPercent`, `fixedRR` y `oteEntryPercent`, guardan el default global **del momento del snapshot**. Los listeners `bot_config` (`:822`) y `asset_configs` (`:843`) no tienen orden garantizado al arrancar. Además, `||` no permite un 0 legítimo. Hoy no hace daño (`bot_config` solo tiene `autoTrading`), pero cambiar `bot_config.minPointsForBuy` no llega a los activos que no tienen el campo.
**Solución**: guardar el valor crudo; `getConfigForTicker` (`:749-754`) ya resuelve con `?? global`.
```diff
-                    minPointsForBuy: data.minPointsForBuy || globalState.dynamicBotConfig.minPointsForBuy,
-                    minPointsForSell: data.minPointsForSell || globalState.dynamicBotConfig.minPointsForSell,
-                    slBufferPercent: data.slBufferPercent !== undefined ? data.slBufferPercent : globalState.dynamicBotConfig.slBufferPercent,
-                    fixedRR: data.fixedRR !== undefined ? data.fixedRR : globalState.dynamicBotConfig.fixedRR,
-                    oteEntryPercent: data.oteEntryPercent !== undefined ? data.oteEntryPercent : globalState.dynamicBotConfig.oteEntryPercent,
-                    entryTrigger: data.entryTrigger || globalState.dynamicBotConfig.entryTrigger,
+                    minPointsForBuy: data.minPointsForBuy,   // crudo: getConfigForTicker resuelve '?? global' en cada llamada
+                    minPointsForSell: data.minPointsForSell,
+                    slBufferPercent: data.slBufferPercent,
+                    fixedRR: data.fixedRR,
+                    oteEntryPercent: data.oteEntryPercent,
+                    entryTrigger: data.entryTrigger,
```
**Verificación**: poner `app_settings/bot_config.minPointsForBuy=6` y comprobar que un activo sin `minPointsForBuy` propio lo toma sin restart (log del desglose del gatillo). Después revertir.

### [🟡 Moderado] — `src/db/trading.ts:999` vs `:2813` — la ruta OTE ignora el fallback `sessions.ALL` y la directa lo usa

**Problema**: `evaluateImpulse` usa `config.sessions?.[currentSession]` y la ruta directa usa `?? sessions['ALL']`. Si a un doc le falta una sesión, la OTE cae a `!sessionConfig` (enabled por `entryTrigger`, minScore 8) mientras la directa usa ALL. Hoy pega en ITALY40 (OFF) y SPAIN35 (ASIA/OFF), que son fantasma (C2).
**Solución**:
```diff
-    const sessionConfig = config.sessions?.[currentSession];
+    const sessionConfig = config.sessions?.[currentSession] ?? (config.sessions as any)?.['ALL'];
```
⚠️ `AlphaModel` es compartido con el backtest: verificar que `backtestEngine` resuelve la sesión igual antes de tocar (tanda 2).
**Verificación**: `grep -n "sessions?.\[currentSession\]" src/db/trading.ts` → todas las apariciones con `?? ...['ALL']`.

### [💡 Mejora] — configuración (no es bug de código): gatillos "apagados" que en SMART siguen vivos

Según `gates_vigentes.txt`, hay gatillos OTE con `enabled:false` y `minScore<99` que **operan** en SMART por diseño (la "doble llave"): AUDCAD NY `oteChoch15m` minScore 4; los `oteChoch15m/oteBos15m` de EUROPE50, FRA40 y NL25 (default 8); JP225 LONDON `oteBos5m` 12. Y con `minPointsForSell=3` (EUROPE50, NL25) los gatillos directos sin `minScore` entran con 3 pts. **No propongo cambiarlo sin backtest**: el backtest usa el mismo AlphaModel, así que los números validados ya los incluyen encendidos. Lo que falla es que el panel muestra OFF lo que en realidad está ON. Para que coincidan, aplicar la doble llave (`minScore:99`) con `apply_trigger_state.ts`, previa corrida A/B.

---

## OBJETIVO 2 — Concurrencia y asincronía (cobertura parcial)

### [🟠 Alto] — `src/db/trading.ts:1191-1201` — `processTradingAlert`: el lock por ticker no se libera en los `return` del Master Killswitch

**Problema**: el lock se toma en `:1130-1143` y solo se libera en el `finally` del `try` que empieza en `:1236`. Los dos `return` de `:1196` (`GLOBAL_SYSTEM` apagado) y `:1200` (killswitch individual) salen **antes** del `try` → `releaseLock` nunca se llama.
**Secuencia**: el operador apaga el bot desde el panel (`jarvis-os/src/App.tsx` escribe `killswitches.GLOBAL_SYSTEM`) → llega el primer PING de EURUSD → `return` sin liberar → todas las alertas siguientes de EURUSD quedan en `await previousLock` para siempre. Cuando el operador lo vuelve a encender, **ningún ticker que haya recibido una alerta durante el apagado vuelve a procesar nada hasta un restart**. La cadena de promesas pendientes crece 1/seg por ticker (fuga de memoria → `max_memory_restart`).
**Impacto**: inactividad total y silenciosa después de un apagado/encendido manual.
**Solución**:
```diff
--- a/src/db/trading.ts
+++ b/src/db/trading.ts
@@ -1194,3 +1194,4 @@
         } else {
             console.log(`[RADAR] 🚫 Alerta para ${ticker} ignorada debido a que el BOT GLOBAL está APAGADO.`);
+            releaseLock!(); // 🛡️ T1: sin esto el lock del ticker queda colgado (deadlock hasta restart)
             return;
         }
     } else if (store.globalKillswitches[ticker]) {
         console.log(`[RADAR] 🚫 Alerta para ${ticker} ignorada por killswitch individual activo.`);
+        releaseLock!();
         return;
     }
```
**Verificación** (estática): `awk 'NR>=1143 && NR<=1236 && /return/' src/db/trading.ts` → cada `return` tiene `releaseLock!()` en la línea anterior. (Funcional): con el bot en vivo, `killswitches.GLOBAL_SYSTEM=true` 1 minuto y después `false`; contar `[RADAR] 📡` por ticker en los 15 min siguientes (>0 en todos los que tienen stream).

### [🟠 Alto] — `src/db/trading.ts:1022-1025` vs `:3627…4200` — carrera set/delete en `active_trades` → trades fantasma en Firestore

**Problema**: `evaluateImpulse` persiste el trade **pre-creado** de la OTE con `db.collection('active_trades').doc(id).set(netTrade).catch(()=>{})` (sin `await`) **antes** de los killswitches. Cuando `dispatchOteSignal` rechaza (KS, warmup, TimesFM...), borra la RAM y manda `delete()`, también sin `await`. Son dos commits independientes sin orden garantizado: a veces el `set` llega después del `delete` y el doc queda.
**Evidencia**: hoy hay **7 docs en `active_trades` sin `ctraderPositionId`** (227FIT CADJPY, 746ZUT USDJPY, INISTM EUROPE50, IPMQZH NL25, PNEM33 USOIL, R6FZ4I AUDJPY, U73WGX CADJPY), con la RAM en 0 y cTrader en 0. PNEM33 y F4WJY5 (USOIL, 07-oct ~19:15Z) siguieron el **mismo camino** (`GLOBAL KILLSWITCH ⛔ IGNORADO`): uno se limpió y el otro quedó.
**Impacto**: en el próximo restart (`:790-792`) se rehidratan como trades activos reales. El barrido de huérfanos del reconciler (`:316-328`) solo los saca si tienen más de 2 h y solo después de la primera pasada (throttle de 5 min). Mientras tanto el gestor de TP/SL los evalúa (Telegram/journal fantasma posibles) y cuentan en `activeTrades.size`.
**Solución**: la persistencia real ya la hace el camino exitoso (`:4153-4154`, antes de ejecutar), así que la de `:1025` sobra:
```diff
--- a/src/db/trading.ts
+++ b/src/db/trading.ts
@@ -1022,4 +1022,5 @@
             // 💾 Sincronización en RAM y Firebase del trade modificado por fricción
             (netTrade as any).isBacktest = isBacktest;
             store.activeTrades.set(netTrade.tradeId, netTrade);
-            if (db && !netTrade.isBacktest) db.collection('active_trades').doc(netTrade.tradeId).set(netTrade).catch(() => { });
+            // 🛡️ T1: NO persistir el pre-trade (carrera con los delete() de dispatchOteSignal → fantasmas en Firestore).
+            // El camino exitoso persiste en dispatchOteSignal (L4154) antes de ejecutar.
```
Limpieza única de los 7 actuales (verificar antes con `[RECONCILE] run: ... posiciones abiertas en cTrader=0`): borrar `active_trades/{227FIT,746ZUT,INISTM,IPMQZH,PNEM33,R6FZ4I,U73WGX}`. Son todos docs sin `ctraderPositionId` ni `journalId`.
**Verificación**: después del deploy, con un día de KS activo, `active_trades` sin `ctraderPositionId` y con más de 10 min de antigüedad = 0 (script de lectura como `probe_journal.ts`).

### [🟡 Moderado] — `src/services/ctrader.ts:458` + `src/db/trading.ts:744` — volumen de log que hace inviable el diagnóstico

**Problema**: `JARVIS-out.log` pesa **14 GB** y no hay `pm2-logrotate` (`~/.pm2/module_conf.json` = `{}`). En la última cola de 400 MB, el **86 %** de las líneas es `[CTRADER-TB] 📊 Trendbars recibidos` (3,46 M de 4,04 M) y el 14 % es `[CONFIG] 📋 Usando config de` (554 k: se loguea en **cada** llamada a `getConfigForTicker`). Un `grep` sobre el archivo tarda 72 s. Además, `JARVIS-error.log` no se escribe desde el 06-oct 00:00 (mtime): revisar a dónde va stderr.
**Solución**:
```diff
--- a/src/services/ctrader.ts
+++ b/src/services/ctrader.ts
@@ -458,1 +458,1 @@
-                            console.log(`[CTRADER-TB] 📊 Trendbars recibidos: ${key} ×${newCandles.length} (${tsFirst} → ${tsLast})`);
+                            if (process.env.JARVIS_VERBOSE === '1') console.log(`[CTRADER-TB] 📊 Trendbars recibidos: ${key} ×${newCandles.length} (${tsFirst} → ${tsLast})`);
--- a/src/db/trading.ts
+++ b/src/db/trading.ts
@@ -744,1 +744,1 @@
-        console.log(`[CONFIG] 📋 Usando config de: ${ticker}`);
+        if (process.env.JARVIS_VERBOSE === '1') console.log(`[CONFIG] 📋 Usando config de: ${ticker}`);
```
Y `pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 500M && pm2 set pm2-logrotate:retain 10` (tanda 4).
**Verificación**: `ls -la ~/.pm2/logs/JARVIS-out.log` crece menos de 200 MB/día.

### Verificado sin hallazgo (o ya corregido)
- **API key de Finnhub**: en `src/` sale de `process.env.FINNHUB_API_KEY` (`finnhub.ts:53`, `macro_data.ts:8`, `trading.ts` checkVix). La copia de `jarvis-os/` corresponde a la tanda 3.
- **LLM**: stub; no bloquea entradas (gate 10).
- Listeners de `trading.ts` con `unsubscribe` en SIGTERM/SIGINT (`:919-924`). Un doc **borrado** de `asset_configs` no se quita de RAM (el listener itera `snap.forEach` sin `docChanges().removed`): 💡.

---

## OBJETIVO 3 — Precisión matemática (cobertura parcial)

### [🟡 Moderado] — `src/db/trading.ts:1328-1338` — `state.atr14` en vivo no es un ATR14 de velas

**Problema**: el ATR se actualiza en **cada PING** (hasta 1/seg/ticker) con el high/low de la vela M15 **en formación** (`SMCBridge.ts:213`, `TF: 15`). En la práctica es un Wilder de unos 14 segundos sobre el rango parcial de la vela: arranca en ~0 al abrir la barra y crece hasta el rango completo. El backtest (`backtestEngine.ts:565-573`) usa la misma fórmula pero sobre PINGs de velas cerradas de varios TF mezclados. **Ninguno de los dos es un ATR14 M15 canónico, y además no coinciden entre sí.**
**Impacto**: `atr14` alimenta TimesFM (`:3694`, umbrales `dirEpsAtr`/`spreadAtrHighConv` en unidades de ATR; `dryRun:false` en 7 activos), el trailing ATR (`:1794-1795`) y el trailing estructural (`:2313`). Los umbrales calibrados en backtest no se trasladan al vivo: un ATR vivo más chico infla `spreadAtr` (→ menos convicción, menos REJECT) y achica el trailing (corta ganadoras antes).
**Solución** (vivo; el equivalente en el backtest va en la tanda 2 y **cambia TimesFM → A/B antes de desplegar**):
```diff
--- a/src/db/trading.ts
+++ b/src/db/trading.ts
@@ -1330,9 +1330,17 @@
-            const prevClose = previousPrice ?? currentPrice;
-            const tr = Math.max(highPrice - lowPrice, Math.abs(highPrice - prevClose), Math.abs(lowPrice - prevClose));
-            if (state.atr14 === undefined) {
-                state.atrSeed = (state.atrSeed ?? 0) + tr;
-                state.atrSamples = (state.atrSamples ?? 0) + 1;
-                if (state.atrSamples >= 14) state.atr14 = state.atrSeed / 14; // SMA de arranque
-            } else {
-                state.atr14 = (state.atr14 * 13 + tr) / 14; // suavizado de Wilder
-            }
+            // 🛡️ T1: ATR14 sobre velas M15 CERRADAS (avanza solo cuando cambia la vela cerrada del PING).
+            if (prevHighPrice !== undefined && prevLowPrice !== undefined) {
+                const barKey = `${prevHighPrice}|${prevLowPrice}`;
+                if ((state as any).atrBarKey !== barKey) {
+                    const ref = (state as any).atrPrevClosedClose ?? previousPrice ?? currentPrice; // close de la vela t-1
+                    const tr = Math.max(prevHighPrice - prevLowPrice, Math.abs(prevHighPrice - ref), Math.abs(prevLowPrice - ref));
+                    (state as any).atrBarKey = barKey;
+                    (state as any).atrPrevClosedClose = previousPrice ?? currentPrice; // ≈ close de la vela que acaba de cerrar
+                    if (state.atr14 === undefined) {
+                        state.atrSeed = (state.atrSeed ?? 0) + tr;
+                        state.atrSamples = (state.atrSamples ?? 0) + 1;
+                        if (state.atrSamples >= 14) state.atr14 = state.atrSeed / 14;
+                    } else {
+                        state.atr14 = (state.atr14 * 13 + tr) / 14;
+                    }
+                }
+            }
```
Trade-off: tras un restart, el ATR tarda 14 velas M15 (3,5 h) en sembrarse. Mientras tanto TimesFM entra en modo degradado y aprueba (`'DEGRADADO: ATR no inicializado'`).
**Verificación**: loguear `atr14` en el `[TIMESFM]` y comparar contra el ATR14 M15 de `logs/<t>/history/history_M15.csv` de la misma hora (±10 %).

### Verificado sin hallazgo
- **R:R con `riskDistance === 0`**: corregido. `FrictionModel.ts:131-138` rechaza si `grossRiskDistance <= max(EPS, 0.5·pip)`; `computeRMultiple` (`:69-80`) cubre `e===s` y `riskUsd<=0`; `tp2Cap.ts:45` tiene `if (risk <= 0) return tp2`.
- **rMultiple asumido** (1.5/−1.0): solo como fallback de `sanitizeRMultiple` cuando el valor guardado es inválido (`PortfolioModel.ts:106-116`). Aceptable; los docs con `result:null` quedan afuera.
- **Reset diario**: `getFxDayStartMs` es DST-aware (17:00 NY). Ojo: el prompt dice "día FX 17:00 ART", pero el código usa **17:00 New York** = 18:00 ART en verano boreal y **19:00 ART desde el 01-nov**.
- 💡 `FrictionModel.ts:124-126`: convierte la comisión con "$10 = 1 pip" para todos los activos (mal para índices/JP225/XAU/USOIL). Es igual en vivo y backtest, así que no rompe la paridad; sí distorsiona el R:R neto de los no-FX.

---

## OBJETIVO 4 — Ejecución (`ctrader.ts`) — PENDIENTE
Sin auditar en profundidad (subagente caído por créditos). Solo hay dos observaciones:
- [🟡] `ctrader.ts:578-599` `syncScannerRoster` solo agrega y nunca desuscribe. En el arranque corre **en paralelo** con `initializeScanner` (que todavía no marcó `scannerProcessed`): AUDCAD, JP225 y XAUUSD aparecen en ambas listas → posible doble suscripción de trendbars por activo (el resultado fue "19 activos con streams" para 10 + 11 pedidos). Verificar si duplica velas en `SMCManager`.
- [💡] `ghost_positions/284799955` (USDJPY, 24-ago) sigue `UNPROTECTED`, con cTrader en 0 posiciones → marcar `status:"RESOLVED"`.

## OBJETIVO 5 — Rollover

### [🟠 Alto] — `src/db/trading.ts:3217-3218, 3299-3300, 3358-3359, 3580-3585` + `src/engine/FrictionModel.ts:100-105` — ventanas de rollover fijas en UTC; el broker se corre a 22:00 UTC el **01-nov-2026**

**Problema**: las Reglas A (20:20-20:28Z), D (ensanchar 20:25-20:28Z, restaurar 21:15-21:25Z) y C (bloquear entradas 20:29-21:30Z), y el pico de spread de FrictionModel (20:29-21:15Z), están fijadas en UTC. El cierre del broker es **17:00 New York**: los D1 de `logs/eurusd/history/history_D1.csv` abren a **22:00 UTC de enero a marzo** y a 21:00 UTC desde la entrada del DST (08-mar). El DST de EE.UU. termina el **domingo 01-nov-2026**.
**Impacto desde el 02-nov**: el feed va a morir 21:29→22:00Z. La Regla D **restaura el SL ensanchado a las 21:15Z, justo antes del hueco real**, así que queda anulada (y ensancha en plena liquidez, sumando riesgo). La Regla C deja pasar la reapertura real (22:00-22:30Z), lo que repite el incidente GBPJPY del 10-sep. La A mueve a BE 1 h antes de tiempo. El backtest también aplica el pico de spread en la hora equivocada para los datos de invierno.
**Solución**: un helper DST-aware y todas las ventanas expresadas en minutos relativos al cierre NY. Lo probé con `npx tsx` (función real `getFxDayStartMs`): 07-oct 20:29Z → −31 · 04-nov 21:29Z → −31 · 04-nov 22:30Z → +30 · NaN → NaN.
```diff
--- a/src/engine/PortfolioModel.ts
+++ b/src/engine/PortfolioModel.ts
@@ (después del cierre de getFxDayStartMs)
+/** Minutos con signo respecto del cierre diario del broker (17:00 New York, DST-aware).
+ *  <0 antes del cierre, >=0 después. Verano (EDT) cierre=21:00 UTC; invierno (EST) 22:00 UTC. */
+export function minutesFromFxRollover(nowMs: number): number {
+    if (!Number.isFinite(nowMs)) return NaN;
+    const sinceLast = (nowMs - getFxDayStartMs(nowMs)) / 60000;
+    if (sinceLast < 720) return sinceLast;
+    return (nowMs - getFxDayStartMs(nowMs + 13 * 3600 * 1000)) / 60000;
+}
--- a/src/engine/FrictionModel.ts
+++ b/src/engine/FrictionModel.ts
@@ -2,1 +2,2 @@
 import { getDecimals } from './AlphaModel.js';
+import { minutesFromFxRollover } from './PortfolioModel.js';
@@ -101,3 +102,2 @@
-        const _d = new Date(nowMs);
-        const minutesUTC = _d.getUTCHours() * 60 + _d.getUTCMinutes();
-        if (minutesUTC >= 20 * 60 + 29 && minutesUTC < 21 * 60 + 15) {
+        const mRoll = minutesFromFxRollover(nowMs); // 🛡️ T1: DST-aware (17:00 NY)
+        if (mRoll >= -31 && mRoll < 15) {
--- a/src/db/trading.ts
+++ b/src/db/trading.ts
@@ -33,1 +33,1 @@
-    evaluateGlobalRisk, evaluateAssetRisk, getFxDayStartMs, countDailySellsForTicker as pmCountDailySells, countDailyBuysForTicker as pmCountDailyBuys, countConsecutiveLossesForAsset
+    evaluateGlobalRisk, evaluateAssetRisk, getFxDayStartMs, minutesFromFxRollover, countDailySellsForTicker as pmCountDailySells, countDailyBuysForTicker as pmCountDailyBuys, countConsecutiveLossesForAsset
@@ -3217,2 +3217,2 @@  (applyRolloverProtection — Regla A)
-    const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
-    if (minOfDay < ROLLOVER_BE_START_MIN_UTC || minOfDay >= ROLLOVER_BE_END_MIN_UTC) return;
+    const mRoll = minutesFromFxRollover(nowMs);   // 🛡️ T1: −40..−32 = 20:20-20:28Z verano / 21:20-21:28Z invierno
+    if (!(mRoll >= -40 && mRoll < -32)) return;
@@ -3299,2 +3299,2 @@  (applyRolloverWiden — Regla D)
-    const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
-    if (minOfDay < 20 * 60 + 25 || minOfDay >= ROLLOVER_BE_END_MIN_UTC) return; // 20:25-20:28 UTC
+    const mRoll = minutesFromFxRollover(nowMs);   // 🛡️ T1: −35..−32 respecto del cierre NY
+    if (!(mRoll >= -35 && mRoll < -32)) return;
@@ -3357,3 +3357,2 @@  (applyRolloverRestore — Regla D)
-    const d = new Date(nowMs);
-    const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
-    if (!force && (minOfDay < 21 * 60 + 15 || minOfDay >= 21 * 60 + 25)) return; // 21:15-21:25 UTC
+    const mRoll = minutesFromFxRollover(nowMs);   // 🛡️ T1: +15..+25 respecto del cierre NY
+    if (!force && !(mRoll >= 15 && mRoll < 25)) return;
@@ -3580,6 +3580,6 @@  (isRolloverEntryWindow — Regla C)
 function isRolloverEntryWindow(nowMs: number): boolean {
     const d = new Date(nowMs);
     const dow = d.getUTCDay();
-    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
-    return dow >= 1 && dow <= 5 && mins >= 20 * 60 + 29 && mins <= 21 * 60 + 30;
+    const mRoll = minutesFromFxRollover(nowMs);   // 🛡️ T1: −31..+30 (feed muerto + pico + residuo), DST-aware
+    return dow >= 1 && dow <= 5 && mRoll >= -31 && mRoll < 31;
 }
```
(Si `d` deja de usarse en `applyRolloverProtection`/`applyRolloverWiden`, conservarlo: ahí se usa para el chequeo de día hábil y `dayKey`. Las constantes `ROLLOVER_BE_*_MIN_UTC` quedan sin uso; actualizar también el texto del log de arranque `:3486`.)
**Verificación**: `npx tsx` con una fecha de noviembre: `isRolloverEntryWindow(Date.parse('2026-11-04T21:45:00Z'))` → `true`, y `...('2026-11-04T20:45:00Z')` → `false`. `evaluateNetTrade` con `nowMs` = 04-nov 21:45Z → `Spread: 19.00 pips`. El backtest de los meses ene-mar mueve el pico a 21:29-22:15Z.

### Lógica A/C/D en verano: correcta
- **A**: solo días hábiles, solo con posición real (`ctraderPositionId`), solo si el SL mejora, una vez por trade y por día; usa `state.lastPrice` del radar.
- **D**: la persistencia en Firestore + `applyRolloverRestore(now, true)` al arrancar cubre un restart dentro de la ventana.
- **C**: está en `recheckKillswitchesBeforeExecution` (punto TOCTOU-safe).
- La Regla C no se puede apagar por activo (el flag no llega; ver H3). Falla del lado seguro.
- 💡 Los textos de Telegram del KS dicen "reseteo a medianoche ART" (`:1049`, `:1083`), pero el reset es a las 17:00 NY (18:00 ART hoy, 19:00 ART desde el 01-nov). Corregir el texto.

---

## Sección ejecutiva — cambios de mayor impacto (quick win primero)

1. **Contención por datos (ya mismo, sin restart, ~5 min)**: correr `fix_jpy_sessions_all.mts` (C1-a) y escribir `{"enabled":false,"disabledReason":...}` en CADJPY/ITALY40/SPAIN35/XPTUSD (C2). Con eso GBPJPY queda apagado de verdad, AUDJPY/USDJPY toman su config tuneada y los 4 fantasma dejan de operar. Borrar los 7 `active_trades` fantasma antes del próximo restart.
2. **Fail-closed en la config (código, 4 líneas + bloque)**: C1-b + C2 (`enabled === true`, fallback `sessionEnabled:false`, `disabledReason` en `sessionEnabled`). Así ningún error de datos vuelve a abrir un activo.
3. **Lock leak + carrera de `active_trades`** (H-async, 3 líneas): elimina un deadlock silencioso que se dispara desde el panel y el origen de los trades fantasma.
4. **Rollover DST-aware antes del 01-nov-2026** (H-rollover): si no, las reglas C/D quedan desfasadas 1 h justo en el horario del incidente del 10-sep.
5. **Propagar `zoneWeights`/`vwapPts`** (H3): el vivo vuelve a puntuar como el optimizador validó. Requiere OK de Bon: cambia el scoring vivo de 7 activos.

**Decisión de gestión (no es bug)**: con 9-13 activos operando al 1 % y `GLOBAL.maxDailyLossR=1.5`, **dos SL seguidos cierran el día** (pasó 3 días consecutivos). Si 1.5R es regla de la prop firm, se queda. Si no, evaluarlo con backtest de portafolio. No propongo cambiarlo sin datos.

---

## RESUMEN PARA CONSOLIDACIÓN

| severidad | archivo:línea | descripción |
|---|---|---|
| 🔴 | `Types.ts:215-216` + `trading.ts:859-863,782` | Doc `asset_configs` con un campo mal tipado se descarta entero → fallback opera con defaults; AUDJPY/USDJPY/GBPJPY (GBPJPY apagado por Paso 1 igual operó; KS global 05/06/07-oct) |
| 🔴 | `trading.ts:872` | `enabled` ausente = habilitado → CADJPY/ITALY40/SPAIN35/XPTUSD en roster y operando (OTE minScore 8 por override SMART) |
| 🟠 | `trading.ts:1191-1201` | `return` antes del `try` no libera el lock del ticker → deadlock por ticker tras usar el Master Killswitch + fuga de promesas |
| 🟠 | `trading.ts:1025` | Pre-trade OTE persistido fire-and-forget compite con los `delete()` de dispatch → 7 `active_trades` fantasma hoy, se rehidratan al restart |
| 🟠 | `trading.ts:686-778,865-901` | `zoneWeights`/`vwapPts`/`maxSmartRiskPercent`/`rolloverEntryBlock` no se propagan → scoring vivo ≠ optimizador (7 activos) |
| 🟠 | `trading.ts:3217,3299,3358,3580` + `FrictionModel.ts:100-105` | Ventanas de rollover fijas en UTC; el broker pasa a 22:00 UTC el 01-nov-2026 → Reglas C/D y pico de spread desfasados 1 h |
| 🟡 | `trading.ts:866-871` | El listener fija los defaults globales en el snapshot (carrera con `bot_config`; `||` impide 0) |
| 🟡 | `trading.ts:999` vs `:2813` | La ruta OTE no usa el fallback `sessions.ALL` y la directa sí |
| 🟡 | `trading.ts:1328-1338` | `atr14` vivo = rango parcial de la M15 en formación (≠ backtest) → TimesFM/trailing descalibrados |
| 🟡 | `ctrader.ts:458` + `trading.ts:744` | Logs: 86 % trendbars + 14 % "Usando config" → out.log de 14 GB, sin logrotate; error.log quieto desde el 06-oct |
| 🟡 | `ctrader.ts:578-599` | `syncScannerRoster` en paralelo con `initializeScanner` → posible doble suscripción; nunca desuscribe (sin verificar) |
| 💡 | Firestore `asset_configs` | Gatillos OTE `enabled:false` con minScore<99 siguen vivos en SMART (el panel muestra OFF); `minPointsForSell=3` como fallback en EUROPE50/NL25 |
| 💡 | `trading.ts:1049,1083` | Telegram dice "reseteo medianoche ART"; el real es 17:00 NY (18:00/19:00 ART) |
| 💡 | `trading.ts:843-917` | Un doc borrado de `asset_configs` no sale de RAM (sin `docChanges().removed`) |
| 💡 | `FrictionModel.ts:124-126` | Comisión convertida con "$10=1 pip" para todos los activos |
| 💡 | Firestore `ghost_positions/284799955` | UNPROTECTED desde 24-ago con 0 posiciones en cTrader → marcar RESOLVED |
| ⏳ | `ctrader.ts`, `smc/*`, `PortfolioModel.ts` (detalle) | **PENDIENTE**: Objetivo 4 y motor SMC sin auditar (subagentes caídos por créditos) |

Artefactos: `/root/audit_t1/firestore_dump.json` (snapshot de config 08-oct), `/root/audit_t1/gates_vigentes.txt` (umbral efectivo por activo × sesión × gatillo).
