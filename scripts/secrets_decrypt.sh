#!/usr/bin/env bash
# Desencripta los .env desde secrets/*.enc (recuperación de desastre).
# Uso: bash scripts/secrets_decrypt.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ] && [ -f secrets/bot.env.enc ]; then
    read -rsp "Passphrase de respaldo: " PP; echo
    printf '%s' "$PP" > /tmp/.pp.tmp
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/tmp/.pp.tmp -in secrets/bot.env.enc -out .env
    shred -u /tmp/.pp.tmp
    echo "✅ .env restaurado"
fi

if [ ! -f jarvis-os/.env ] && [ -f secrets/jarvis-os.env.enc ]; then
    if [ ! -f /tmp/.pp.tmp ]; then
        read -rsp "Passphrase de respaldo: " PP; echo
        printf '%s' "$PP" > /tmp/.pp.tmp
    fi
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/tmp/.pp.tmp -in secrets/jarvis-os.env.enc -out jarvis-os/.env
    [ -f /tmp/.pp.tmp ] && shred -u /tmp/.pp.tmp
    echo "✅ jarvis-os/.env restaurado"
fi

chmod 600 .env jarvis-os/.env 2>/dev/null || true
echo "Listo."
