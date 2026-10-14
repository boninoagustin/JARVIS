# Auditoría JARVIS — Tanda 4/5 · M4 Scripts de operación (dominical + TimesFM + pipeline)

**08-oct-2026**. Consolidación de dos subagentes (completos) + verificación en código de los 🔴. Crudos: `/root/audit_t4/dominical.md` y `/root/audit_t4/pipeline.md`.

## Cobertura
| Obj | Estado |
|---|---|
| 1 · Optimizador dominical | ✅ completo |
| 2 · TimesFM | ✅ completo |
| 3 · Pipeline de datos | ✅ completo |
| 4 · m1_backtest | ✅ completo |

---

## 🚨 Hallazgo 🔴 de mayor impacto (verificado en código)

### [🔴 Crítico] — `run_weekly.py:772,785` + `killswitch_tune.ts:135` + `directional_mcl_tune.ts:136` — el "congelado" NO congela todo: killswitch sweep y MCL direccional **siguen auto-aplicando a Firestore cada sábado**
**Problema**: `AUTO_APPLY_ENABLED=False` (L86) solo gatea el **paso 9** (`apply_weekly.ts`, L900). Pero el paso 3 (`run_ks_sweep`, L770-772, comentario "siempre") y el paso 3.1 (`run_directional_mcl_sweep`, L782-785, comentario "APLICA igual que el KS sweep") corren **fuera** del gate. Ambos escriben a Firestore: `killswitch_tune.ts:135` hace `.set({...source:'killswitch_tune'})` y `directional_mcl_tune.ts:136` hace `.update()` con dot-paths (`source='directional_mcl_tune'`). Además `tf_sweep_weekly.ts:95` hace `pm2 restart JARVIS --update-env`.
**Impacto**: Bon cree que el optimizador está "congelado" desde el 05-oct, pero los límites de killswitch (`maxDailyLossR`/`maxConsecutiveLosses`) y los `maxBuyLosses`/`maxSellLosses` direccionales **se siguen reescribiendo todos los sábados**, y el bot se puede reiniciar. Es exactamente el tipo de escritura que el "plan Paso 1" quería pausar.
**Solución**: envolver los pasos 3 y 3.1 (y el tf_sweep) en el mismo `if AUTO_APPLY_ENABLED:` (o en un flag propio `KS_APPLY_ENABLED` que hoy sea `False`):
```diff
--- a/scripts/periodic_opt/run_weekly.py
+++ b/scripts/periodic_opt/run_weekly.py
@@ -770,7 +770,8 @@
-            # 3. Killswitch sweep (siempre, es barato relativo y no depende del OOS)
+            # 3. Killswitch sweep — respeta el congelado: SOLO aplica si AUTO_APPLY_ENABLED
             try:
-                ks = run_ks_sweep(ticker)
+                ks = run_ks_sweep(ticker, apply=AUTO_APPLY_ENABLED)
@@ -785,1 +785,1 @@
-                dm = run_directional_mcl_sweep(ticker)
+                dm = run_directional_mcl_sweep(ticker, apply=AUTO_APPLY_ENABLED)
```
(y en `killswitch_tune.ts`/`directional_mcl_tune.ts` aceptar `--dry-run` que solo imprima la propuesta sin escribir).
**Verificación**: `grep -n "run_ks_sweep\|run_directional_mcl_sweep\|AUTO_APPLY_ENABLED" run_weekly.py` → ambos pasos quedan dentro del gate. Correr con `AUTO_APPLY_ENABLED=False` y confirmar que `asset_configs` no cambia de `source`.

### [🔴 Crítico] — `apply_weekly.ts:146-148,280` — auto-disable **irreversible**
**Problema**: `apply_weekly.ts:280` escribe `disabledReason="auto-disable:…"` al deshabilitar un activo (HOLD_MC×2→OFF), pero la auto-activación (`:146-148`) trata **cualquier** `disabledReason` como retiro manual y nunca re-habilita. Hoy `apply_weekly.ts` no corre (gateado), pero es una bomba para cuando Bon re-active `AUTO_APPLY_ENABLED=True`.
**Impacto**: un activo deshabilitado automáticamente nunca se recupera solo; queda fuera del roster para siempre salvo intervención manual.
**Solución**: distinguir el `disabledReason` auto (`auto-disable:` / `auto-disable-recoverable`) del manual, y permitir que la auto-activación lo limpie.
**Verificación**: `grep -n "disabledReason\|auto-disable" apply_weekly.ts` → el check de re-activación debe admitir el prefijo auto.

---

## 🟠 Altos

### [🟠 Alto] — `apply_weekly.ts:232` — apaga gatillos con `enabled:true + minScore:99`, no la "doble llave"
**Problema**: al apagar un gatillo perdedor escribe `enabled:true` + `minScore:99` en vez de `enabled:false + minScore:99` (la doble llave documentada). El script canónico `apply_trigger_state.ts` **sí** usa la doble llave pero está **huérfano** (nada lo invoca).
**Impacto**: el gatillo queda `enabled:true` → el panel lo muestra encendido y el optimizador futuro puede re-encontrarlo como habilitado. (Mismo vicio que el PeriodicOptPanel de la T3.)
**Solución**: unificar en `enabled:false + minScore:99` y enganchar `apply_trigger_state.ts` en vez del bloque ad-hoc.
**Verificación**: `grep -n "minScore: 99\|minScore:99" apply_weekly.ts`.

### [🟠 Alto] — `run_weekly.py` systemd fuente vs instalado desincronizados
**Problema**: repo `jarvis-periodic-opt.timer` = `Sun 02:00` + 2 ExecStartPost + `TimeoutStartSec=12h` + sin `OnFailure`; instalado = `Sat 06:00 CEST` + 14 ExecStartPost + `TimeoutStartSec=28h` + `OnFailure` + `MemoryMax`. La hora real es **sáb 06:00 CEST** (correcta, TZ Europe/Berlin confirmada con NTP activo), pero el archivo fuente del repo quedó en una versión vieja.
**Impacto**: un redeploy desde el repo revierte a la versión débil (sin OnFailure, timeout 12h, hora corrida a domingo).
**Solución**: sincronizar el `.service`/`.timer` del repo con el instalado (`systemctl cat` → escribir el fuente igual).
**Verificación**: `diff <(systemctl cat jarvis-periodic-opt.timer) scripts/periodic_opt/jarvis-periodic-opt.timer`.

### [🟠 Alto] — `smc_tf_sweep.ts:140-203` — bruteforcer de bloques TF sin OOS, auto-aplicado + reinicio
**Problema**: optimiza in-sample y auto-aplica al preset + `pm2 restart JARVIS` (hereda el vicio del T2: overfit in-sample). `BRUTEFORCER_ENABLED=False` en run_weekly.py, pero `tf_sweep_weekly.ts` (que sí corre) invoca `smc_tf_sweep.ts` y reinicia el bot.
**Solución**: agregar validación OOS al sweep, o desactivar el auto-apply del preset TF hasta tener OOS.
**Verificación**: `grep -n "pm2 restart\|OOS\|in-sample" tf_sweep_weekly.ts smc_tf_sweep.ts`.

## 🟡 Moderados (dominical)
- frescura con `pageSize=400` sin paginación (subconteo de trades → skips erróneos).
- hyperopt degradado (sin filtro TimesFM/overlay) aún puede RECOMMEND.
- `REFRESH_ERROR` sale con exit 0 (sin Telegram).
- `triggers15m` siempre null (bug de clave `sesión|trigger`).
- `loser_triggers` con tickers hardcodeados (11 vs 29 reales) + costos cero.
- `train_ml_weekly` corre 2× con listas distintas; "accuracy OOS" del ML es split random 80/20, no walk-forward.

## 💡 Mejoras (dominical)
- credenciales inconsistentes (`service-account.json` vs `firebase-key.json`).
- snapshot `prev_*` por fecha (un re-run pisa el rollback).
- sesión de sizing hardcodeada UTC-3.

## Veredicto Objetivo 1 (reglas declaradas vs código)
RECOMMEND+MC≥0.80 ✅ · respeta disabledReason ✅ (salvo bug 🔴 #2) · HOLD_MC×2→OFF *distinto* (exige además OOS<0) · rollback>0.10R/t ✅ · loser n≥8/±0.15 ✅ · sizing≥0.85 ✅ · Scout→active_tickers ✅ · ventana 84d ✅ · MIN_N=8 ✅ · **doble llave implementada distinto** 🟠. **Frontera**: optimizador tunea `sessions.{sesión}.{gatillo}` (enabled/entryPercent/minScore/slBuff/tp2/gestión) + campos nivel-activo; hardcodeado `entryTrigger='SMART'` y bloques TF del preset.

---

## TimesFM (Objetivo 2)
- 🟡 **Fail-open correcto pero sin alarma**: toda degradación (bridge caído/timeout/stale) → `APPROVE riskMult=1.0` (coherente con "nunca frenar"); si el puente muere, el filtro direccional desaparece en silencio (solo JSONL, sin Telegram/watchdog).
- 🟡 **Convención de timestamp mixta** (`timesfm_bridge.py:230` apertura vs export cierre): la edad del forecast se sobreestima ~1 TF → degrada antes de tiempo.
- 🟡 **`enable_shadow.js:47-49`** `set({timesfm:{...}},{merge:true})` reemplaza todo el subdocumento → borra overrides calibrados por ticker.
- 💡 `calibrate_f0.py` versiona `timesfm_pkg:"2.0.2"` hardcodeado sin git SHA.
- ✅ Bridge maneja caídas (systemd Restart=always + MemoryMax=2G), serializa inferencia, shadow aislado del lado de trading.

## Pipeline de datos (Objetivo 3)
- 🟠 **Paridad vivo↔export rota en divergencias**: export emite zonas `SMC_DIV` + `EVENTO_SMC_DIV` con score real; el vivo omite las zonas de divergencia y hardcodea `Score:4`. El backtest ve zonas que el vivo nunca ve.
- 🟠 **Export omite `| {ticker} |`** presente en todo mensaje vivo → CSV no es réplica 1:1 (el parser del backtest lo tolera, pero el `PING_RE` del bridge está acoplado al formato sin ticker).
- 🟡 `fetch_history.ts` dedupe **favorece lo viejo** (el solape anti-republicación de 24h no corrige nada) y **sin detección de gaps**.
- 🟡 **Frescura**: refresh semanal (sáb 06:00); si `fetch_history` falla solo imprime warning (no aborta) y el gate es **OR** (con ≥20 trades nuevos corre hyperopt con velas congeladas).
- 🟡 Medallas de breaker (`GOD_BRK` vs `GOD`) y HEARTBEAT `zoneCount` (divZones vs FVGs; capa 2 no 5) divergen.
- ✅ Formato CSV `Fecha,Mensaje` **matchea** a los consumidores (backtestEngine, collect_triggers, worker).

## m1_backtest (Objetivo 4)
- 🟠 **Orden intra-barra optimista** (TP2>TP1>SL) + flag `slHit` desfasado (calcula con SL original, aplica tras mover a midpoint → acredita TP1 y cierra LOSS en el mismo tick).
- 🟠 **NO es el backtest de validación**: entradas simuladas (sin OTE/sweeps/killswitch/fricción/TimesFM); el "bueno" es `backtestEngine.ts`.
- 💡 dead code `dist` + doc "por CHoCH" vs código "por BOS inverso".

---

## Sección ejecutiva (qué automatización está más rota AHORA)
1. **El "congelado" no congela** (🔴): killswitch sweep y MCL direccional reescriben Firestore cada sábado y tf_sweep reinicia el bot. Es lo primero a corregir — es una cuestión de seguridad de dinero real.
2. **Auto-disable irreversible** (🔴, latente): para antes de re-activar `AUTO_APPLY_ENABLED`.
3. **Paridad vivo↔export rota** (🟠): el backtest/hyperopt ve zonas de divergencia y score real que el vivo no emite → métricas OOS no 1:1 con producción.
4. **Doble llave inconsistente en toda la cadena** (🟠 apply_weekly + 🟠 PeriodicOptPanel de T3): apagar un gatillo no lo apaga del todo.
5. **Frescura OR + fetch que no aborta** (🟡): un fetch fallido + actividad normal ⇒ optimizador tunea sobre precios viejos sin alarma.

## RESUMEN PARA CONSOLIDACIÓN
| severidad | archivo:línea | descripción |
|---|---|---|
| 🔴 | `run_weekly.py:772,785` + `killswitch_tune.ts:135` + `directional_mcl_tune.ts:136` | El congelado solo gatea apply_weekly; KS sweep y MCL direccional auto-aplican a Firestore cada sábado |
| 🔴 | `apply_weekly.ts:146-148,280` | Auto-disable escribe disabledReason y la auto-activación lo trata como retiro manual (irreversible) |
| 🟠 | `apply_weekly.ts:232` | Apaga gatillos con enabled:true+minScore:99, no la doble llave; apply_trigger_state.ts huérfano |
| 🟠 | `jarvis-periodic-opt.timer/.service` (repo) | Fuente desincronizado del instalado (Sun 02:00/12h vs Sat 06:00/28h/OnFailure/MemoryMax) |
| 🟠 | `smc_tf_sweep.ts:140-203` | Bruteforcer TF sin OOS, auto-aplicado + pm2 restart |
| 🟠 | `export_smc_csv.ts:156-169,378-381` | Divergencias: export emite SMC_DIV + score real; vivo omite zonas y hardcodea Score:4 |
| 🟠 | `export_smc_csv.ts:364,400` vs `SMCBridge.ts:98,195,213` | Export omite `\| {ticker} \|` presente en el vivo |
| 🟠 | `m1_backtest.ts:156,185-220` | Orden intra-barra optimista + slHit desfasado; entradas simuladas (no es el backtest de validación) |
| 🟡 | `fetch_history.ts:97,100-102` | Dedupe favorece lo viejo; solape anti-republicación inerte; sin detección de gaps |
| 🟡 | `run_weekly.py:601-606,637` | Fetch fallido no aborta; gate de frescura OR permite hyperopt con velas congeladas |
| 🟡 | `TimesfmFilter.ts:214-231` | Fail-open correcto pero sin alarma proactiva de degradación |
| 🟡 | `timesfm_bridge.py:230` / `SMCBridge.ts:72` | Convención de timestamp mixta → staleness sobreestimado ~1 TF |
| 🟡 | `enable_shadow.js:47-49` | set(merge:true) reemplaza todo `timesfm` → borra overrides |
| 🟡 | `run_weekly.py` (varios) | pageSize=400 sin paginación; REFRESH_ERROR exit 0; triggers15m null; loser hardcodeado; train_ml 2× y OOS=split random |
| 💡 | `calibrate_f0.py:107-108,267` | Versión "2.0.2" hardcodeada, sin git SHA |
| 💡 | `m1_backtest.ts:164-168,338` | Dead code `dist`; doc CHoCH vs código BOS |
