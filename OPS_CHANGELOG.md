# Cambios de operación — 02-nov-2026

## Evidencia mínima para toggles + arreglo TimesFM — 09-nov-2026

- El panel exige ahora evidencia mínima para activar/desactivar cualquier filtro:
  evaluación fresca (≤8 días) + muestra ≥30 trades (filterEvidence). Correlación (n=1-5),
  TimesFM (n=0) y rollover (sin datos) quedan bloqueados hasta tener evidencia real;
  el ML gate usa sinGate.n. Cada botón muestra el motivo del bloqueo.
- Arreglada la colecta de orígenes TimesFM (0 orígenes desde ~oct-2026). Dos causas:
  (1) collect_triggers pasaba el ticker en minúscula y el worker exige mayúscula,
  fallando init en silencio (process.exit(0) en finally); (2) el guard readOnlyReplayConfig
  borraba collectOnly/collectPath en evaluate. Se agregó el RPC dedicado collect_origins
  que preserva el modo collect restringido a logs/<ticker>/forecasts/triggers_m5.jsonl.
  La colecta vuelve a escribir orígenes (EURUSD: 30), con lo que TimesFM retoma datos.
- El gate ML sigue siendo honesto: el toggle cambia mlGateEnabled; el umbral runtime lo
  fija el modelo, no el botón (el Δ de R del sweep no se despliega con el toggle).

## Toggles de features restaurados (sin duplicar roster) — 07-nov-2026

- El panel Optimización Periódica vuelve a tener controles accionables: gate ML, filtro
  correlación, TimesFM, rollover A/D, políticas de salida, gatillos perdedores y promoción
  de Asset Scout. Cada acción exige evaluación fresca (≤8 días) + confirmación; escribe su
  config real (read-modify-write en TimesFM/loser) y el bot la toma en caliente.
- Gate ML honesto: el toggle cambia mlGateEnabled; el umbral runtime lo fija el modelo.
- El roster (activar/pausar activo) sigue en Salud de Activos como única fuente, sin duplicar.

## Incidente: ediciones concurrentes rompieron el hyperopt — 07-nov-2026

- El worker de hyperopt verifica (fail-closed) el hash de todo src/ y jarvis-os/src/ al
  inicializar y en cada evaluate. Editar el panel (jarvis-os/src/…) MIENTRAS corría el
  ciclo disparó `source snapshot changed after init` y tumbó 4 activos (AUDCAD/AUDJPY/
  AUDNZD/AUSTRALIA200) con ERROR, no por el fix de frescura sino por la edición concurrente.
- Lección: NO editar src/, jarvis-os/src/, scripts/hyperopt/ ni scripts/periodic_opt/
  mientras corre la optimización semanal. El código quedó commiteado antes de relanzar.
- Relanzamiento de recuperación: se detuvo el ciclo, se confirmó estado limpio (mark/PYDONE
  sin rescribir por el stop) y se volvió a iniciar con fuentes estables.

## Frescura durable + panel honesto — 07-nov-2026

- run_weekly.py usaba el timestamp del último intento como watermark; tras el 404 del
  viernes el reintento (mercado cerrado) creyó "sin datos nuevos" y omitió la selección
  de los 32 activos. Ahora selection_freshness.py mantiene un checkpoint de la última
  selección EXITOSA (vela + journal) separado del intento: ERROR/skip nunca avanzan el
  watermark, y sin evidencia se re-evalúa solo (sin --force). El reintento quedó
  respaldado en /var/lib/jarvis/recovery_rerun_2026-W45_* y relanzado; AUDCAD entró en
  hyperopt completo (400 trials), no en skip.
- run_detection_tune.sh propaga fallos del worker y no encadena health si algo falló.
  run_sweep_if_retrained.sh ya no corre detached (espera el sweep y persiste checkpoint).
  push_reports.js no publica selection_state privado.
- health_check.ts: el filtro "cuenta real" usa muestra cerrada y verificada única
  (descarta señales/backtests/duplicados/no-VERIFIED). Es orientativo; no autoriza real.
- Panel Optimización Periódica quedó en modo diagnóstico (sin escrituras): históricos
  fuera de active_tickers o >8 días excluidos, validación de selección ≠ OOS, Δ real,
  PnL negativo = mejora, HOLD_MC ambiguo no se etiqueta SIN EDGE, gatillos/ML no aplican
  cambios no certificados. Activación/roster derivados a Salud de Activos.
- Relanzamiento de recuperación de la semana 2026-W45: se limpiaron mark y PYDONE (con
  respaldo) y se inició el ciclo completo. La cadena sigue optimización → tune → health
  → digest al cierre.

## Digest al cierre real, no el lunes — 07-nov-2026

- Por pedido del operador: jarvis-health-weekly.service dispara jarvis-weekly-digest.service
  con OnSuccess y OnFailure, después de que el servicio finalice. El digest espera After=health.
  Salud → riesgo → shutdown → roster → aviso, sin esperar un día de la semana.
- Las tres propuestas ya no ignoran errores: si alguna falla, health queda failed, se
  detienen los posts restantes y el digest informa ciclo incompleto. No anuncia listo con
  propuestas parciales. Los fallos anteriores de ciclo/tune conservan sus avisos existentes.
- jarvis-weekly-digest.timer quedó disabled e inactive, sin próximo disparo. No hay envío
  adicional el lunes. La definición anterior se conserva para rollback.
- weekly_digest --cycle-close explica que ya se puede revisar Salud de Activos y Optimización
  Periódica; no aplica riesgos ni activaciones. Consulta config actual al contar fuera de roster.
  ExecCondition omitida se distingue de un fallo y un oneshot activating se informa en curso.
- Envío con timeout y validación real de HTTP + Telegram ok:true; no registra tokens ni cuerpos.
  Tests aislados de estados/entrega y typecheck estricto de los tres scripts: OK.
  systemd-analyze verify y comprobación de propiedades efectivas: OK.
- Se envió una vez el resumen actual mediante el servicio, sin rerun del optimizador/health:
  07-nov 09:16 ART, TELEGRAM_CONFIRMED, Result=success / ExecMainStatus=0.
- Respaldo previo en /var/lib/jarvis/digest_migration_20261107_131534.
  Configs desplegadas versionadas en scripts/ops/systemd/.

## Panel Salud de Activos — recomendación única (07-nov-2026)

- La recomendación operativa se calcula con roster_proposals, configuración real ON/OFF
  y evidencia reciente (8 días). TRADE: activar recomendado/mantener; WATCH/PARKED/OFF:
  pausar nuevas entradas o mantener apagado. Sin evidencia o con override: revisar.
- Si roster TRADE contradice riesgo NO_OPERAR se pide revisar viabilidad, no se ofrece
  activar recomendado. Diagnóstico de detección ya no usa OPERAR/APAGAR como etiquetas.
- Motivo y antigüedad visibles. Riesgo separado y su botón dice Aplicar solo riesgo.
  Acciones fuera de roster viven en Acciones manuales con confirmación de excepción;
  no escriben un rosterOverride ni convierten la propuesta en TRADE.
- Activación recomendada relee roster/health/config/riesgo al pulsar. Las acciones siguen
  siendo explícitas: el despliegue no cambia enabled, riesgos, propuestas ni posiciones.
- Pruebas: 19 casos puros, Vite build OK y navegador real (Puppeteer) sin errores.
  EUROPE50 WATCH muestra Mantener apagado (cluster lleno); ITALY40 TRADE Mantener activo;
  USTECH100 muestra Revisar por conflicto con riesgo NO_OPERAR. Excepción manual probada
  cancelando confirmación y verificando cero escrituras Firestore desde el navegador.
- npm run build (tsc -b) sigue bloqueado por seis errores existentes en backtestEngine.ts
  restaurado; ninguno en los archivos del panel modificados. No se alteró ese motor.

## Recuperación cTrader — 07-nov-2026

- Incidente: PM2 online pero autenticación de cuenta fallaba con CANT_ROUTE_REQUEST.
  Se observaron cientos de sockets TCP del mismo proceso: SDK connect() no devuelve
  su cliente cuando falla el auth y el caller no podía cerrar esos sockets.
- Verificación independiente, sin órdenes ni refresh de tokens: app/account auth OK,
  cero posiciones y cero órdenes. Posición 301741586 (GBPCHF) completamente cerrada;
  neto broker 0,88 USD coincide con el journal VERIFIED ZE8F2K.
- Registro activo FB3JE2 era un fragmento sin ticker/tradeId/direction. Se respaldó
  localmente en scratch/broker_recovery_20261107.json (0600) y en Firestore
  ops_recovery_archive/broker_20261107_FB3JE2 antes de retirarlo transaccionalmente.
  Journal y resultado económico preservados, sin duplicar PnL ni marcar SKIP.
- Conexión: el proceso ahora posee el cliente antes del handshake y lo desconecta
  ante fallo o timeout; mantiene autenticación y restauración de suscripciones en reconnect.
  Test aislado de cinco casos con cliente falso; no utiliza tokens reales ni envía órdenes.
- Se recuperó la conexión por reinicio controlado. El origen del rechazo transitorio
  del broker no está demostrado; la fuga de sockets sí queda corregida.
- El watchdog conserva por ahora su detección legacy basada en logs; no confundir
  accesibilidad TCP con autenticación efectiva de la cuenta.

Registro de los cambios de infraestructura hechos sobre el servidor (no viven en git,
pero acá queda el qué y el por qué). Todo es reversible.

## 1. Tune de detección: horario y presupuesto

- **Timer**: domingo **02:00 → 05:00** (`jarvis-detection-tune.timer.d/override.conf`).
  El ciclo del sábado (periodic-opt, 06:00) termina el domingo entre 01:26 y 08:54;
  a las 02:00 los dos jobs competían por CPU.
- **Timeout**: 6 h → 12 h → **18 h** (`jarvis-detection-tune.service.d/override.conf`).
  Medición real del 2-nov: 14 activos en **10 h 13 min** (14 h 28 min de CPU).
- ⚠️ **Lección**: `systemctl restart` sobre un timer con `Persistent=true` dispara el
  service de inmediato si hay una ventana vencida (pasó el 2-nov a las 00:39: arrancó
  una corrida completa, aplicó NZDUSD y reinició el bot a las 10:17). Para cambiar el
  horario sin correrlo: `systemctl stop`, editar, `start`.

## 2. Avisos y digest

- `opt_failure_notify.sh`: mensaje legible, unidad correcta (toma `MONITOR_UNIT` o la
  infiere de la unidad en `failed`) y `DRY_RUN=1` para probar.
- `jarvis-weekly-digest.timer`: **lunes 08:00**, digest por Telegram con estado de los
  jobs (incluye "no corrió"), candidatos, auto-aplicados, tests prospectivos, modelos,
  trades de la semana, abiertas, salud y tune.

## 3. Backup diario (estaba roto desde el 29-oct)

- Causa: `git add -A -- . ':!backups'` es **error de pathspec** (backups/ ya está
  ignorado) → la cadena `&&` cortaba antes del commit y el error iba a cron (sin MTA).
- Fix: commit diario 05:10 con log en `/var/log/jarvis_git_backup.log`.
- **El push a origin está desactivado a propósito**: el repo es **público**.

## 4. Seguridad

- `fail2ban` instalado y activo (jail sshd, `bantime=1d`, whitelist 138.219.212.0/24
  y loopback). Contexto: ~2.400 intentos SSH fallidos por día, todos rechazados
  (sshd ya es key-only, root sin password).
- `acct` (process accounting) activo: `lastcomm` permite auditar qué comando corrió
  cada usuario. Motivado por un reinicio del bot sin rastro el 2-nov.

## 5. Ciclo semanal: test prospectivo

- Drop-in `jarvis-periodic-opt.service.d/prospective.conf`: al final del ciclo corre
  `autoregister` → `evaluate` → `promote` → `model_health`, todos con `-` (un fallo
  no tumba el ciclo).

## 6. Integridad de modelos y presets (02-nov, código)

- `MLFilter.loadModelFromJSON`: **piso de evidencia** — no carga modelos con
  `accuracy < 0.55` o `train_samples < 50`; el ticker rechazado se marca para **no**
  caer al modelo DEFAULT (que es de otro activo) y usa la heurística.
- `train_ml_weekly.promote_candidate`: mismo piso antes de promover (devuelve
  `HOLD_SAMPLE` / `HOLD_ACCURACY`, no es un error del ciclo).
- `smc_config.loadOptimizedPreset`: avisa cuando un preset existe pero no tiene
  parámetros aplicables (caso `{}` de USTECH100/XPTUSD). Esos dos archivos se
  eliminaron: sin archivo, el motor usa el preset base (mismo comportamiento).
- Roster de entrenamiento: se agregaron XPDUSD y CHFJPY (los de más muestra).

## 7. Qué NO se tocó

- Push del backup a origin (el repo es público): pendiente de decisión.
- Modelos propios para el resto de los activos: no hay muestra suficiente (mismo
  techo que el optimizador).

## 7. Incidente del 02-nov 23:55 → 03-nov 00:00 (CLI de pm2 roto, sin downtime del bot)

**Qué pasó**: al crear un wrapper de auditoría en `/usr/local/bin/pm2` con `cat >`,
se escribió **a través del symlink** (`/usr/local/bin/pm2 → /root/.nvm/.../bin/pm2 →
../lib/node_modules/pm2/bin/pm2`), sobrescribiendo el CLI real con el wrapper. El
wrapper hacía `exec .../bin/pm2`, que ya era el wrapper → **recursión infinita**.
Todos los comandos `pm2` se colgaban (incluido `pm2 list`, `pm2 pid`, y el watchdog).

**Impacto**: ninguno sobre el bot — los procesos siguieron corriendo (uptime 13 h,
restarts 10 sin cambios). El daemon (God) estaba sano; solo el CLI quedó inutilizable.

**Fix**: se restauró `node_modules/pm2/bin/pm2` desde `npm pack pm2@7.0.3` (misma
versión que el daemon). Verificado con `pm2 list` (3 apps online).

**Lección**: antes de escribir un archivo con `>`, verificar que no sea symlink
(`ls -l`). Los wrappers van en un **nombre nuevo**: ahora existe `/usr/local/bin/pm2-audit`,
que loguea `user/uid/tty/ppid/args` en el journal (`journalctl -t pm2-audit`) y
ejecuta el pm2 real. Usar `pm2-audit restart JARVIS` para dejar rastro.

## 8. Cambio de cuenta — 03-nov-2026 (demo USD nueva)

- **Cuenta**: `traderLogin 5954670` → `ctidTraderAccountId **49413826**` (ojo: la API usa el
  ctidTraderAccountId, no el número de login). Demo Spotware, **USD, $5.000, 1:100**.
- `.env`: `CTRADER_ACCOUNT_ID=49413826`, `CTRADER_ACCESS_TOKEN=<nuevo>`, `CTRADER_DEMO=true`.
  Backup del anterior en `.env.bak-20261103-switch`.
- **Refresh token**: el viejo se dejó vacío al principio porque renovaba un token que cubre
  SOLO la cuenta anterior (verificado con `getAccountsByToken`). El mismo día se cargó el
  refresh de la nueva autorización (cubre 49413826) y se restauró la renovación automática.
  ⚠️ El refresh **rota** en cada uso: el par vigente es el último escrito en `.env`
  (backups: `.env.bak-20261103-switch`, `.env.bak-20261103-refresh`).
- **Archivo de datos de la cuenta vieja** (`account_reset.ts --archive --date 20261103`):
  trade_journal 182, execution_metrics 257, trigger_telemetry 65, opt_reports 34,
  detection_health 46, ml_gate_evals 28, corr_gate_evals 19, exits_gate_evals 13,
  timesfm_gate_evals 12, rollover_evals 3, optimization_rollouts 3, autotune_reports 2,
  ghost_positions 2, prospective_tests 2, detection_diagnostics 1, health_check 1 →
  `<coleccion>_archive_20261103`. `auto_state` reiniciado (sin aplicaciones heredadas).
  Se conservaron `asset_configs`, `app_settings`, `firebase_config`, `system`.
- **Backup previo**: `backups/firestore_export_20261103/` (22 colecciones, 811 documentos).
- Verificación post-switch: `Modo: DEMO`, `Moneda de la cuenta detectada: USD`,
  conversiones suscriptas USDCAD/USDJPY/EURUSD/NZDUSD/AUDUSD, `account_state` = 5000 USD.

## 9. Auditoría post-trade — 03-nov-2026

- `scripts/ops/trade_audit.ts` + `jarvis-trade-audit.timer` (cada 5 min). Avisa por Telegram
  **sólo si hay desvío**; si todo está bien, no manda nada.
- Por trade compara: presupuesto (`riskBudgetAccount`) vs `equity × requestedRiskPercent`
  (desvío > 5%), riesgo real congelado (`riskAmountAccount`) vs presupuesto (> 5%),
  riesgo real > 3,5% del equity, `riskAccountingStatus` ≠ VERIFIED, y slippage > 3 pips.
- Idempotente por `tradeId` (estado en `system/trade_audit`, poda a 500). Cubre trades
  abiertos y cerrados de las últimas 24 h (el journal conserva el riesgo).
- Verificado: autotest OK (caso sano y caso con 160% de desvío + slippage) y service
  corriendo con `Result=success`.

## 10. Falso positivo de la auditoría (JP225) — 03-nov-2026

Primer trade de la cuenta nueva: JP225 BUY, riesgo real 13,71 vs presupuesto 50 (−73%).
**No era un bug**: el bróker topa JP225 en `maxVolume = 10 lotes` por orden (lotSize 100),
y con SL de 216,4 pts y cotización en JPY eso son ~13,7 USD. Para arriesgar 50 hacían
falta ~36 lotes: imposible en una sola orden.

- `scripts/ops/symbol_caps.json`: topes por símbolo capturados del bróker
  (refrescables con `scripts/ops/symbol_caps_refresh.ts`).
- `trade_audit.ts` ahora distingue "sub-riesgo por tope del bróker" (no alerta) de un
  desvío real; sigue alertando por sobre-riesgo, slippage y contabilidad no verificada.
- Consecuencia estructural: JP225 nunca podrá arriesgar más de ~14 USD por orden en este
  bróker, sin importar el riesgo configurado.

## 11. Salud de activos: el veredicto del tune se borraba — 03-nov-2026

El panel está diseñado para mostrar `OPTIMIZABLE` / `CANDIDATO_APAGAR` después de
optimizar, pero el endpoint `/api/detection/optimize` corre `health 0` **después** del
tune y esa escritura ponía `status: OK|REVISAR` y `bestR: null`, borrando el veredicto.
Resultado: nunca se veía la recomendación.

- `smc_detection_search.ts`: el baseline ahora va en `baselineStatus` y el veredicto del
  tune en `status`; `health 0` **no pisa** `status` si ya hay un `bestR` (verificado con
  un doc sintético: bestR 7.5 / OPTIMIZABLE sobrevivió al health 0).
- El tune escribe `CANDIDATO_APAGAR` cuando el OOS no mejora (antes decía `REVISAR`) y
  agrega `tuneStatus` + `tunedAt`.
- `AssetHealthPanel`: el botón "Optimizar" ahora aparece también para activos **que están
  operando** en REVISAR (con confirmación, porque si aplica reinicia el bot), y la fila
  muestra "baseline: X" cuando el estado accionable difiere del baseline.

## 12. Roster: TRADE / WATCH / OFF y el mecanismo de "aparcar" — 05-nov-2026

Pregunta de Bon: ¿conviene operar muchos activos o solo los mejores? El optimizador semanal
NO elegía activos: optimizaba cada uno por separado y el auto-disable sólo actuaba con MC<80%
+ OOS<0 dos semanas. Con 15 activos y ~5 señales/día cada activo recibe 1-2 trades/semana →
imposible distinguir edge de ruido (la cuenta vieja hizo 4,1 trades/activo en 2 meses).

- `scripts/ops/roster_proposal.ts`: clasifica el pool con evidencia
  (mu = R/tr backtest, n, score = mu×√n, viabilidad por lote mínimo, shutdown_proposals):
  TRADE (mu≥0.05, n≥30, viable, máx 2 por cluster, máx 10) · WATCH (buena pinta sin muestra
  o cluster lleno) · OFF (edge negativo o inoperable). Publica `roster_proposals/*`.
- Mecanismo WATCH: `disabledReason: "watch: ..."` + `active_tickers = TRADE ∪ WATCH ∪ enabled`.
  El gate del semanal permite aplicar PARÁMETROS a un WATCH pero `apply_weekly` blinda
  `enabled` (nunca se activa solo). Los OFF-apagados salen del ciclo.
- 🐞 Fix de clusters en `riskClusterOf` (trading.ts): el patrón de 6 letras capturaba
  XAUUSD/XAGUSD/XPTUSD/XBRUSD/BTCUSD → el cap FX_USD 6% contaba oro y petróleo como FX.
  Ahora los checks específicos van primero (metales/energía/crypto/índices).
- Panel de Salud: badge de roster (👁 WATCH / ⚠️ fuera de roster / 🟢 roster TRADE).
- Digest semanal: línea "🎯 Roster: N TRADE · M WATCH · K OFF · operando fuera de roster: X".

Primera clasificación (05-nov): 6 TRADE (JP225, GBPAUD, EURUSD, NZDUSD, NL25, EUROPE50),
8 WATCH, 33 OFF; 9 activos operando fuera de roster (decisión del operador).

### 12b. Política de OFF vs WATCH (05-nov-2026)

Criterio de Bon: la historia vieja está sucia (el bot tenía bugs de ejecución), así que no
se abandona por poco. El baseline del roster es un **backtest re-corrido con el código y el
preset actuales** (los bugs viejos eran de ejecución, no del engine), así que es la señal
primaria; el journal viejo NO se usa para clasificar.

- OFF sólo con evidencia fuerte: lote mínimo inviable, o mu ≤ -0.10 con n ≥ 50, o
  shutdown_proposal PROPONER_APAGADO.
- WATCH todo lo demás (plano, fino, negativo leve, cluster lleno): se sigue backtesteando.
- TRADE: mu ≥ 0.05, n ≥ 30, viable, máx 2 por cluster, máx 10 (+ overrides del operador).

Resultado 05-nov: 9 TRADE · 23 WATCH · 15 OFF (active_tickers = 32). El ciclo del sábado
pasa a ~21 h (de 28 disponibles).

### 12c. PARKED + health semanal + OFF con evidencia viva (05-nov-2026)

Criterio de Bon: apagar de verdad exige evidencia VIVA, no sólo un backtest con la historia
vieja. Se agrega el estado PARKED y se separa "medir" (barato) de "optimizar" (caro):

- TRADE (9)  → operan + ciclo caro.
- WATCH (23) → no operan + ciclo caro (backtest semanal).
- PARKED (15)→ no operan, FUERA del ciclo caro, pero con health semanal (se siguen midiendo).
- OFF (0)    → sólo si μ ≤ -0.10 con n≥50 Y vivo con n≥20 y R/tr<0.

Medición semanal de todos (nuevo): `jarvis-health-weekly.timer` (domingo 03:00, ~45 min,
47 activos) corre run_detection_health.sh. Un PARKED que mejora su baseline pasa a WATCH
en la siguiente propuesta de roster.

🐞 Fix colateral: run_detection_health.sh y run_detection_tune.sh tenían
PATH=/home/bon/.nvm/versions/node/v24.18.0/bin (no existe en este host) → el health semanal
habría corrido con el node del sistema. Corregido a /root/.nvm/versions/node/v24.19.0/bin.

## 13. Organización del finde: pipeline encadenado tras el cierre — 06-nov-2026

El cierre del mercado es **19:00 ART** (17:00 NY = 22:00 UTC = 23:00 CET), no 18:00. Los
horarios previos (scout 23:00 ART, ciclo 02:00 ART, tune domingo, health lunes) dejaban el
trabajo repartido y el health caía el lunes.

Nuevo esquema (server CET, ART = CET-4):

  Vie 23:15 CET (19:15 ART)  Asset Scout
  Vie 23:45 CET (19:45 ART)  Ciclo semanal (→ ~20 h)
  OnSuccess → Tune detección (→ ~10 h, timeout 18 h)
  OnSuccess → Health + propuestas (roster/riesgo/apagado)
  Lun 08:00 CET (04:00 ART)  Digest (queda como reporte final)

- Los timers de detection-tune y health-weekly se desactivaron: ahora se disparan con
  `OnSuccess=` (systemd 255) al terminar el paso anterior. Sin solapamiento ni esperas.
- Trade-off: si el ciclo falla o se cuelga, la cadena no corre esa semana. El digest
  monitorea los tres jobs (se agregó Health + propuestas a la lista).

## 14. Auditoría externa (05-nov) — Lote 1 corregido

Auditoría independiente sobre HEAD 8666c71. Verificado cada hallazgo contra el código vivo.

- **H02 (mi bug)**: `retainExecutionIncident` decidía "rechazo terminal" con una regex sobre
  el texto, ANTES de mirar `executionUncertain`; un resultado incierto podía degradarse a
  "sin incidente" y el caller borraba la identidad del trade. Ahora exige evidencia
  ESTRUCTURADA del productor: `filledVolumeCents === 0` y `executionUncertain !== true`.
  El productor marca el rechazo con `brokerRejection` (ctrader.ts) y se propaga en los dos
  caminos (catch general y FILL_SAFETY con cierre de emergencia verificado).
- **H10 (mi bug)**: una corrida `NOT_APPLIED` no cerraba el estado `OPTIMIZANDO` y el health
  lo preservaba si había `bestR`. Ahora el tune escribe el estado de cierre y el health sólo
  preserva el veredicto cuando `tuneDecision === 'APPLIED'`.
- **H01**: la aprobación manual usaba el riesgo global, ignoraba el override por activo y no
  persistía `requestedRiskPercent`; los caps agregado/cluster sólo se aplicaban en AUTO.
  Ahora `effectiveRiskPercentFor()` es la única fuente de riesgo y los caps viven en
  `recheckLiveExecutionRisk(ticker, now, { extraRiskPercent, excludeTradeId })`, usado por
  AUTO y manual. Además el cap usa el riesgo configurado como fallback cuando un trade
  abierto no guardó el suyo (antes contaba 0 → subconteo).
- **H05**: `.env`, `firebase-key.json`, `service-account.json` y backups del entorno estaban
  en 0644 → ahora 0600.

Pendiente (Lote 2/3): H03 (MCL train-only), B4 (auto-disable es código muerto), D1 (scout
sin encadenar y health duplicado en el runner del tune), H06/H07/H08/H09/H11/H12.

### 14b. Auditoría externa — Lote 2 (05-nov)

- **H03**: `mcl_sync.ts` ya no aplica solo en el ciclo (el sweep es TRAIN-ONLY). El ciclo
  corre `--write` y publica `mcl_proposals/*`; aplicar es una acción manual (`--apply`),
  ahora transaccional (antes get/update podía dejar la sesión a medias).
- **B4**: se eliminó el bloque legacy de auto-disable de `apply_weekly.ts`. Era
  **inalcanzable** desde el refactor de rollout (main() delega y retorna antes). El apagado
  por evidencia queda como propuesta (`shutdown_proposal.ts`) y decisión del operador.
- **D1**: el ciclo arranca por `OnSuccess` cuando termina el Asset Scout (antes el scout
  tenía 8 h de timeout y podía solaparse); el timer del ciclo queda como red de seguridad.
  Se quitó el health-all duplicado del runner del tune (la cadena ya lo corre con propuestas).
- Digest: línea "🔧 MCL propuesto (sweep train-only): N valores" en lugar de "desactualizado".

### 14c. 2ª revisión de la auditoría — H01-b / H02-b (06-nov)

- **Manual no reservaba en RAM**: el cap leía el trade sin `requestedRiskPercent` y usaba el
  fallback (ignorando ×riskMult/×sesión). Ahora la aprobación reserva el presupuesto exacto
  en `globalState.activeTrades` ANTES de enviar (si falla, el trade se borra y libera).
- **AUTO revalidaba otra fórmula**: el closure recalculaba `effectiveRiskPercentFor()` en
  cada recheck. Ahora `frozenRequestedRiskPercent` se captura UNA vez y se usa en recheck,
  sizing y persistencia.
- **Candidatos consumían exposición**: el fallback contaba señales ignoradas/expiradas (sin
  reserva ni posición) hasta la limpieza de huérfanos (2 h). `computeOpenRisk()` excluye
  candidatos: sólo cuenta reserva en RAM o posición existente.
- **H02-b**: el productor ya no clasifica por texto en el camino FILL_SAFETY (allí HUBO fill
  y cierre verificado: no se emite `filledVolumeCents=0`). "Cerrada" ≠ "nunca tuvo fill".
- Nuevo `src/engine/RiskCaps.ts` (puro, sin efectos) + `scripts/ops/test_risk_caps.ts` con
  los 7 escenarios pedidos por el auditor (5 FX 1,5%, candidatos, posición sin reserva,
  exclude, clusters, rechazo terminal, texto sin evidencia).

### 14d. 3ª revisión — D1-b / H03-b (06-nov)

- **D1-b (HIGH)**: el timer del ciclo podía solaparse con el scout y no había dedupe semanal.
  Nuevo `scripts/periodic_opt/run_weekly_guard.sh` como ExecStart del ciclo:
  espera al scout (máx 3 h), `flock -n` (si ya corre otro, sale), marca ISO `YYYY-Www` en
  /var/lib/jarvis (se escribe SÓLO si run_weekly terminó OK) y `--check` para tests.
  Los timers siguen como respaldo: el wrapper deduplica. Verificado: con lock ocupado → skip;
  con marca de la semana → skip; `--force` lo ignora.
- **H03-b (MED)**: `--apply` ahora consume las PROPUESTAS PUBLICADAS (lo que vio el
  operador), no el sweep actual; una transacción por propuesta (todos sus diffs + applied),
  conflicto si el campo cambió desde la publicación, frescura ≤8 días.
  `--write` publica SIEMPRE el resumen (también con 0) y marca `superseded` las propuestas
  que ya no tienen diferencias (antes el digest anunciaba propuestas viejas).
- Lógica pura en `scripts/ops/mcl_proposal_core.ts` + `test_mcl_proposal.ts` (5 casos).

### 14e. 4ª revisión — guarda v2 (D1-c) + versión de propuesta MCL (H03-c)

- **D1-c (HIGH)**: `is-active` no veía `activating` (el scout es `Type=oneshot`) → el ciclo
  podía arrancar en paralelo. La guarda v2 detecta `active|activating|reloading|deactivating`
  y FALLA CERRADO ante `unknown`/error de systemd. Además el límite de espera era 6 min por un
  error de unidades; ahora 3 h reales con `SECONDS`.
- **D1-c (HIGH)**: un `skip` con exit 0 hacía correr los `ExecStartPost` y `OnSuccess`.
  Nuevo drop-in `05-guard.conf` con `ExecCondition=run_weekly_guard.sh --condition`: si no
  corresponde correr, systemd OMITE la unidad completa (sin Python, sin postprocesos, sin
  tune). ExecCondition se evalúa ANTES de ExecStartPre (incluido el autotune).
- **H03-c (HIGH)**: la propuesta se leía fuera de la transacción y se marcaba el doc B con
  los valores de A. Cada propuesta lleva ahora `proposalId` inmutable y la transacción relee
  el doc: si cambió la versión, está aplicada u obsoleta → aborta. `appliedProposalId` queda
  registrado.
- **H03-c (MED)**: la rama `--apply` se movió ANTES de leer el sweep: aplicar una propuesta
  publicada ya no depende de que los JSON del sweep existan o parseen. Verificado renombrando
  `opt_out/` (aplicó igual).
- Test: propuesta no-op para US500 → aplicada con `appliedProposalId` y sweep inaccesible.

### 14f. 5ª revisión — cadena real y sello de la unidad (D1-d)

- **Verificado empíricamente** en este systemd 255: una unidad omitida por `ExecCondition`
  termina con `Result=success` y **IGUAL dispara `OnSuccess`** (test A/B: B-RAN). Por eso
  `OnSuccess=jarvis-detection-tune` se eliminó del ciclo: encadenaba el tune aunque el ciclo
  se omitiera.
- Encadenamiento nuevo: `zz-chain.conf` (corre ÚLTIMO) → `mark_weekly_done.sh` + `systemctl
  start --no-block jarvis-detection-tune`.
- La marca semanal ya no la escribe el guard tras Python: la escribe el último ExecStartPost
  (`mark_weekly_done.sh`), que sólo corre si TODOS los pasos obligatorios terminaron bien
  (systemd omite los post restantes ante un fallo). Antes, si `push_reports` fallaba, la
  marca quedaba y el reintento se omitía.
- **PYDONE**: si Python terminó OK y falló un post, el reintento re-ejecuta sólo los
  postprocesos (no repite las ~20 h de optimización). Probado: "retry: la optimización de
  2026-W45 ya terminó; se re-ejecutan sólo los postprocesos".
- **Respaldo**: nuevo `jarvis-periodic-opt-fallback.timer` (sáb 03:30 CET, `Unit=` el ciclo)
  para el caso "scout lento/fallido y el timer del viernes fue omitido". El scout ahora tiene
  `OnFailure=jarvis-opt-failure-notify`.

### 14g. 6ª revisión — persistencia comprobada y continuación recuperable (D1-e)

- **Sello comprobado**: `chain_mark_and_tune.sh` escribe la marca de forma atómica
  (tmp+mv) y hace readback; cualquier fallo → exit != 0. El paso perdió el prefijo `-`:
  si no se puede sellar, la unidad FALLA (no se anuncia éxito sin checkpoint).
- **PYDONE comprobado**: si el guard no puede persistir el checkpoint, el ciclo falla (un
  reintento repetirá la optimización, que es lo seguro).
- **Continuación recuperable**: antes de sellar se persiste `weekly_tune_pending` con la
  semana; el tune se encola después. Si el encolado falla o el host cae entre medio, un
  timer nuevo (`jarvis-weekly-continuation.timer`, sáb 04/06/08/10 y lun 06 CET) reintenta
  el encolado de forma idempotente (si el tune ya está activo, limpia la obligación).
- Nota: el sello acredita los pasos OBLIGATORIOS (los `-` de ML/evals/MCL siguen siendo
  best-effort deliberado).

### 14h. 7ª revisión — identidad de corrida y estados durables (D1-f)

El auditor pidió la corrección estructural: una identidad compartida con el consumidor y un
registro durable de estados (no más `if`s sobre archivos sueltos).

- `weekly_continuation.json` (write atómico + readback): `{runId, week, state, createdAt,
  startedAt, completedAt, attempts}`. Estados: pending → started → completed/failed → expired.
- `chain_mark_and_tune.sh` genera el runId y deja el registro en `pending`; **ya no lo borra
  al encolar** (un arranque aceptado no es recepción durable).
- El tune corre bajo `tune_run_wrapper.sh`: registra `started` al comenzar y
  `completed`/`failed` al terminar, ligado al runId. Un tune **manual** (sin runId) no
  consume la obligación.
- `recover_tune_pending.sh`: pending→reencola; started+unidad inactiva→interrumpida→reencola;
  completed→limpia **sin re-ejecutar**; failed→reintento acotado (3); antigüedad >5 días o
  intentos excedidos→`expired` con aviso (ya NO se descarta por cambio de semana ISO: un
  pendiente del sábado se recupera el lunes).
- Digest: línea "🔁 Continuación al tune: <estado>".
- `scripts/ops/test_weekly_continuation.sh`: 13 casos (incluye las 4 pruebas pedidas).

### 14i. 8ª revisión — consumidor robusto y detección de "completado real" (D1-g)

- **Wrapper**: si no puede persistir `completed`/`failed`, escribe `stale` como fallback y
  deja el aviso; nunca miente con un `warn` silencioso.
- **Recuperación**:
  · `started`/`stale` + unidad inactiva → mira `Result` de la unidad: `success` ⇒ REPARA el
    registro como `completed` y limpia **sin re-ejecutar** (antes un tune completado sin
    registro se clasificaba "interrumpido" y se volvía a lanzar, 10-18 h).
  · `pending` + unidad activa → `running`, sin incrementar intentos (antes cada timer
    acercaba a `expired` una obligación en curso).
  · `expired` → exit 1 (consistente con las otras expiraciones: "requiere atención").
- **Semántica documentada del tune manual**: un `systemctl start` manual SIN `tune_run_id`
  no consume la obligación semanal; CON un `tune_run_id` pendiente, la consume (el tune
  corrió). Cubierto por tests.
- Test ampliado a 18 casos (systemd simulado con TUNE_STATE_CMD/TUNE_RESULT_CMD).

### 14j. 9ª revisión — evidencia positiva de salida (D1-h)

- **`Result=success` no prueba nada**: verificado en el host, la unidad tune aparece con
  `Result=success`, `ExecMainStatus=0` y **`ExecMain*Timestamp` vacíos** (nunca corrió en
  este boot). Reparar por `Result` convertía un crash durante el tune en una omisión
  silenciosa de la semana.
- Ahora la reparación exige evidencia POSITIVA: `ExecMainStartTimestamp` y
  `ExecMainExitTimestamp` presentes y `ExecMainStatus=0`. Sin evidencia → `interrupted` →
  se reencola (dirección segura).
- La reparación propaga el fallo de escritura: si no puede persistir, **conserva el registro**
  y sale 1 (antes hacía `|| true` y borraba igual).
- Restaurado el bit ejecutable de `recover_tune_pending.sh` y del test.
- Test: 14 escenarios / 21 asserts (incluye los 4 casos pedidos; el conteo anterior de "18"
  era de asserts, no de escenarios).

### 14k. Cierre de D1 (10ª revisión) + LOW cosmético

- El auditor **acepta el lote 2h**: D1 queda cerrado desde la máquina de estados de
  continuación (runId + estados durables + evidencia positiva de salida).
- LOW corregido: el mensaje distingue "failed (salió con status N en este boot)" de
  "interrupted (sin evidencia de salida / crash-reboot)". El comportamiento ya era correcto.
- Caveat H07 anotado por el auditor: `completed` es proxy del exit code del wrapper; si el
  pipeline del tune traga errores de activos, "success" no garantiza el trabajo completo.
  Es exactamente el hallazgo H07 del informe original → va en el Lote 3.

### 15. Lote 3 (Fase B) — H04/H06/H07/H08/H09/H11/H12

- **H04** (HIGH): apply del preset ahora atómico y con CAS: lock O_EXCL (`node:fs` no tiene
  flock), stale >2h, backup versionado `.bak-<ts>`, tmp+rename, readback y `configFingerprint`
  en `DetectionMeta`. Nuevo `scripts/ops/preset_apply_core.ts`.
- **H06**: los contadores BUY/SELL/rachas devuelven `null` cuando la lectura es desconocida
  (antes 0 = fail-open). En live la entrada se retiene (`*_COUNT_UNKNOWN`, alerta 1/h); en
  backtest se trata como 0 para no sesgar el replay.
- **H07**: si el health no puede persistir, el job FALLA (exit 1) y systemd no corre las
  propuestas; además los consumidores ignoran health sin fecha o >8 días (`isHealthFresh`).
- **H08**: muestra viva filtrada: fuera backtesting, duplicados, no cerrados y sin
  contabilidad VERIFIED; dedupe por posición. Log de composición en ambos scripts.
- **H09**: la racha de semanas negativas exige semanas CONTIGUAS (7 d��as exactos) y el
  dry-run lee el historial igual que `--write` (`countConsecutiveNegativeWeeks`).
- **H11**: singleflight en el refresh del token (auto-renewal/connect/retry convergen) y
  escritura del `.env` atómica (tmp+fsync+rename), modo 0600, backup 0600 y readback.
- **H12**: el mínimo viable se compara contra la PROPUESTA FINAL capada, no contra Kelly sin
  cap (caso mínimo 4% + Kelly 5% → ya no propone 3%).
- Tests nuevos: `test_detection_apply`, `test_counters_failclosed`, `test_health_freshness`,
  `test_health_runner`, `test_live_sample`, `test_shutdown_weeks`, `test_token_singleflight`,
  `test_risk_allocator`. Suite completa: 10 tsx + 2 shell + integridad semanal en verde.

### 15b. Residuales de la revisión del Lote 3

- **H04 fingerprints honestos**: `DetectionMeta.presetFingerprint` (sha del archivo) y
  `configFingerprint` (sha de la CONFIG realmente evaluada, `jsonSha(config)`). Antes el
  campo `configFingerprint` guardaba el sha del preset (nombre engañoso).
- **H04 preset nuevo**: si no había preset al evaluar, `expectedSha=''` y el CAS aborta si
  alguien lo crea durante la búsqueda (10-18 h). Test nuevo.
- **H07 stale visible**: los consumidores ya no omiten en silencio; loguean
  `⚫ SIN_DATOS por health stale (>8 días): N activo(s) · ...` en roster/allocator/shutdown.
- **H09**: `WEEKS_KEEP=52` usado explícitamente por `mergeWeek` (antes la constante era
  muerta y la retención quedó en el default).
- **H06 debug**: `trading_debug.ts` queda marcado como script de debug fail-open (no live),
  con warning explícito para no cablearlo sin el patrón number|null.
- Pendiente declarado (fuera de este lote): paridad de config del tune (`buildConfig()`
  genérico vs `asset_configs` real) — es la parte "propuesta" del plan de H04.

### 15c. Revisión 3b — bug de tipo en risk_allocator + hueco de verificación

- **Bug real**: `staleHealth.push(ticker)` en `risk_allocator.ts` (ahí la variable es
  `doc.id`). Compilaba con tsx (esbuild no chequea tipos) y habría crasheado justo en la
  rama de health stale. Corregido a `doc.id`.
- **Por qué no lo vi**: el `tsconfig.json` incluye sólo `src/**`, así que
  `npx tsc --noEmit` NUNCA chequeó los scripts. Nuevo `scripts/ops/typecheck_scripts.sh`
  (strict, por archivo) — hoy en verde para los 21 archivos del lote, incluidos 4 errores
  pre-existentes que aparecieron al activarlo (`adr` possibly undefined ×2 + implicit any ×2).
- **`trading_debug.ts`**: el warning H06 ahora SÍ está en el archivo (en 15b el changelog lo
  declaraba pero el edit no se aplicó porque el script de parcheo había abortado antes).

### 15d. Cierre del Lote 3 (revisión 3c aprobada)

- Changelog corregido: eran **4** errores pre-existentes (adr ×2 + implicit any ×2), no 3.
- `typecheck_scripts.sh` cableado: `npm run typecheck:scripts` + paso semanal en el ciclo
  (`ExecStartPost=-.../typecheck_scripts.sh`, antes del sello; no bloqueante y queda en el
  journal). Sigue sin ser un gate duro de CI/pre-commit: es una red semanal, no un bloqueo.
