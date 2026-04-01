# 🤖 JARVIS - Asistente Personal Inteligente

JARVIS es un sistema de asistencia personal diseñado para automatizar tareas, gestionar información y conectar diferentes servicios a través de comandos y agentes inteligentes.

## 🚀 Capacidades Principales

- **Gestión de Archivos Local y Remota**: Integración con Google Drive.
- **Automatización de Mensajería**: Interacción vía Telegram.
- **Multitasking de Agentes**: Soporte para el "Equipo Alejabot" (Orquestación multi-agente).
- **Google Workspace Ready**: Integración completa con Gmail, Docs, Sheets y Calendar mediante `gws`.

## 🛠️ Instalación y Configuración

1. Clona el repositorio.
2. Instala las dependencias:
   ```bash
   npm install
   ```
3. Configura tu archivo `.env` basándote en `.env.example`.
4. Para activar las funciones de Google Workspace, sigue la guía en [GWS_SETUP.md](./GWS_SETUP.md).

## 🧩 Habilidades (Skills)

El proyecto utiliza un sistema de habilidades modular. Puedes encontrar más detalles en los archivos de la carpeta `.agents/skills/`.

- **[Equipo Alejabot](SKILL.MD)**: Protocolo de coordinación para múltiples agentes trabajando en paralelo.

## 🤝 Contribuciones

Este proyecto fue creado para la comunidad de Alejavi por academIArtificial. ¡Siéntete libre de proponer mejoras!

---
*Jarvis: Always one step ahead.*
