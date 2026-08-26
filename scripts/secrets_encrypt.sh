#!/usr/bin/env bash
# Re-encripta los .env del bot y del dashboard con una passphrase dada interactivamente.
# Uso: bash scripts/secrets_encrypt.sh
set -euo pipefail
cd "$(dirname "$0")/.."

read -rsp "Passphrase de respaldo: " PP; echo
umask 077
printf '%s' "$PP" > /tmp/.pp.tmp
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:/tmp/.pp.tmp -in .env -out secrets/bot.env.enc
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:/tmp/.pp.tmp -in jarvis-os/.env -out secrets/jarvis-os.env.enc
shred -u /tmp/.pp.tmp
echo "✅ secrets/bot.env.enc y secrets/jarvis-os.env.enc regenerados."
