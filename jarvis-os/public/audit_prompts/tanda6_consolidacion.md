# Auditoría JARVIS — Consolidación final (después de las 5 tandas)

**Uso**: esta tanda se corre AL FINAL, en una sesión nueva. Pegá este prompt + los 5 informes completos de las tandas 1-5 (idealmente solo sus secciones ejecutivas y bloques "RESUMEN PARA CONSOLIDACIÓN" si el contexto es corto; si el modelo tiene ≥300k de contexto, pegá los informes completos).
**Modelo recomendado**: DeepSeek V4-Pro (para razonamiento fino sobre el corpus entero). Con modelos de 128k, usá solo los bloques de resumen.

---

Eres el auditor jefe de JARVIS (bot de trading SMC/ICT en TypeScript, operando en vivo contra cTrader con dinero real). Recibiste 5 informes de auditoría independientes, uno por módulo:

- **M1**: Motor de trading (`src/engine`, `src/db`, `src/services`) — decisión, gestión de trades, ejecución.
- **M2**: Backtesting (motor, Kronos, Hyperopt) — representatividad del backtest.
- **M3**: Frontend dashboard (`jarvis-os`) — panel, métricas, export de config.
- **M4**: Scripts de operación (optimizador dominical, TimesFM, pipeline de datos).
- **M5**: Estrategia Pine + docs — divergencias Pine vs TS, hallazgos previos.

Tu tarea: **consolidar todo en un único informe final accionable** para el operador (Bon). No repitas los informes: sintetizá.

## 1. Dedupe y correlación
- Si el mismo hallazgo aparece en más de una tanda, consolidalo en uno solo (cita las secciones relacionadas).
- Identificá **causas raíz compartidas**: hallazgos de distintos módulos que son el mismo problema de fondo (ej. el mismo gate faltante en backtest y en la UI, o la misma config que se pierde en dos lugares).
- Marcá contradicciones entre informes (si dos tandas se contradicen, señalalo y decidí qué lado tiene razón con el razonamiento).

## 2. Plan de acción priorizado
Producí la lista final de cambios ordenada por **(impacto operativo / dinero en riesgo) ÷ esfuerzo**:

| # | Cambio | Módulo | Severidad | Archivos | Esfuerzo | Riesgo de aplicarlo |
|---|--------|--------|-----------|----------|----------|---------------------|

Para cada cambio: referencia al hallazgo original (tanda + archivo:línea), qué se toca, y cómo se verifica.
- Los primeros 1-3 ítems deben ser el **"quick win"**: cambios chicos que probablemente ya mejoran la operación esta semana.
- Separar: (a) fixes urgentes de bugs que afectan dinero ya, (b) mejoras de proceso/automatización, (c) deuda técnica.

## 3. Veredictos
- Una línea por módulo: estado general + lo más grave.
- Una sección "**¿Qué cambiaría primero si solo pudieras hacer 3 cosas?**" con el razonamiento de por qué esas 3.

## 4. Anexo de trazabilidad
- Tabla completa con TODOS los hallazgos (severidad | módulo | archivo:línea | descripción | estado: nuevo/verificar-previo).
- Lista de hallazgos de auditorías previas (jun-2026) que siguen sin verificar.

**Regla dura**: cada ítem del plan debe ser ejecutable sin ambigüedad (comando, diff o JSON exacto). Si algo no se puede resolver sin más información, indicá exactamente qué falta y quién lo puede proveer.

---

## Después de la consolidación

1. Guardá el informe final como `audit_resultado_<fecha>.md` en el repo.
2. Antes de aplicar CUALQUIER cambio: recordá que en JARVIS los cambios de estrategia se backtestean ANTES de aplicarse (regla del operador).
3. Los fixes de código se aplican con aprobación explícita; los de config, con rollout gradual (un activo primero, ver 1-2 días, luego el resto).