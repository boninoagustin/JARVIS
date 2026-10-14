# Auditoría JARVIS — Tanda 5/5 · M5 Estrategia Pine + documentación previa

**08-oct-2026**. Consolidación de dos subagentes (completos) + verificación en código de las 3 divergencias top. Crudos: `/root/audit_t5/pine_vs_ts.md` y `/root/audit_t5/inventario.md`.

## Veredicto (Objetivo 1)
**El Pine y el TS NO son la misma estrategia.** Mismo esqueleto SMC/ICT, pero divergencias de implementación materialmente relevantes en los 6 frentes. El TS es un port *aproximado*, no una réplica.

---

## Objetivo 1 — Divergencias Pine vs TS (verificadas)

### 🔴 Crítico — `Pine:396-412` vs `smc/math/zscore.ts:40-54` — métrica de momentum incompatible
**Divergencia**: el Pine calcula `zUp/zDn` **direccionales** (updist/downdist con decaimiento exponencial, media y desvío separados para subidas/bajadas). El TS calcula un único `Z = (tp − VWAP) / σ` **no direccional** (Welford incremental ponderado por volumen sobre el precio típico).
**Impacto en señales**: contamina todo lo que usa momentum — CHoCH/BOS, OBs, sweeps, exhaustión. El TS no distingue "impulso alcista fuerte" de "impulso bajista fuerte" como el Pine. Además conecta con T1 H7: el feature `z_score` del MLFilter (entrenado con la semántica direccional del Pine) queda en 0/constante en el TS → el modelo se evalúa fuera de distribución.
**Recomendación**: implementar `zUp/zDn` direccionales en el TS (o alimentar el `z_score` del ML con la señal direccional real).

### 🔴 Crítico — `smc/modules/order_blocks.ts:185-192` vs Pine — VWAP como filtro duro en TS, scoring en Pine
**Divergencia**: el TS hace `if (context?.vwapStatus && !vwapZoneValid) return []` — **descarta** OBs fuera de la zona VWAP discount/premium (longs exigen UNDER, shorts OVER). El Pine solo los *puntúa* (resta, no elimina).
**Impacto en señales**: el TS genera **menos** OBs/zones que el Pine, y puede descartar setups que el Pine habría tomado con peor score. En vivo esto se agrava porque `vwapStatus` depende del `VWAP` del motor (que en los índices cae a media simple, ver Pine:452).
**Recomendación**: cambiar el filtro duro por una penalización de score (o exponer el umbral en config para A/B).

### 🟠 Alto — `smc/modules/liquidity.ts:358,381` vs Pine — gate institucional `|Z|≥2` solo en TS
**Divergencia**: el TS exige `Math.abs(zScore) ≥ 2.0` para clasificar un sweep como institucional (y ese gate usa el `Z` único re-anclado tras cada CHoCH/BOS → casi nunca pasa, ver T1 H3). El Pine no tiene ese gate en los sweeps.
**Impacto en señales**: el TS emite **muchos menos** `EVENTO_SWEEP`/`LIQ_GRAB` (0 en vivo según T1 H1) que el Pine — una familia entera de puntos de confluencia desaparece.
**Recomendación**: relajar/eliminar el gate o usar la semántica direccional del Pine (con muestra suficiente, ver H3).

### 🟡 Moderados (Pine tiene, TS no, o difieren)
- **PEH/PEL + clusters de liquidez + trendlines** no portados al TS (0 coincidencias).
- **Mitigación de OBs sin requisito de cuerpo** en TS (el Pine exige cierre del cuerpo para mitigar).
- **Fusión de OBs y God Breaker deshabilitados** en TS (existen en código pero apagados).
- **Expiración por edad** de zonas ausente en TS.
- **Divergencias RSI**: Pine pivotes 5/5 (confirmación fuerte), TS 2/2 + score de divergencia **hardcodeado a 4** (sin el score real).

---

## Objetivo 2 — Inventario de hallazgos previos

`quant_audit_full.md` es un **snapshot de código post-fix** (anotaciones `🔧 FIX` ya aplicadas), sin pendientes nuevos. `AUDITORIA_COMPLETA.md` enumera **18 hallazgos + 4 de integridad de datos**. Estado inferido:

- **Resueltos** (verificado en T1–T4): división por cero R:R, rMultiple asumido→sanitizeRMultiple, FINNHUB en `src/` (queda la de `jarvis-os`), PortfolioModel fail-open, ghost_positions.
- **Pendientes / a re-verificar** (14 ítems): la mayoría de P0#3, P0#4, P1#5–#12, P2#13–#18 + integridad de datos.

⚠️ **Nota de cierre de auditoría** (no es repetición, es corrección del inventario): tres "pendientes" del inventario en realidad **ya fueron cubiertos en T1–T4**:
- **P0#4** (onSnapshot sin unsubscribe) → **resuelto**: `trading.ts:786,919-924` tiene `unsubscribers[]` + `cleanupAndExit` en SIGTERM/SIGINT.
- **P1#6** (sin validación Zod) → **ahora existe** `AssetSessionConfigSchema`, y es justo la causa del 🔴 C1 de T1 (doc inválido descartado → fallback con defaults).
- **P0#3** (set() fire-and-forget pisa RAM) → es la carrera **set/delete de `active_trades`** reportada en T1 (🟠).

## Objetivo 3 — Documentación operativa (hallazgos nuevos)

### 🔴 `SKILL.MD:1-172` — documenta el "Equipo Alejabot" (multi-agente Antigravity), no el bot de trading
Es un remanente del proyecto pre-trading (igual que `README.md` y `GWS_SETUP.md`). En una emergencia, abrir `SKILL.MD` buscando cómo operar el bot lleva a un protocolo de agentes que no existe en producción.

### 🔴 `SETUP.md:46-50` — dice "Optimizador dominical" pero el timer real es **sáb 06:00** (`OnCalendar=Sat`) con ~14 pasos
Confirma el hallazgo de T4 (timer fuente desincronizado). Además subestima la complejidad (no es "un script").

### 🔴 `SETUP.md` — omite `jarvis-asset-scout` (sáb 03:00) y `jarvis-opt-failure-notify`
Una restauración siguiendo `SETUP.md` al pie no las instalaría → pérdida del screening semanal y de la notificación de fallo.

### 🔴 `SETUP.md:11` — instruye Node 22, pero los jobs systemd usan Node v24.19.0 vía nvm
Un VPS restaurado según `SETUP.md` no tendría el binario de nvm → todos los jobs `tsx` fallarían.

### 🟠 Otros
- `SETUP.md` solo crea `kronos_api/venv`; omite `scripts/timesfm/.venv` y `scripts/hyperopt/.venv` (y `periodic_opt` usa `/usr/bin/python3`, no venv).
- El estado **CONGELADO** (`AUTO_APPLY_ENABLED=False`) no está documentado en ningún lado (sin runbook de descongelamiento).
- `jarvis-periodic-opt.service:2` se auto-describe "nunca aplica" pero su `ExecStartPost` corre `tf_sweep_weekly.ts` que **sí** aplica RECOMMENDs y reinicia (confirma el 🔴 de T4).
- 🟡 Falta runbook de **rollback de configs** (existen `backups/*_tuned*.json` sin procedimiento) y de **fallo de Firestore en caliente** (bot fail-open + `.catch` silencioso).
- 💡 `CTRADER_DEMO=true` coincide con `.env` (pero el encuadre de la auditoría lo trata como LIVE — no asumir demo inerte).

**Verificado sin hallazgo (Obj 3)**: puertos (5173/8081/8000/8788), procesos PM2 (JARVIS/JARVIS_OS/KRONOS_API vía ecosystem.config.cjs), secrets scripts, `kronos_api/venv` — todos correctos.

---

## RESUMEN PARA CONSOLIDACIÓN (Tanda 5)
| severidad | archivo:línea | descripción |
|---|---|---|
| 🔴 | `Pine:396-412` vs `zscore.ts:40-54` | Momentum: zUp/zDn direccionales (Pine) vs Z único no direccional (TS) |
| 🔴 | `order_blocks.ts:185-192` | VWAP como filtro duro (return []) en TS vs scoring en Pine |
| 🟠 | `liquidity.ts:358,381` | Gate institucional \|Z\|≥2 en sweeps solo en TS → casi 0 sweeps |
| 🟡 | Pine vs `smc/*` | PEH/PEL, clusters, trendlines no portados; mitigación OB sin cuerpo; fusión OB/God Breaker apagados; expiración ausente; divergencias 5/5 vs 2/2 + score hardcodeado 4 |
| 🔴 | `SKILL.MD:1-172` | Documenta "Equipo Alejabot", no el bot de trading |
| 🔴 | `SETUP.md:46-50` | "Dominical" erróneo: timer real sáb 06:00 con ~14 pasos |
| 🔴 | `SETUP.md` | Omite jarvis-asset-scout y jarvis-opt-failure-notify |
| 🔴 | `SETUP.md:11` | Node 22 vs Node v24.19.0 vía nvm (jobs tsx rotos tras restore) |
| 🟠 | `SETUP.md:23` | Omite venvs timesfm/hyperopt |
| 🟠 | (ninguno) | CONGELADO sin documentar; service "nunca aplica" vs tf_sweep que sí aplica |
| 🟡 | (ninguno) | Falta runbook de rollback de configs y de fallo de Firestore |

**Inventario**: 18+4 hallazgos previos inventariados con estado; 14 marcados para re-verificar (3 ya cubiertos en T1–T4, corregido arriba).
