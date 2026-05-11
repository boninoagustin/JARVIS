#!/bin/bash

echo "🔴 Deteniendo el servicio JARVIS de producción..."
sudo systemctl stop jarvis.service

echo "🟢 Iniciando JARVIS en Modo Desarrollo (Modo Visual para Backtesting)..."
echo "👉 Presiona Ctrl+C cuando termines de hacer backtest para volver al modo producción."
echo "----------------------------------------------------------------------"

# Ejecuta el modo dev
npm run dev

# Esta línea solo se ejecuta cuando cancelas (Ctrl+C) el comando anterior
echo "----------------------------------------------------------------------"
echo "🟡 Modo Desarrollo cerrado."
echo "🚀 Reiniciando el servicio JARVIS de producción..."
sudo systemctl start jarvis.service
echo "✅ JARVIS está operando en segundo plano nuevamente."
