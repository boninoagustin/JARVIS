#!/bin/bash
echo "Fetching US500..."
npx tsx scripts/fetch_history.ts US500
echo "Optimizing US500..."
npx tsx scripts/smc_bruteforcer.ts US500

echo "Optimizing USOIL..."
# Assuming USOIL fetch is already running in background, we might want to wait for it.
# Actually I'll just run it again sequentially to be safe
npx tsx scripts/fetch_history.ts USOIL
npx tsx scripts/smc_bruteforcer.ts USOIL

echo "Done fetching and optimizing US500 and USOIL."
