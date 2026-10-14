# Auditoría segmentada de JARVIS — paquete de prompts

Generado: octubre 2026 · Actualizado: 8-oct-2026 (modelo recomendado: DeepSeek V4-Pro). Repo: `/opt/JARVIS`.

## Cómo usar

1. **Elegí el modelo**. Recomendado: **DeepSeek V4-Pro** — contexto 1M (la tanda 1 entra entera) y la auditoría completa sale ~$1-2; los $22 que costó una sola tanda con Opus 5.5 xhigh no se repiten. Tarifas oficiales off-peak: input $0.66/M · output $1.98/M · cache-hit $0.022/M. En horas pico (01:00-04:00 y 06:00-10:00 UTC = 22:00-01:00 y 03:00-07:00 hs de Argentina, lun-vie) se duplica: corré de día o domingo.
2. **Corré las tandas 1-5**, cada una en una sesión nueva. Si mantenés la misma sesión, la cache automática de DeepSeek te cobra los reenvíos del código casi nada (~$0.02/M).
   - Pegá el prompt de la tanda + adjuntá los archivos de la lista §2 de esa tanda (o dale acceso shell al VPS si el modelo lo soporta: `cd /opt/JARVIS`).
   - Cada tanda produce un informe con hallazgos + un bloque "RESUMEN PARA CONSOLIDACIÓN".
3. **Corré la tanda 6 (consolidación)** con los 5 informes como input → informe final dedupeado con plan de acción priorizado.
4. **Antes de aplicar cambios**: backtestear los cambios de estrategia (regla de Bon), aprobación explícita para código, rollout gradual para config.

## Archivos

| Archivo | Contenido | Tokens de código |
|---|---|---|
| `tanda1_M1_motor_trading.md` | Motor de trading: engine + db + services (decisión, gestión, ejecución) | ~240k |
| `tanda2_M2_backtesting.md` | Backtesting: motor canónico, Kronos, Hyperopt | ~80k |
| `tanda3_M3_frontend.md` | Frontend dashboard React (panel, métricas, export config) | ~120k |
| `tanda4_M4_scripts_operacion.md` | Scripts de operación: optimizador dominical, TimesFM, pipeline datos | ~62k |
| `tanda5_M5_pine_docs.md` | Estrategia Pine vs TS + inventario de auditorías previas | ~62k |
| `tanda6_consolidacion.md` | Consolidación final (va al final, con los 5 informes) | — |

**Total código a auditar**: ~564k tokens en 5 tandas.

## Orden recomendado

1. **Tanda 1 (M1)** primero — es la crítica: si el motor tiene un bug, todo lo demás es secundario. (El split M1a/M1b del prompt es solo para modelos con <300k de contexto; V4-Pro no lo necesita.)
2. Tandas 2 y 4 (backtest + automatización) — validan que las decisiones se tomen con datos correctos.
3. Tandas 3 y 5 (frontend + Pine/docs) — cierran el cuadro.

## Notas

- El ruido del repo (diag_, test_, fix_, patch_, presets, radar_states, package-lock) está excluido de las listas: no aporta a la auditoría.
- Si el modelo no tiene acceso shell, adjuntá los archivos listados en §2 de cada tanda (esa sección existe justo para eso).
- Costos con DeepSeek V4-Pro (off-peak, estimación conservadora): M1 ~$0.2-0.5 · M2 ~$0.1 · M3 ~$0.15 · M4 ~$0.1 · M5 ~$0.1 · consolidación ~$0.1 → **total ~$1-2** aún con ida y vuelta. En horas pico, duplicar.
