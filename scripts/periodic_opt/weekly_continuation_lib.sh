#!/bin/bash
# Estado durable de la continuación ciclo→tune (revisión 7, 06-nov-2026).
# Identidad de corrida compartida: runId, semana, estado y timestamps en un único registro.
# Escritura atómica (tmp+mv) + readback. Los tests pueden sobreescribir CONT_DIR.
CONT_DIR="${CONT_DIR:-/var/lib/jarvis}"
CONT_FILE="$CONT_DIR/weekly_continuation.json"
TUNE_ID_FILE="$CONT_DIR/tune_run_id"

wc_uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || date -u +%s%N; }
wc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# cont_read '.state'  → valor o cadena vacía
cont_read() {
  [ -f "$CONT_FILE" ] || { echo ""; return 0; }
  jq -r "(${1}) // empty" "$CONT_FILE" 2>/dev/null || echo ""
}

# cont_write [--arg ...] '<programa jq>' → escribe atómico y verifica.
# El programa jq es el ÚLTIMO argumento (los --arg van antes).
cont_write() {
  [ "$#" -ge 1 ] || return 1
  local prog="${*: -1}"
  local opts=("${@:1:$#-1}")
  local cur tmp
  mkdir -p "$CONT_DIR" 2>/dev/null || return 1
  cur='{}'
  [ -f "$CONT_FILE" ] && cur=$(cat "$CONT_FILE" 2>/dev/null || echo '{}')
  tmp=$(printf '%s' "$cur" | jq -c "${opts[@]}" "$prog" 2>/dev/null) || return 1
  printf '%s\n' "$tmp" > "$CONT_FILE.tmp" 2>/dev/null || return 1
  mv -f "$CONT_FILE.tmp" "$CONT_FILE" 2>/dev/null || return 1
  [ "$(cat "$CONT_FILE" 2>/dev/null)" = "$tmp" ] || return 1
  return 0
}
