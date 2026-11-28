#!/bin/bash
# Aviso por Telegram cuando falla una unidad programada de JARVIS.
# Soporta unidad templada jarvis-opt-failure-notify@%n.service (%i pasa la unidad exacta,
# evitando "multiple trigger source candidates for exit status propagation" de systemd).
# Identifica explícitamente: unidad, etapa, ticker(s) y causa verificada.
#
# Env para tests: DRY_RUN=1, MARK_DIR, WEEKLY_SUMMARY, REPORTS_DIR, SYSTEMCTL_SHOW_CMD,
#                 JOURNALCTL_CMD, TELEGRAM_API_BASE, ENV_FILE
set -u

REPO="${REPO:-/opt/JARVIS}"
MARK_DIR="${MARK_DIR:-/var/lib/jarvis}"
SUMMARY_FILE="${WEEKLY_SUMMARY:-$REPO/scripts/periodic_opt/opt_out/weekly_selection_summary.json}"
REPORTS_DIR="${REPORTS_DIR:-$REPO/scripts/periodic_opt/reports}"
ENV_FILE="${ENV_FILE:-$REPO/.env}"
TELEGRAM_API_BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}"

UNIT="${1:-${MONITOR_UNIT:-}}"
if [ -z "$UNIT" ]; then
  UNIT=$(systemctl list-units 'jarvis-*.service' --state=failed --plain --no-legend 2>/dev/null \
         | awk 'NR==1{print $1}')
fi
[ -z "$UNIT" ] && UNIT="jarvis-periodic-opt.service"
case "$UNIT" in *.service) ;; *) UNIT="${UNIT}.service" ;; esac

if [ -n "${SYSTEMCTL_SHOW_CMD:-}" ]; then
  SHOW_OUT=$($SYSTEMCTL_SHOW_CMD "$UNIT" 2>/dev/null || echo "")
else
  SHOW_OUT=$(systemctl show "$UNIT" -p Result -p ExecMainStatus -p ExecMainCode -p TimeoutStartUSec -p SubState 2>/dev/null || echo "")
fi
get_prop() {
  printf '%s\n' "$SHOW_OUT" | awk -F= -v k="$1" '$1==k { sub(/^[^=]*=/, ""); print; exit }'
}

SVC_RESULT="${MONITOR_SERVICE_RESULT:-$(get_prop Result)}"
EXIT_STATUS="${MONITOR_EXIT_STATUS:-$(get_prop ExecMainStatus)}"
TIMEOUT_LIM="$(get_prop TimeoutStartUSec)"

case "$UNIT" in
  jarvis-detection-tune.service)
    TITULO="el tune semanal de detección SMC"
    ETAPA_DEFAULT="detection_tune"
    IMPLICA="la búsqueda quedó cortada: activos sin re-tunear y el panel de salud sin refrescar. El bot sigue operando con los presets vigentes."
    ;;
  jarvis-periodic-opt.service)
    TITULO="el ciclo de optimización semanal"
    ETAPA_DEFAULT="periodic_opt"
    IMPLICA="el ciclo no cerró ni selló la semana. El bot sigue operando con la configuración vigente."
    ;;
  jarvis-asset-scout.service)
    TITULO="el screening de activos (Asset Scout)"
    ETAPA_DEFAULT="asset_scout"
    IMPLICA="no se propusieron candidatos nuevos esta semana. No afecta la operación."
    ;;
  jarvis-weekly-continuation.service)
    TITULO="la recuperación de continuación al tune"
    ETAPA_DEFAULT="continuation_recovery"
    IMPLICA="la obligación ciclo→tune venció o no pudo encolarse; requiere revisión."
    ;;
  jarvis-health-weekly.service)
    TITULO="el health semanal y propuestas"
    ETAPA_DEFAULT="detection_health_proposals"
    IMPLICA="cobertura de salud incompleta o fallo al publicar propuestas."
    ;;
  *)
    TITULO="$UNIT"
    ETAPA_DEFAULT="servicio"
    IMPLICA="revisar el journal de la unidad."
    ;;
esac

case "$SVC_RESULT" in
  timeout)
    case "$TIMEOUT_LIM" in ''|infinity) RES_TXT="timeout — superó el tiempo máximo permitido" ;;
      *) RES_TXT="timeout — superó el límite de ${TIMEOUT_LIM}" ;;
    esac
    ;;
  exit-code) RES_TXT="terminó con error (exit ${EXIT_STATUS:-?})" ;;
  signal)    RES_TXT="interrumpido por señal (${EXIT_STATUS:-?})" ;;
  ''|success) RES_TXT="fallo reportado por OnFailure (${SVC_RESULT:-desconocido}, exit ${EXIT_STATUS:-?})" ;;
  *)         RES_TXT="${SVC_RESULT} (exit ${EXIT_STATUS:-?})" ;;
esac

if [ -n "${JOURNALCTL_CMD:-}" ]; then
  RAW_J=$($JOURNALCTL_CMD "$UNIT" 2>/dev/null || echo "")
else
  RAW_J=$(journalctl -u "$UNIT" -n 250 --no-pager -o cat 2>/dev/null || echo "")
fi

ETAPA="$ETAPA_DEFAULT"
TICKERS_AFECTADOS=""
CAUSA=""

if [ "$UNIT" = "jarvis-periodic-opt.service" ]; then
  DIAG=$(python3 - "$MARK_DIR" "$SUMMARY_FILE" "$REPORTS_DIR" <<'PY' 2>/dev/null
import json, pathlib, sys
mark_dir, summary_file, reports_dir = map(pathlib.Path, sys.argv[1:4])
ctx_file = mark_dir / 'weekly_cycle_context.json'
stage = ''
tickers = []
cause = ''
if ctx_file.exists() and summary_file.exists():
    try:
        ctx = json.loads(ctx_file.read_text())
        s = json.loads(summary_file.read_text())
        if s.get('cycle_run_id') == ctx.get('run_id'):
            errs = s.get('errors') or []
            if errs:
                stage = 'run_weekly (evaluación por activo)'
                tickers = list(errs)
                reasons = []
                for t in errs[:3]:
                    rp = reports_dir / f'{t}.json'
                    if rp.exists():
                        rd = json.loads(rp.read_text())
                        r = rd.get('deployment_error') or rd.get('reason') or rd.get('status')
                        if r:
                            reasons.append(f'{t}: {str(r)[:180]}')
                if not reasons:
                    for o in s.get('outcomes') or []:
                        if o.get('ticker') in errs and (o.get('deployment_error') or o.get('reason')):
                            reasons.append(f"{o['ticker']}: {str(o.get('deployment_error') or o.get('reason'))[:180]}")
                cause = ' | '.join(reasons)
            elif s.get('error'):
                stage = 'run_weekly (preflight/fetch)'
                cause = str(s['error'])[:220]
            elif s.get('status') == 'completed':
                stage = 'ExecStartPost (publicación o sellado)'
    except Exception as exc:
        cause = f'diagnóstico resumen: {exc}'
print(json.dumps({'stage': stage, 'tickers': ', '.join(tickers), 'cause': cause}))
PY
)
  if [ -n "$DIAG" ]; then
    D_STAGE=$(printf '%s' "$DIAG" | jq -r '.stage // ""' 2>/dev/null || echo "")
    D_TICKERS=$(printf '%s' "$DIAG" | jq -r '.tickers // ""' 2>/dev/null || echo "")
    D_CAUSE=$(printf '%s' "$DIAG" | jq -r '.cause // ""' 2>/dev/null || echo "")
    [ -n "$D_STAGE" ] && ETAPA="$D_STAGE"
    [ -n "$D_TICKERS" ] && TICKERS_AFECTADOS="$D_TICKERS"
    [ -n "$D_CAUSE" ] && CAUSA="$D_CAUSE"
  fi
fi

# Refinar etapa/ticker/causa desde el journal si aún faltan
if printf '%s\n' "$RAW_J" | grep -aqE 'No se publican reportes|Publicación incompleta|Readback falló tras publicar opt_reports'; then
  ETAPA="push_reports (publicación Firestore)"
elif printf '%s\n' "$RAW_J" | grep -aqE 'no se sella ni encola tune|obligación queda pending'; then
  ETAPA="chain_mark_and_tune (sellado/encolado)"
elif printf '%s\n' "$RAW_J" | grep -aqE 'IMPORTS ROTOS|ARCHIVOS DEL CICLO FALTANTES|RUTAS KRONOS'; then
  ETAPA="ExecStartPre (check_bot_deps)"
fi

if [ -z "$TICKERS_AFECTADOS" ]; then
  TICKERS_AFECTADOS=$(printf '%s\n' "$RAW_J" \
    | sed -nE 's/^ERROR ([A-Z0-9]+):.*/\1/p; s/^TUNE_FAILED: ([A-Z0-9]+).*/\1/p; s/^HEALTH_FAIL ([A-Z0-9]+).*/\1/p' \
    | awk '!seen[$0]++' | tr '\n' ',' | sed 's/,$//; s/,/, /g')
fi

if [ -z "$CAUSA" ]; then
  CAUSA=$(printf '%s\n' "$RAW_J" \
    | grep -aE '^(ERROR |fail:|abort:|expired:|TUNE_FAILED:|TUNE_JOB_FAILED:|HEALTH_FAIL|HEALTH_JOB_FAILED:|cycle evidence invalid:)' \
    | tail -1 | cut -c1-220)
fi

CPU=$(printf '%s\n' "$RAW_J" | grep -a 'Consumed .* CPU time' | tail -1 | sed -E 's/.*Consumed (.*) CPU time.*/\1/')
LINES=$(printf '%s\n' "$RAW_J" \
  | grep -avE 'expired_forming_bar|no mapeado|\[CTRADER-TB\]|\[SMC-ENGINE\]|\[SMC-GATES\]|\[CONFIG\]|Applied Detection params|Loaded optimized preset|"[A-Za-z_]+":' \
  | grep -avE '^[A-Za-z0-9_.@-]+\.service: |^(Failed to start|Finished |Starting |Stopping |Deactivated |Triggering )' \
  | awk 'length($0) > 150 { print substr($0,1,147) "..." ; next } { print }' \
  | grep -avE '^[[:space:]]*$' \
  | tail -3 | sed 's/^/• /')

MSG="🚨 JARVIS — falló ${TITULO}
🕒 $(date '+%d/%m %H:%M %Z')
📄 Unidad: ${UNIT}
🧭 Etapa: ${ETAPA}
🎯 Activo(s): ${TICKERS_AFECTADOS:-n/a}
🧾 Resultado: ${RES_TXT}
💥 Causa: ${CAUSA:-revisar últimas líneas del journal}
⚠️ Qué implica: ${IMPLICA}"
if [ -n "${CPU:-}" ]; then
  MSG="${MSG}
⏱ CPU consumida: ${CPU}"
fi
if [ -n "$LINES" ]; then
  MSG="${MSG}
🔍 Últimas líneas:
${LINES}"
fi
MSG="${MSG}
🛠 Revisar: journalctl -u ${UNIT} -n 50"

if [ "${DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' "$MSG"
  exit 0
fi

TOKEN=$(grep -oE 'TELEGRAM_BOT_TOKEN="[^"]+"' "$ENV_FILE" 2>/dev/null | head -1 | sed 's/TELEGRAM_BOT_TOKEN="//; s/"$//')
CHAT_ID=$(grep -oE 'TELEGRAM_ALLOWED_USER_IDS="[^"]+"' "$ENV_FILE" 2>/dev/null | head -1 | sed 's/TELEGRAM_ALLOWED_USER_IDS="//; s/"$//')
CHAT_ID="${CHAT_ID:-1348898450}"
if [ -z "$TOKEN" ]; then
  echo "fail: falta TELEGRAM_BOT_TOKEN en $ENV_FILE" >&2
  exit 1
fi
RESP=$(curl -sS -m 20 -X POST "${TELEGRAM_API_BASE}/bot${TOKEN}/sendMessage" \
  -d chat_id="$CHAT_ID" \
  --data-urlencode "text=${MSG}") || {
  echo "fail: error de red enviando alerta a Telegram" >&2
  exit 1
}
if ! printf '%s' "$RESP" | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "fail: Telegram rechazó la alerta: $RESP" >&2
  exit 1
fi
exit 0
