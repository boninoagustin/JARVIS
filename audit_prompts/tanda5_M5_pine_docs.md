# Auditoría JARVIS — Tanda 5/5 · M5: Estrategia Pine + documentación previa

**Alcance**: `SMC_Master_5.2_JARVIS_v6.0.pine`, `quant_audit_full.md`, `AUDITORIA_COMPLETA.md`, `SKILL.MD`, `SETUP.md` — ~62.000 tokens (5 archivos).
**Foco**: (a) ¿la estrategia Pine y el motor TS implementan la MISMA lógica SMC?; (b) inventario de hallazgos previos para no repetirlos y verificar cuáles siguen vivos.
**Modelo recomendado**: DeepSeek V4-Pro (o cualquier modelo con ≥128k de contexto).

---

## 0. Cómo acceder al código

- Repo en el VPS: `/opt/JARVIS/` — si tenés shell, leé los archivos directamente.
- GitHub: `https://github.com/boninoagustin/JARVIS.git`.
- Si no tenés shell: te adjunto los archivos de la lista (§2) con este prompt.
- **Además**: para esta tanda probablemente necesites comparar contra archivos TS del motor. Si tenés acceso al repo, los relevantes son `src/engine/smc/*` y `src/engine/AlphaModel.ts`. Si no, pedímelos y te los adjunto.

## 1. Contexto del sistema

JARVIS es un bot SMC/ICT (TypeScript) que opera en vivo contra cTrader. La estrategia nació como indicador/estrategia de **TradingView Pine Script** (`SMC_Master_5.2_JARVIS_v6.0.pine`) y luego fue portada a TypeScript (`src/engine/smc/`). El Pine sigue siendo la **referencia conceptual** de la estrategia: si el Pine y el TS divergen, hay que saberlo explícitamente (explica diferencias entre backtests de TradingView y el bot, y ayuda a decidir cuál es la versión "correcta").

La documentación del repo incluye auditorías previas: `quant_audit_full.md` (jun-2026, auditoría cuantitativa completa), `AUDITORIA_COMPLETA.md` (jun-2026, bugs), `SKILL.MD`, `SETUP.md` (setup del VPS).

## 2. Archivos de esta tanda

- `SMC_Master_5.2_JARVIS_v6.0.pine` (~29k — estrategia Pine completa).
- `quant_audit_full.md` (~23k — auditoría cuantitativa previa).
- `AUDITORIA_COMPLETA.md` (~7k — auditoría de bugs previa).
- `SKILL.MD` (~1k), `SETUP.md` (~1k).

## 3. Objetivos (por prioridad)

### OBJETIVO 1 — Pine vs TS: divergencias de implementación
Compará la lógica del Pine contra la implementación TS del motor SMC (`src/engine/smc/`), con foco en:
1. **Liquidity / barridos**: cómo define swings, mechas, equal highs/lows; tolerancias (pips/ATR).
2. **Order Blocks**: criterio de detección, mitigación/invalidación, uso de volumen o imbalances.
3. **CHoCH / BOS**: lógica de confirmación, qué cuenta como "estructura rota", puntos asociados (CHoCH=4, BOS=3 en el bot).
4. **Divergencias**: RSI/pivots, ventanas, confirmaciones.
5. **Zonas y su ciclo de vida**: creación, sync (`SYNC_ZONES`), mitigación, expiración.
6. **Scoring / confluence**: cómo se combinan los factores en cada lado.

Para cada divergencia: decí **cuál de los dos lados parece más correcto** y qué impacto tiene en las señales (¿el Pine genera más/menos señales? ¿más optimista?).

### OBJETIVO 2 — Inventario de hallazgos previos (para consolidar, NO para repetir)
Leé `quant_audit_full.md` + `AUDITORIA_COMPLETA.md` y producí:
1. **Inventario**: lista de todos los hallazgos previos con su estado inferido (¿el fix está mencionado? ¿quedó pendiente?).
2. Para los hallazgos que NO tengan fix documentado: marcá cuáles habría que re-verificar en el código actual (los verificará el equipo en las otras tandas — vos solo dejá la lista).
3. **NO repitas** estos hallazgos como propios en el resumen: solo listalos como "pendiente de verificación".

### OBJETIVO 3 — Coherencia de la documentación operativa
- `SKILL.MD` y `SETUP.md`: ¿describen el setup actual (PM2, systemd, venvs, puertos)? ¿Hay instrucciones obsoletas que puedan inducir a error en una emergencia?
- ¿Falta documentación crítica (cómo se restaura el bot, qué hacer si Firestore falla, plan de rollback de configs)?

## 4. Formato de salida obligatorio

Para divergencias Pine vs TS:
```
[🔴 Crítico | 🟠 Alto | 🟡 Moderado | 💡 Mejora] — `Pine línea N` vs `archivo.ts:línea` — `concepto`
**Divergencia**: <qué hace cada lado, 2-3 líneas>
**Impacto en señales**: <más/menos señales, sesgo>
**Recomendación**: <cuál lado corregir y cómo>
```

Al final:
1. Sección ejecutiva: veredicto de una línea: "¿el Pine y el TS son la misma estrategia?" + top 3 divergencias por impacto.
2. **RESUMEN PARA CONSOLIDACIÓN**: tabla `severidad | archivo:línea | descripción en una línea`.

**Regla dura**: no repitas hallazgos de auditorías previas como propios; solo marcá su estado.

---

## NOTA FINAL DEL FLUJO COMPLETO (no forma parte del prompt de auditoría)

Cuando las 5 tandas estén hechas, pegá los 5 informes (con sus bloques "RESUMEN PARA CONSOLIDACIÓN") en una sesión nueva con el prompt `tanda6_consolidacion.md` para obtener el informe final dedupeado con plan de acción priorizado.