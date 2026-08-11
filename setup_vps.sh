#!/bin/bash
# ============================================================
# JARVIS VPS Setup Script
# Ejecutar en un VPS Ubuntu 22.04/24.04 fresco como root:
#   chmod +x setup_vps.sh && ./setup_vps.sh
# ============================================================
set -e

echo "🚀 JARVIS VPS Setup"

# 1. Dependencias del sistema
apt update && apt install -y curl git build-essential python3 python3-pip

# 2. nvm + Node v24
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
nvm alias default 24

# 3. PM2 global
npm install -g pm2

# 4. Clonar repo
cd /opt
git clone https://github.com/boninoagustin/JARVIS.git
cd JARVIS

# 5. Instalar dependencias
npm install
cd jarvis-os && npm install && cd ..
cd kronos_api && pip3 install -r requirements.txt && cd ..

# 6. Crear .env (⚠️ EDITAR MANUALMENTE con las credenciales reales)
cat > .env << 'ENVEOF'
CTRADER_CLIENT_ID="30104_..."
CTRADER_CLIENT_SECRET="..."
CTRADER_ACCESS_TOKEN="..."
CTRADER_ACCOUNT_ID="47530447"
CTRADER_DEMO="true"
CTRADER_RISK_PERCENT="1"
CTRADER_MAX_POSITIONS="3"
FINNHUB_API_KEY="d7pt291r01qosaaprsr0d7pt291r01qosaaprsrg"
TELEGRAM_CHAT_ID="-100..."
TELEGRAM_BOT_TOKEN="..."
ENVEOF

echo ""
echo "⚠️  EDITÁ /opt/JARVIS/.env con tus credenciales reales ANTES de continuar"
echo "   nano /opt/JARVIS/.env"
echo ""
read -p "¿Ya editaste el .env? (s/N): " confirm
if [ "$confirm" != "s" ]; then
    echo "Editá el .env y luego ejecutá manualmente:"
    echo "  cd /opt/JARVIS && pm2 start src/index.ts --name JARVIS --interpreter npx --interpreter-args 'tsx'"
    echo "  cd /opt/JARVIS && pm2 start kronos_api/main.py --name KRONOS_API --interpreter python3"
    echo "  cd /opt/JARVIS/jarvis-os && pm2 start npm --name JARVIS_OS -- run dev"
    echo "  pm2 save && pm2 startup"
    exit 0
fi

# 7. Iniciar servicios con PM2
pm2 start src/index.ts --name JARVIS --interpreter npx --interpreter-args 'tsx'
pm2 start kronos_api/main.py --name KRONOS_API --interpreter python3
cd jarvis-os && pm2 start npm --name JARVIS_OS -- run dev && cd ..

# 8. Auto-arranque al boot
pm2 save
pm2 startup systemd -u root --hp /root

echo ""
echo "✅ JARVIS instalado en /opt/JARVIS"
echo ""
echo "Comandos útiles:"
echo "  pm2 list              # ver procesos"
echo "  pm2 logs JARVIS       # logs del bot"
echo "  pm2 restart JARVIS    # reiniciar"
echo "  pm2 logs JARVIS_OS    # logs del dashboard"
