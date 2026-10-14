# Auditoría JARVIS — Tanda 3/5 · M3: Frontend dashboard (`jarvis-os` React)

**Alcance**: `jarvis-os/src/` (componentes, features, App) — ~120.000 tokens (13 archivos).
**Foco**: ¿el dashboard es confiable como herramienta de operación? (métricas correctas, sin crashes, sin pérdida de datos al exportar/configurar).
**Modelo recomendado**: DeepSeek V4-Pro (o cualquier modelo con ≥128k de contexto).

---

## 0. Cómo acceder al código

- Repo en el VPS: `/opt/JARVIS/` — si tenés shell, leé los archivos directamente.
- GitHub: `https://github.com/boninoagustin/JARVIS.git`.
- Si no tenés shell: te adjunto los archivos de la lista (§2) con este prompt.

## 1. Contexto del sistema

JARVIS es un bot de trading SMC/ICT (TypeScript) con dashboard React/Vite (`jarvis-os`, puerto :5173, servido por PM2). El dashboard es la herramienta con la que el operador:
- **Backtestea** (panel que llama a la API Kronos y muestra métricas + gráficos).
- **Opera el optimizador** (panel del optimizador periódico dominical).
- **Monitorea** (journal de analytics, radar heatmap de estados SMC, terminal de fundamentales, admin).
- **Exporta config a JARVIS** (escribe `asset_configs/{ticker}` en Firestore para que el bot vivo lo consuma).

El backtest corre server-side en Kronos (:8000) sobre el motor real (`backtestEngine.ts`); el panel arma el `BacktestConfig`, manda el request y renderiza.

## 2. Archivos de esta tanda

- `jarvis-os/src/components/BacktestingPanel.tsx` (~43k — **el panel más grande**: config, simular, auto-tune, exportar a JARVIS, métricas, gráficos).
- `jarvis-os/src/components/PeriodicOptPanel.tsx` (~24k — panel del optimizador periódico).
- `jarvis-os/src/components/AnalyticsJournal.tsx` (~17k — journal/analytics).
- `jarvis-os/src/components/FundamentalTerminal.tsx` (macro/VIX/DXY/noticias).
- `jarvis-os/src/components/RadarHeatmap.tsx` (estados SMC en vivo vía WS :8081).
- `jarvis-os/src/components/AdminPanel.tsx`, `AutoTunePanel.tsx`, `MicroStates.tsx`, `Toast.tsx`.
- `jarvis-os/src/components/admin/SessionCard.tsx`, `admin/types.ts`.
- `jarvis-os/src/features/backtesting/hooks/useBacktestApi.ts` (hook HTTP → Kronos).
- `jarvis-os/src/App.tsx`, `main.tsx`, `firebase.ts`.
- `jarvis-os/src/services/macro_data.ts` (⚠️ contiene una key de Finnhub hardcodeada — confirmala).

## 3. Objetivos (por prioridad)

### OBJETIVO 1 — Flujo del panel de backtesting: ¿cada botón hace lo que su etiqueta dice?
- ¿Simular / Auto-Tune / Exportar a JARVIS / descarga CSV / Monte Carlo / badge ML funcionan end-to-end? ¿Hay estados que se pisan, sliders que se resetean, configs que no se persisten?
- ¿El panel arma el `BacktestConfig` COMPLETO (sessions, sessionFilter, tfs) o un subconjunto que produce 0 trades o NaN? ¿`minBuyPoints`/`minSellPoints` con default correcto?
- **Exportar a JARVIS** (`handlePushToBot`): ¿escribe a `asset_configs/{ticker}` TODOS los campos que el bot vivo consume (minimal_roi, slAfterTp1, trails, sessions, riderEnabled/riderTf, entryPercent…)? ¿O se pierden campos en el camino?
- **Auto-Tune**: ¿aplica el resultado (`best`) a los sliders correctos o "corre" y no hace nada? ¿El shape de respuesta coincide con lo que devuelve el server?

### OBJETIVO 2 — Cálculo de métricas: ¿los números son confiables?
- Sharpe, MaxDD, profit factor, expectancy, win rate: ¿bien calculados? ¿Divisiones por cero con 0 trades? ¿NaN con configs parciales?
- ¿El cálculo de métricas avanzadas está duplicado entre panel y server con fórmulas divergentes?

### OBJETIVO 3 — Crashes y robustez de UI
- `new Date(t.timestamp)` con timestamp faltante → `Invalid Date` / crash.
- `result.processedEvents.toLocaleString()` con campo faltante (¿`timestamp`/`processedEvents` pueden venir ausentes del server?).
- `files` que vienen como objetos `{name, lines}` vs strings.
- Config parcial → NaN en pantalla / UI congelada (listas largas, re-renders).
- Manejo de errores de red contra Kronos (puerto :8000 caído, CORS, timeouts): ¿el usuario ve un mensaje accionable o un whitescreen?

### OBJETIVO 4 — Seguridad y datos
- `macro_data.ts`: key de Finnhub hardcodeada en el bundle del cliente (visible para cualquiera). Confirmá y proponé el fix (proxy server-side).
- ¿El panel expone datos sensibles (tokens, configs) en el bundle?
- Consistencia del estado local (Zustand) con Firestore: ¿condiciones de carrera al guardar/cargar?

### OBJETIVO 5 — Paneles secundarios
- `PeriodicOptPanel`: ¿refleja bien el estado del optimizador dominical (proposals, pacing, resultados)? ¿Botones de aprobación seguros (doble confirmación)?
- `AnalyticsJournal` / `RadarHeatmap` / `FundamentalTerminal` / `AdminPanel`: bugs de render, datos desactualizados, acciones destructivas sin confirmación.

## 4. Pitfalls conocidos del sistema (verificá si siguen presentes; si ya están arreglados no los reportes)

- P2: campos de zona en `d/p/b/sc` (no `Direction/Top/Bottom`).
- P3: config parcial → NaN (merge `{...defaults, ...JSON.parse(...)}` obligatorio).
- P4: `ticker` como query param, no FormData (FastAPI 422).
- P5: `timestamp` y `processedEvents` faltantes en el output → crash del panel.
- P6: `/api/backtest/files` devuelve objetos `{name, lines}`, no strings.
- P7: puerto 8000 (Kronos) debe estar abierto en ufw.
- P8: Auto-Tune devuelve `best`, no `{optimized, metrics}`.
- P9: `tfs` falta en payloads de optimize/batch → 0 archivos cargados.

## 5. Formato de salida obligatorio

```
[🔴 Crítico | 🟠 Alto | 🟡 Moderado | 💡 Mejora] — `archivo.tsx:línea` — `componente/función`
**Problema**: ...
**Impacto**: <qué rompe en la UI / la decisión del operador / la config del bot>
**Solución**: <diff exacto>
**Verificación**: <pasos>
```

Al final:
1. Sección ejecutiva: top 3-5 problemas ordenados por impacto operativo.
2. **RESUMEN PARA CONSOLIDACIÓN**: tabla `severidad | archivo:línea | descripción en una línea`.

**Regla dura**: toda solución ejecutable sin ambigüedad.