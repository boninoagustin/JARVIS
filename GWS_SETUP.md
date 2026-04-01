# Configuración de Google Workspace CLI (`gws`) en JARVIS

Esta guía describe cómo integrar y autenticar la herramienta `gws` para que Jarvis tenga superpoderes sobre el ecosistema de Google (Drive, Gmail, Docs, etc.).

## 1. Requisitos Previos

- **Node.js**: Instalado en el sistema.
- **gcloud CLI**: Instalado para gestionar la autenticación inicial de GCP (Google Cloud Project).
- **Google Cloud Project**: Un proyecto activo con las APIs de Google Workspace habilitadas.

## 2. Instalación de la Herramienta

Instalamos la CLI oficial de Google Workspace de forma global:

```bash
npm install -g @googleworkspace/cli
```

## 3. Autenticación (OAuth2)

Para que la CLI funcione, necesita un archivo `client_secret.json` descargado desde la consola de Google Cloud (GCP).

### Pasos:
1. Crea un **ID de cliente de OAuth** en la sección de Credenciales de GCP (Tipo: Aplicación de Escritorio).
2. Descarga el JSON y guárdalo en la raíz de este proyecto como `client_secret.json`.
3. Configura `gws` para usar este archivo:

```bash
# Copiar el secreto a la ruta de configuración de la CLI
mkdir -p ~/.config/gws
cp client_secret.json ~/.config/gws/client_secret.json

# Iniciar sesión (se abrirá una ventana de navegador)
gws auth login
```

> [!WARNING]
> Nunca subas el archivo `client_secret.json` al repositorio. Está incluido en el `.gitignore` por defecto.

## 4. Comandos Útiles

Una vez autenticado, puedes usar comandos como estos desde la terminal:

- **Listar archivos de Drive:** `gws drive files list --params '{"pageSize": 10}'`
- **Ver mensajes de Gmail:** `gws gmail messages list`
- **Consultar calendario:** `gws calendar events list`

> [!TIP]
> Todos los comandos pueden devolver una respuesta en formato JSON estructurado, lo que los hace ideales para ser procesados por los agentes de Jarvis.

---
*Configurado por Antigravity para el entorno de Jarvis.*
