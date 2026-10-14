# Auditoría JARVIS — Tanda 4/5 · M4: Scripts de operación (optimizador dominical + TimesFM + pipeline de datos)

**Alcance**: `scripts/periodic_opt/`, `scripts/timesfm/`, `scripts/fetch_history.ts`, `scripts/export_smc_csv.ts`, `scripts/m1_backtest.ts` — ~62.000 tokens (35 archivos).
**Foco**: la automatización que corre sola todos los días/semanas — si un script falla en silencio, el bot opera con datos o configs viejas sin que nadie se entere.
**Modelo recomendado**: DeepSeek V4-Pro (o cualquier modelo con ≥128k de contexto).

---

## 0. Cómo acceder al código

- Repo en el VPS: `/opt/JARVIS/` — si tenés shell, leé los archivos directamente.
- GitHub: `https://github.com/boninoagustin/JARVIS.git`.
- Si no tenés shell: te adjunto los archivos de la lista (§2) con este prompt.

## 1. Contexto del sistema

JARVIS opera en vivo contra cTrader con una **automatización periódica** que mantiene el bot optimizado:

- **Optimizador dominical** (`scripts/periodic_opt/run_weekly.py`): corre los sábados 06:00 CEST vía systemd timer (`jarvis-periodic-opt.timer`). Evalúa cada gatillo/activo y propone cambios de config (enabled/minScore/entryPercent). **Estado actual: CONGELADO (`AUTO_APPLY_ENABLED=False`): corre y genera proposals, pero NO auto-aplica** — un humano revisa y aprueba.
- **Reglas del optimizador** (a verificar contra el código): RECOMMEND + Monte Carlo ≥0.80 → auto-activación (solo si apply habilitado); auto-activa respeta `disabledReason` (nunca re-habilita un ticker deshabilitado a mano); HOLD_MC ×2 → OFF; rollback si OOS > 0.10 R/trade; loser enable/disable con n≥8 ±0.15 R/trade; sizing sobrevivencia ≥0.85; Scout (03:00) PASS → `active_tickers`. El roster es dinámico: `enabled && !disabledReason`.
- **TimesFM**: filtro direccional zero-shot (`scripts/timesfm/timesfm_bridge.py`, servicio systemd `jarvis-timesfm-bridge.service`) que audita la dirección antes de entrar.
- **Pipeline de datos**: `fetch_history.ts` descarga velas OHLCV de cTrader → `export_smc_csv.ts` corre el SMCEngine y genera CSVs de eventos → los consume el backtest. `m1_backtest.ts` es el backtest tick-level M1 (Brownian Bridge).

Stack: Node v24 (ESM, `tsx`), Python 3 (venvs en `scripts/periodic_opt/.venv` y `scripts/timesfm/.venv`), PM2 + systemd.

## 2. Archivos de esta tanda

**Optimizador dominical (`scripts/periodic_opt/`):**
- `run_weekly.py` (~14k — **orquestador principal del dominical**).
- `apply_weekly.ts`, `eval_production.ts`, `get_active_tickers.ts`, `detection_diagnostic.ts`.
- `loser_triggers_proposal.ts`, `sizing_weekly_proposal.ts`, `tf_sweep_weekly.ts`, `smc_tf_sweep.ts`.
- `train_ml_weekly.py` (entrenamiento semanal del modelo ML).
- `jarvis-periodic-opt.service` / `.timer` (systemd).

**TimesFM (`scripts/timesfm/`):**
- `timesfm_bridge.py` (bridge del servicio), `precompute_forecasts.py`, `run_ab.py`, `calibrate_f0.py`, `analyze_f0.py`.
- `enable_shadow.js` (modo shadow).

**Pipeline de datos (raíz de `scripts/`):**
- `fetch_history.ts` (descarga OHLCV, chunks de 30 días).
- `export_smc_csv.ts` (genera CSVs de eventos SMC).
- `m1_backtest.ts` (backtest tick-level M1).

## 3. Objetivos (por prioridad)

### OBJETIVO 1 — Optimizador dominical: ¿qué decide de verdad y qué falla en silencio?
- Verificá las reglas declaradas (§1) contra el código: ¿están implementadas como se documentan? ¿Hay casos donde el script puede auto-aplicar algo que no debería (por ejemplo con el flag congelado, o si el flag cambia)?
- **¿Qué decide el optimizador vs qué está hardcodeado?** (tunea enabled/minScore/entryPercent; los filtros OTE de AlphaModel están hardcodeados). Marcá la frontera.
- Manejo de errores: si un paso falla (fetch de precios, MCP, Python venv, timeout), ¿el script aborta, reintenta o sigue con datos parciales? ¿Notifica?
- Idempotencia y re-runs: ¿qué pasa si corre dos veces? ¿Puede pisar proposals o aplicaciones previas?
- Interacción con systemd: `ExecStart`, `RestartSec`, timeouts, logs. ¿El timer corre a la hora correcta (06:00 CEST) y con la TZ correcta (VPS en Europe/Berlin)?

### OBJETIVO 2 — TimesFM: filtro direccional
- ¿El bridge maneja bien timeouts/caídas? Si TimesFM no responde, ¿el bot bloquea entradas (fail-closed) o las deja pasar (fail-open)? ¿Cuál es el comportamiento deseado y cuál el real?
- ¿La calibración (`calibrate_f0.py`) queda versionada y reproducible? ¿Modo shadow bien aislado de producción?

### OBJETIVO 3 — Pipeline de datos: fidelidad y frescura
- `export_smc_csv.ts`: ¿emite los mismos eventos (SYNC_ZONES con `d/p/b/sc`, CHoCH/BOS, divergencias) que el bot vivo ve en tiempo real? ¿Estructuras que el export no genera o genera de más?
- `fetch_history.ts`: ¿respeta límites de cTrader? ¿Dedupe/sort correcto? ¿Gaps detectados? ¿Rate limiting?
- **Frescura**: ¿hay mecanismo que refresque velas+CSVs automáticamente o es manual? ¿Los CSVs actuales están viejos? ¿Alguien valida la fecha de última actualización?
- Formato: ¿el CSV (`Fecha,Mensaje`) matchea lo que `backtest_server.ts` y el worker del hyperopt esperan parsear?

### OBJETIVO 4 — `m1_backtest.ts` (tick-level)
- ¿Respeta el orden intra-barra (qué tocó primero, SL o TP) usando el TickGenerator? ¿Es el backtest "bueno" que debería usarse para validar, y está documentado como tal?

## 4. Formato de salida obligatorio

```
[🔴 Crítico | 🟠 Alto | 🟡 Moderado | 💡 Mejora] — `archivo:línea` — `función/nombre`
**Problema**: ...
**Impacto**: <qué se rompe: config que no se aplica, datos viejos, trades que no deberían, silencio ante fallos>
**Solución**: <diff exacto o cambio de config/comando>
**Verificación**: <comando/pasos>
```

Al final:
1. Sección ejecutiva: top 3-5 problemas (qué automatización está más rota ahora mismo) + veredicto por objetivo.
2. **RESUMEN PARA CONSOLIDACIÓN**: tabla `severidad | archivo:línea | descripción en una línea`.

**Regla dura**: toda solución ejecutable sin ambigüedad.