# Auditoría JARVIS — Informe final consolidado (5 tandas)

**Fecha**: 08-oct-2026 · **Alcance**: motor, backtest, frontend, scripts de operación, Pine+docs · ~240k+ tokens de código auditados, working tree incluido.
**Método**: 5 tandas + subagentes paralelos, con verificación en código de todo 🔴/🟠 antes de publicar. Sin cambios aplicados al código (solo una contención por datos en Firestore, ya verificada y con backup).

---

## 1. Veredictos por módulo (una línea + lo más grave)

| Módulo | Estado | Lo más grave |
|---|---|---|
| **M1 Motor** | 🟠 opera con señales degradadas y config rota | El motor SMC corre sobre **velas degeneradas desde 06-ago** (primer tick + close=low); 3 pares JPY operaban con defaults por config inválida |
| **M2 Backtest** | 🟠 núcleo fiel, optimización engaña | Hyperopt **sobreajustado** (34 dims/~40 trades, in-sample) con objetivo divergente entre `metrics.py` y el worker; 28/34 params nunca se despliegan |
| **M3 Frontend** | 🟡 funcional, export pierde config | `handlePushToBot` pisa `minimal_roi` con default y omite campos; key Finnhub en repo público |
| **M4 Scripts** | 🔴 el "congelado" no congela | `killswitch_tune` y `directional_mcl_tune` **escriben Firestore cada sábado** fuera del gate `AUTO_APPLY_ENABLED`; `tf_sweep` reinicia el bot |
| **M5 Pine/docs** | 🟡 Pine ≠ TS; docs obsoletas | Momentum `zUp/zDn` (Pine) vs `Z` único (TS); `SKILL.MD` documenta un proyecto pre-trading |

---

## 2. Dedupe y causas raíz compartidas

Seis causas raíz explican ~40 de los ~60 hallazgos:

1. **La config no se propaga íntegra por las 3 capas** (Firestore → listener → `getConfigForTicker` → backtest/hyperopt → vivo). Manifiesto en M1 (H3 `zoneWeights`/`vwapPts`), M2 (`load_best_params` descarta 28/34), M3 (`handlePushToBot` omite `minScoreBuy/Sell`/`rider`/`disabledReason`/pisa `minimal_roi`). *Un solo fix de fondo: una capa de config canónica sin listas explícitas.*
2. **La "doble llave" del apagado es inconsistente** (debería ser `enabled:false + minScore:99`). Manifiesto en M1 (SMART ignora `enabled:false`), M3 (`PeriodicOptPanel` pone solo `minScore:99`), M4 (`apply_weekly` pone `enabled:true+minScore:99`; `apply_trigger_state.ts` —que sí la usa— está huérfano).
3. **El vivo no es la referencia** (Pine correcto, backtest correcto, vivo roto). M1 (H1 velas degeneradas), M2 (export usa velas completas), M5 (Pine ≠ TS). *El backtest mide la estrategia correcta; el vivo corre otra.*
4. **Config inválida/ausente → opera con defaults** (fail-open). M1 (C1 doc inválido descartado entero, C2 `enabled` ausente = habilitado), M4 (`directional_mcl_tune` escribió los objetos que rompieron C1), M3 (export omite campos).
5. **Día FX inconsistente**: M1 (N2 atribuye por apertura) + M2 (backtest ancla UTC-3 fijo vs `getFxDayStartMs` NY 17:00). Mismo bug en dos lados.
6. **Optimización sin validación OOS**: M2 (hyperopt in-sample) + M4 (`smc_tf_sweep` sin OOS + restart, `train_ml_weekly` split random 80/20).

**Contradicciones resueltas**: (a) `scripts/periodic_opt/.venv` — M4 lo asumió, M5 verificó en disco que **no existe** (usa `/usr/bin/python3`); M5 tiene razón. (b) "día FX 17:00 ART" (docs) vs "17:00 NY" (código) — el código manda (17:00 NY = 18:00 ART hoy, 19:00 ART desde 01-nov).

---

## 3. Plan de acción priorizado (impacto ÷ esfuerzo)

### Quick wins — esta semana, esfuerzo chico, riesgo bajo

| # | Cambio | Módulo | Sev | Archivos | Esfuerzo | Riesgo |
|---|---|---|---|---|---|---|
| 1 | **Congelar de verdad**: envolver `run_ks_sweep` y `run_directional_mcl_sweep` en `if AUTO_APPLY_ENABLED:` (y `--dry-run` en los scripts) | M4 | 🔴 | `run_weekly.py:770-785`, `killswitch_tune.ts`, `directional_mcl_tune.ts` | 15 min | Bajo (solo deja de escribir) |
| 2 | **H1 — arreglar las velas del motor vivo**: `>`→`>=` en `SMCManager.ts:119` + `close`=bid en `ctrader.ts:450`, luego `pm2 restart JARVIS` controlado | M1 | 🔴 | 2 archivos, 2 líneas | 30 min + 24h de validación | Medio (cambia el comportamiento del motor; validar con `grep -c SWEEP` y BOS BUY≈SELL) |
| 3 | **Config fail-closed**: listener que bloquea doc inválido + fallback `sessionEnabled:false` + `enabled === true` | M1 | 🔴 | `trading.ts:859-872,782` | 30 min | Bajo (los activos legítimos ya tienen `enabled` explícito tras la contención por datos) |

### Bugs que afectan dinero ya

| # | Cambio | Módulo | Sev | Esfuerzo | Riesgo |
|---|---|---|---|---|---|
| 4 | **ROI/RIDER cerrar de verdad** (`closePosition` antes de marcar WIN) | M1 | 🟠 | 20 min | Bajo |
| 5 | **Ráfaga de amends SL** (guard `slAmendInFlight` + no resetear retries en trailing) | M1 | 🟠 | 45 min | Bajo |
| 6 | **Lock leak** del Master Killswitch (`releaseLock` en los `return` de `:1196/:1200`) | M1 | 🟠 | 5 min | Bajo |
| 7 | **Carrera set/delete `active_trades`** (no persistir el pre-trade en `:1025`) | M1 | 🟠 | 5 min | Bajo |
| 8 | **Rollover DST-aware** (`minutesFromFxRollover` + ventanas relativas a 17:00 NY) — **antes del 01-nov** | M1 | 🟠 | 1 h | Bajo |
| 9 | **`handlePushToBot` no pisar `minimal_roi` + escribir campos omitidos** | M3 | 🔴 | 45 min | Bajo |
| 10 | **Rotar key Finnhub** + proxy server-side | M3 | 🔴 | 30 min | Bajo |

### Mejoras de proceso/automatización (no urgentes, antes de re-confiar en el optimizador)

| # | Cambio | Módulo | Sev |
|---|---|---|---|
| 11 | **Unificar y acotar el objetivo del hyperopt** (una fórmula, `expectancy` con tope, optimizar sobre OOS o walk-forward) | M2 | 🔴 |
| 12 | **`load_best_params` persistir los 34 params** + propagar `zoneWeights`/`vwapPts` al vivo (capa canónica) | M2+M1 | 🟠 |
| 13 | **Portar `getFxDayStartMs` al backtest** + `sessionEnabled` en el path principal | M2 | 🟡 |
| 14 | **Auto-disable reversible** (distinguir `disabledReason` auto de manual) | M4 | 🔴 |
| 15 | **Doble llave unificada** (enganchar `apply_trigger_state.ts`, corregir panel y `apply_weekly`) | M1+M3+M4 | 🟠 |
| 16 | **Frescura**: fetch fallido aborta el ciclo; gate AND (velas frescas obligatorias) | M4 | 🟡 |
| 17 | **Sincronizar timer/service fuente ↔ instalado** + documentar horario real | M4 | 🟠 |

### Deuda técnica / docs (cuando haya tiempo)

| # | Cambio | Módulo | Sev |
|---|---|---|---|
| 18 | Reescribir `SKILL.MD`/`SETUP.md` con el setup real + runbooks de rollback y fallo de Firestore | M5 | 🔴 |
| 19 | Divergencias Pine↔TS: decidir lado correcto (momentum, VWAP hard filter, sweeps) — **requiere input de Bon** | M5 | 🔴 |
| 20 | Bajar el log spam (`[CTRADER-TB]` 86 %, `[CONFIG]` 14 %; out.log 14 GB) + `pm2-logrotate` | M1 | 💡 |
| 21 | `telemetry` lost-update, `getOpenPositions [] = cerrada`, `checkVix` timeout | M1 | 💡 |

---

## 4. ¿Qué cambiaría primero si solo pudiera hacer 3 cosas?

1. **Congelar de verdad (M4)** — porque es lo único que está *activamente* escribiendo a Firestore contra la intención de Bon *ahora mismo*. Es la medida de seguridad inmediata: mientras exista, el "plan Paso 1" de contención no está completo.
2. **H1 — las velas del motor (M1)** — porque es la causa raíz de "el bot opera con señales malas y el backtest mide otra cosa". Todo lo demás (scores, gates, OTE) se decide sobre una señal de entrada podrida. Dos líneas + reinicio controlado.
3. **Config fail-closed + propagación (M1 C1/C2 + la capa canónica)** — porque ya costó 3 días de cuenta bloqueada (los JPY con defaults) y es la clase de bug que reaparece silenciosamente: cualquier campo mal tipado o faltante hace que un activo opere con reglas que nadie validó.

*(El objetivo divergente del hyperopt — T2 🔴 — es grave pero de proceso: no afecta la operación de esta semana mientras el optimizador esté congelado; entra sí o sí antes de volver a confiar en los proposals.)*

---

## 5. Anexo de trazabilidad — TODOS los hallazgos

**Estado**: `nuevo` (esta auditoría) · `verificar-previo` (auditoría jun-2026 sin confirmar) · `aplicado-datos` (contención por datos ya hecha).

| Sev | Módulo | archivo:línea | descripción | estado |
|---|---|---|---|---|
| 🔴 | M1 | `Types.ts:215`+`trading.ts:859,782` | Config inválida se descarta entera → fallback con defaults | aplicado-datos (fix código pendiente) |
| 🔴 | M1 | `SMCManager.ts:119`+`ctrader.ts:450` | Motor vivo: primer tick + close=low → velas degeneradas | nuevo |
| 🔴 | M1 | `trading.ts:872` | `enabled` ausente = habilitado → 4 fantasma | aplicado-datos (fix código pendiente) |
| 🟠 | M1 | `trading.ts:1412,1679` | ROI/RIDER "cierran" sin `closePosition` | nuevo |
| 🟠 | M1 | `trading.ts:1472` | Ráfaga de amends SL por ping sin guard de vuelo | nuevo |
| 🟠 | M1 | `trading.ts:1191` | Lock no liberado en `return` del Master Killswitch | nuevo |
| 🟠 | M1 | `trading.ts:1025` | Pre-trade OTE compite con delete → fantasmas | nuevo |
| 🟠 | M1 | `MLFilter.ts:84` | `predictProba` omite `base_score` | nuevo |
| 🟠 | M1 | `SMCManager.ts:83`+`SMCBridge.ts:80` | Última vela de sesión como señal fresca en reapertura | nuevo |
| 🟠 | M1 | `trading.ts:686` | `zoneWeights`/`vwapPts` no se propagan al vivo | nuevo |
| 🟠 | M1 | `trading.ts:3217`+`FrictionModel.ts:100` | Rollover fijo en UTC → se desfasa 01-nov | nuevo |
| 🟡 | M1 | `trading.ts:521` | Adopción `set()` sin merge pisa el journal | nuevo |
| 🟡 | M1 | `trading.ts:799` | Restore post-reinicio Regla D ignora la ventana | nuevo |
| 🟡 | M1 | `trading.ts:1173` | `isBacktest` por antigüedad del TS tras cola del lock | nuevo |
| 🟡 | M1 | `trading.ts:418` | Reconcile adopta sin gracia (orden en vuelo) | nuevo |
| 🟡 | M1 | `ctrader.ts:375` | PING "TF:15" transporta la vela M5 | nuevo |
| 🟡 | M1 | `SMCEngine.ts:347` | Z-score re-anclado → enfriamiento ≥5-6 velas | nuevo |
| 🟡 | M1 | `SMCManager.ts:36` | Bootstrap LTF con contexto HTF Neutral | nuevo |
| 🟡 | M1 | `MLFilter.ts:121` | `z_score`/`sweep_direction` constantes 0 | nuevo |
| 🟡 | M1 | `ctrader.ts:766` | `calculateLotSize` pip-value hardcodeado (JPY/cruces) | nuevo |
| 🟡 | M1 | `PortfolioModel.ts:158` | Killswitch atribuye por apertura (closedAt Timestamp) | nuevo |
| 🟡 | M1 | `trading.ts:2033` | rMultiple del SL usa precio teórico, no fill | nuevo |
| 🟡 | M1 | `ctrader.ts:1624` | `getOpenPositions []` = "cerrada" | nuevo |
| 🟡 | M1 | `ctrader_confirmation.ts:178` | Confirmación manual no re-ejecuta killswitches | nuevo |
| 💡 | M1 | `trading.ts:744`+`ctrader.ts:458` | Log spam 14 GB; comisión $10=1pip; cooldown hardcodeado | nuevo |
| 🔴 | M2 | `metrics.py:160` vs `worker.ts:212` | Objetivo divergente; metrics.py muerto | nuevo |
| 🔴 | M2 | `worker.ts:212` | `1.0·expectancy` sin cota domina | nuevo |
| 🔴 | M2 | `hyperopt_server.py:83-123` | 34 dims/~40 trades, split único in-sample (OOS PF=0) | nuevo |
| 🟠 | M2 | `load_best_params.py:62-74` | Persiste 6/34 params | nuevo |
| 🟠 | M2 | `hyperopt_server.py:108` | `minScoreToOverrideReject` con 15/20/25 inalcanzables | nuevo |
| 🟡 | M2 | `backtest_optimize_server.ts:113` vs `backtestEngine.ts:604` | gen `minimal_roi` GA muerto | nuevo |
| 🟡 | M2 | `backtestEngine.ts:420` | Frontera día FX UTC-3 vs NY 17:00 | nuevo |
| 🟡 | M2 | `backtestEngine.ts:322` | JPY usdjpy=154 hardcodeado | nuevo |
| 🟡 | M2 | `backtestEngine.ts:1205` | `sessionEnabled` no chequeado en path principal | nuevo |
| 🔴 | M3 | `BacktestingPanel.tsx:811` | Export pisa `minimal_roi` con default | nuevo |
| 🔴 | M3 | `macro_data.ts:6` | Key Finnhub en repo público | nuevo |
| 🟠 | M3 | `BacktestingPanel.tsx:849-855` | Export omite `minScoreBuy/Sell`/`rider`/`disabledReason` | nuevo |
| 🟠 | M3 | `PeriodicOptPanel.tsx:517` | Doble llave incompleta | nuevo |
| 🟠 | M3 | `AdminPanel.tsx:26-40` | Aliasing: OFF nace `enabled:true` | nuevo |
| 🟡 | M3 | `PeriodicOptPanel.tsx:512` | Propuesta a 1 sesión sin EXCLUDE | nuevo |
| 🟡 | M3 | `AutoTunePanel.tsx:66` | `handleApply` sin confirmación | nuevo |
| 🟡 | M3 | `BacktestingPanel.tsx` (varios) | Date/processedEvents sin guard; win rate diverge; mapas TF | nuevo |
| 🔴 | M4 | `run_weekly.py:772,785`+`killswitch_tune.ts:135`+`directional_mcl_tune.ts:136` | Congelado no congela: escriben Firestore cada sábado | nuevo |
| 🔴 | M4 | `apply_weekly.ts:146,280` | Auto-disable irreversible | nuevo |
| 🟠 | M4 | `apply_weekly.ts:232` | Apaga con `enabled:true+minScore:99` | nuevo |
| 🟠 | M4 | `jarvis-periodic-opt.timer` (repo) | Fuente desincronizado del instalado | nuevo |
| 🟠 | M4 | `smc_tf_sweep.ts:140` | Bruteforcer TF sin OOS + `pm2 restart` | nuevo |
| 🟠 | M4 | `export_smc_csv.ts:156,378` | Divergencias (SMC_DIV, `\| {ticker} \|`) vs vivo | nuevo |
| 🟠 | M4 | `m1_backtest.ts:156` | Orden intra-barra optimista; no es el backtest de validación | nuevo |
| 🟡 | M4 | `fetch_history.ts:97` | Dedupe favorece lo viejo; sin gaps | nuevo |
| 🟡 | M4 | `run_weekly.py:601,637` | Fetch no aborta; gate frescura OR | nuevo |
| 🟡 | M4 | `TimesfmFilter.ts:214` | Fail-open sin alarma proactiva | nuevo |
| 🟡 | M4 | `timesfm_bridge.py:230` | Timestamp apertura vs cierre | nuevo |
| 🟡 | M4 | `enable_shadow.js:47` | `set(merge:true)` borra overrides timesfm | nuevo |
| 🔴 | M5 | `Pine:396` vs `zscore.ts:40` | Momentum zUp/zDn vs Z único | nuevo |
| 🔴 | M5 | `order_blocks.ts:185` | VWAP hard filter vs scoring | nuevo |
| 🟠 | M5 | `liquidity.ts:358` | Gate \|Z\|≥2 solo en TS | nuevo |
| 🟡 | M5 | Pine vs `smc/*` | PEH/PEL/clusters/trendlines no portados; divergencias 5/5 vs 2/2 | nuevo |
| 🔴 | M5 | `SKILL.MD:1-172` | Documenta "Alejabot", no el bot | nuevo |
| 🔴 | M5 | `SETUP.md:46-50,11` | "Dominical" erróneo; Node 22 vs 24; omite services | nuevo |
| 🟠 | M5 | (ninguno) | Faltan runbooks rollback + fallo Firestore | nuevo |

### Hallazgos de auditorías previas (jun-2026) aún SIN verificar
(vienen de `AUDITORIA_COMPLETA.md`; la mayoría se solapan con lo de arriba, los listo para que no se pierdan):
- **P0#3** `trading.ts:1930-1950` — set() fire-and-forget pisa RAM (≈ la carrera `active_trades`, cubierta en M1).
- **P0#4** `trading.ts:270-330` — onSnapshot sin unsubscribe (**resuelto**: `unsubscribers[]`+`cleanupAndExit` en SIGTERM, verificado).
- **P1#5** `.catch(() => {})` silenciando errores (parcialmente presente).
- **P1#7** `BacktestingPanel.tsx:220-230` — worker sin timeout.
- **P1#10** `FundamentalTerminal.tsx:238-267` — fetchMacroData sin AbortController.
- **P1#11** `trading.ts:1945-1970` — trade huérfano en journal tras killswitch.
- **P1#12** `index.ts:40-70` — procesamiento concurrente sin límite.
- **P2#13-18** — swarm timeout 8s, polling journal sin debounce, autotune stub, sesión frontend desincronizada, setTimeout anti-patrón, webhook sin validación.
- **Integridad de datos** — `trade_journal` campos no leídos por frontend; `asset_configs` maxTradesPerDay vs maxSells/Buys; `backtesting_sessions` totalEvents vs totalTrades.

---

## Reglas del operador (recordatorio para la fase de aplicación)
1. Los cambios de **estrategia se backtestean ANTES de aplicar** (ej. tocar el scoring VWAP/momentum de M5, o la doble llave).
2. Los fixes de **código** van con aprobación explícita; los de **config** con rollout gradual (un activo, 1-2 días, luego el resto).
3. La contención por datos de M1 ya está hecha (backup en `/opt/JARVIS/backups/audit_t1_data_fix_*.json`); el resto de los diffs están en los 5 reportes.
