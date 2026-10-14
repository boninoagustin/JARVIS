# Auditoría JARVIS — Tanda 3/5 · M3 Frontend dashboard (`jarvis-os`)

**08-oct-2026**. Consolidación de dos subagentes (completos) + verificación en código de los 🔴/🟠. Crudos: `/root/audit_t3/panel.md` y `/root/audit_t3/paneles.md`.

## Cobertura
| Obj | Estado |
|---|---|
| 1 · Flujo del panel de backtesting | ✅ completo |
| 2 · Métricas | ✅ completo |
| 3 · Robustez/crashes | ✅ completo |
| 4 · Seguridad | ✅ completo |
| 5 · Paneles secundarios | ✅ completo |

## Veredicto
El panel de backtest funciona en su flujo principal (simular, auto-tune, métricas), pero **`handlePushToBot` (exportar a JARVIS) pierde configuración silenciosamente sobre el bot vivo** — y conecta con la T1: si el panel no escribe todo, el bot opera con defaults. Los pitfalls históricos (P2–P9, fricción) están arreglados.

---

## Hallazgos

### 🔴 Crítico — `BacktestingPanel.tsx:811` — `handlePushToBot`: `minimal_roi` pisado con default hardcodeado en cada export
**Problema**: `minimal_roi: (sessionTriggers)?.LONDON?.choch15m?.minimal_roi || {"0":0.015,"30":0.005,"60":0}`. Lee de `LONDON.choch15m.minimal_roi` (que casi nunca existe en el config armado en el panel) y cae a un default; se escribe con `merge:true` sobre el doc → **sobrescribe el `minimal_roi` real del bot** con el default en cada export.
**Impacto**: cambia la salida por ROI time-decay en producción sin que el operador lo sepa.
**Solución**: leer el `minimal_roi` que ya está en el doc/estado y solo sobreescribir si el usuario lo editó; o directamente no tocar la key si no cambió.
```diff
-        minimal_roi: (sessionTriggers as any)?.LONDON?.choch15m?.minimal_roi || {"0":0.015,"30":0.005,"60":0},
+        minimal_roi: currentConfig.minimal_roi,   // preservar el valor vigente del doc (no pisar con default)
```
**Verificación**: `grep -n "minimal_roi" BacktestingPanel.tsx` → que no haya `|| {...default}` en el path de export.

### 🟠 Alto — `BacktestingPanel.tsx:849-855` + tipo `:295-302` — `handlePushToBot` omite campos que el bot consume
**Problema**: el tipo de gatillo solo tiene `{enabled, minScore, entryPercent?}` — **no** `minScoreBuy/minScoreSell` (el tuning direccional del hyperopt no se puede editar ni exportar), **no** `riderEnabled/riderTf` (activos nuevos operan sin transición RIDER), y **no** se escribe/limpia `disabledReason` (re-habilitar un activo retirado falla silencioso: el roster exige `enabled===true && !disabledReason`).
**Impacto**: configuración perdida en el camino panel→Firestore→bot; re-habilitación que no funciona; tuning direccional del optimizador inaccesible.
**Solución**: agregar `minScoreBuy/minScoreSell` al tipo de gatillo y a `defTrig`/payload; escribir `riderEnabled/riderTf` si existen; escribir `disabledReason: null` (o `FieldValue.delete()`) al re-habilitar.
**Verificación**: `grep -n "minScoreBuy\|riderEnabled\|disabledReason" BacktestingPanel.tsx` → presentes en el payload de `handlePushToBot`.

### 🔴 Crítico — `jarvis-os/src/services/macro_data.ts:6` — key de Finnhub hardcodeada en el repo
**Problema**: `const FINNHUB_KEY = 'd7pt…'` en el cliente. Matiz verificado: `macro_data.ts` **no está importada** hoy (tree-shaken → no llega al bundle servido), pero **sí está en el repo Git público**.
**Impacto**: la key queda expuesta en el historial del repo y se re-expondría al bundle si alguien la vuelve a importar.
**Solución**: mover la llamada a Finnhub a un proxy server-side (Kronos :8000) y borrar la key del cliente; rotar la key.
**Verificación**: `grep -rn "FINNHUB_KEY" jarvis-os/src` → 0 en el cliente; la key pasa a `kronos_api/`.

### 🟠 Alto — `PeriodicOptPanel.tsx:517` — doble llave incompleta al apagar un gatillo
**Problema**: `merged[p.session][p.trigger] = { ...curT, minScore: 99 }` — apaga solo con `minScore:99`, **sin** `enabled:false`. El script canónico (`apply_trigger_state.ts`) pone ambas llaves.
**Impacto**: el gatillo queda `enabled:true` en Firestore → el panel lo muestra como encendido y el optimizador futuro puede "re-encontrarlo" como habilitado (aunque el score 99 lo bloquea hoy).
**Solución**: `merged[p.session][p.trigger] = { ...curT, enabled: false, minScore: 99 }` (y al activar: `enabled: true, minScore: 4`).
**Verificación**: `grep -n "minScore: 99" PeriodicOptPanel.tsx` → debe ir junto a `enabled: false`.

### 🟠 Alto — `AdminPanel.tsx:26-40` — bug de aliasing: sesión `OFF` nace `enabled:true`
**Problema**: `const sessions = data.sessions || {}` es una **referencia** a `data.sessions`. El `SESSIONS.forEach` (que incluye `'OFF'`) crea `sessions.OFF = {…enabled:true…}` cuando falta, y como `sessions === data.sessions`, el guard posterior `if (!data.sessions?.OFF)` ya ve el `OFF` recién creado (enabled:true) → **el override a `enabled:false` nunca corre**.
**Impacto**: la UI muestra la sesión nocturna OFF con todos los gatillos prendidos; combinado con `handleSave` que persiste `sessions` entero (`:126`), un guardado puede escribir `OFF` habilitado a Firestore.
**Solución**: clonar antes de mutar y arreglar el orden del guard.
```diff
-          const sessions = data.sessions || {};
+          const sessions = data.sessions ? JSON.parse(JSON.stringify(data.sessions)) : {};
+          // y el guard de OFF debe correr ANTES del forEach, o chequear el clon, no data.sessions
```
**Verificación**: `grep -n "const sessions = data.sessions" AdminPanel.tsx`; tras el fix, OFF siempre `enabled:false` en el estado local.

### 🟡 Moderado
- `BacktestingPanel.tsx` — `new Date(t.timestamp).toISOString()` sin guard (crash vía upload de portafolio); `processedEvents` sin guard; win rate cuenta BE como pérdida y diverge del server; métricas duplicadas/divergentes en `handleDownloadJson` (sin Sharpe/kelly, la racha no resetea en BE); mapas de TF mal claveteados (`5/15/60/240` vs `M5/M15/H1/H4` → orden/etiquetas/colores rotos); `handleOptimizeMaxLosses` reporta éxito con 0 si el batch falla entero; errores de red sin `detail` ni timeout (whitescreen potencial).
- `PeriodicOptPanel.tsx:512-522` — aplica la propuesta de perdedores a 1 sola sesión y sin `EXCLUDE` (el script canónico hace 4 sesiones + EXCLUDE `GBPJPY:oteBos5m`).
- `AutoTunePanel.tsx:66-118` — `handleApply` escribe `asset_configs` sin confirmación; `:53,236` timestamp ausente → sort NaN / "Invalid Date".
- `AdminPanel.tsx:126` — `handleSave` persiste `sessions` entero (riesgo de pisar writers concurrentes).

### 💡 Mejora
- `RadarHeatmap.tsx:88` — IP hardcodeada en un comentario (el código usa `hostname`, OK).

## Verificado sin hallazgo (ya arreglado / no aplica)
- Pitfalls **P2, P3, P4, P8, P9** y la fricción `useState(0.1/3.0)`: arreglados en el working tree.
- **`firebase.ts`/`.env`**: `jarvis-os/.env` existe y está completo (projectId `jarvis-67f66`, 6 vars); la hipótesis "projectId undefined → bitácora vacía" **ya no aplica**.
- **`FundamentalTerminal` NO consume `macro_data`** (usa Yahoo + fallback Firestore) → el issue "Finnhub c:0" no afecta a ese panel.
- **RadarHeatmap badges correctos**: `🛡️ KS` = killswitch real, `🚫 Nocturna` = sesión OFF.
- **AdminPanel diff-save OK**: `MANAGED_FIELDS` no incluye `timesfm`/`source`.
- **PeriodicOptPanel SÍ tiene doble confirmación** (modales con diff); el problema es solo el payload (doble llave), no la confirmación.
- No hay Zustand (la app usa `useState` + `onSnapshot`).

## Sección ejecutiva (top por impacto operativo)
1. **Exportar a JARVIS pierde/rompe config** (🔴 minimal_roi + 🟠 rider/disabledReason/minScoreBuy/Sell) — el operador cree que está configurando el bot y en realidad lo está dejando con defaults o con un ROI time-decay distinto. Es el hallazgo que más directo golpea la cuenta.
2. **Doble llave incompleta del PeriodicOptPanel** (🟠) — apagar un gatillo desde el panel no lo apaga del todo (queda `enabled:true`), y la re-habilitación de activos retirados falla en silencio.
3. **AdminPanel OFF nace prendido** (🟠) — riesgo de escribir sesión nocturna habilitada a Firestore.
4. **Key de Finnhub en el repo público** (🔴) — rotar y mover a proxy server-side.

## RESUMEN PARA CONSOLIDACIÓN
| severidad | archivo:línea | descripción |
|---|---|---|
| 🔴 | `BacktestingPanel.tsx:811` | `minimal_roi` pisado con default en cada export a JARVIS |
| 🔴 | `macro_data.ts:6` | Key Finnhub hardcodeada en el repo público (tree-shaken hoy) |
| 🟠 | `BacktestingPanel.tsx:849-855,295-302` | Export omite `minScoreBuy/Sell`, `riderEnabled/riderTf`, `disabledReason` |
| 🟠 | `PeriodicOptPanel.tsx:517` | Doble llave incompleta (falta `enabled:false` al apagar) |
| 🟠 | `AdminPanel.tsx:26-40` | Aliasing: sesión OFF nace `enabled:true` |
| 🟡 | `PeriodicOptPanel.tsx:512-522` | Propuesta aplicada a 1 sesión y sin EXCLUDE |
| 🟡 | `AutoTunePanel.tsx:66-118` | `handleApply` sin confirmación |
| 🟡 | `AutoTunePanel.tsx:53,236` | timestamp ausente → NaN/Invalid Date |
| 🟡 | `AdminPanel.tsx:126` | `handleSave` persiste `sessions` entero |
| 🟡 | `BacktestingPanel.tsx` (varios) | Date/processedEvents sin guard; win rate diverge del server; métricas duplicadas; mapas TF rotos; errores de red sin detail |
| 💡 | `RadarHeatmap.tsx:88` | IP hardcodeada en comentario |
